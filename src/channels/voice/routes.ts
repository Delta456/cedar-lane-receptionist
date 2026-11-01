// Phase 2: phone calls through Vapi (see vapi.ts for how the two fit).
//   POST /vapi/<secret>/v1/chat/completions -> one turn of a call, streamed
//   POST /vapi/<secret>/events              -> Vapi's call events; logs a call when it's over
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../lib/logger.ts';
import { SerialQueue } from '../../lib/serial-queue.ts';
import { HttpError, type Route, readJson, sendJson } from '../../server/http.ts';
import type { CreateConversation, Sessions } from '../../server/sessions.ts';
import {
  CLOSING,
  completion,
  endedCallId,
  FILLER,
  needsFiller,
  newCallerText,
  parseVapiRequest,
  STREAM_END,
  spokenReply,
  streamChunk,
} from './vapi.ts';

export type VoiceRoutesDeps = {
  sessions: Sessions;
  createConversation: CreateConversation;
  // Part of both URLs, so only Vapi (which has it) can reach them.
  secret: string;
  logger: Logger;
};

// Vapi requests carry the whole call (history, call details, at the end the
// transcript), so they get more room than chat requests.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TURN_PATH = /^\/vapi\/([^/]+)(?:\/v1)?\/chat\/completions$/;
const EVENTS_PATH = /^\/vapi\/([^/]+)\/events$/;
// Said when Vapi asks for a turn before the caller has said anything.
const OPENING = 'How can I help you today?';

// Per call: the caller messages already answered (Vapi sends them all every
// time), the last reply (for a repeated request), and a queue, so two
// requests for one call are handled one after the other.
type CallState = { answered: string[]; lastReply: string; queue: SerialQueue };

export function createVoiceRoutes({ sessions, createConversation, secret, logger }: VoiceRoutesDeps): Route {
  const calls = new Map<string, CallState>();
  // Calls that are over. A late request for one gets the closing line rather
  // than starting the call again.
  const finished = new Set<string>();
  sessions.onEnded((sessionId) => {
    if (calls.delete(sessionId)) {
      finished.add(sessionId);
    }
  });

  return async (req, res, path) => {
    if (req.method !== 'POST') {
      return false;
    }
    const turnPath = TURN_PATH.exec(path);
    if (turnPath && isSecret(turnPath[1])) {
      await turn(req, res);
      return true;
    }
    const eventsPath = EVENTS_PATH.exec(path);
    if (eventsPath && isSecret(eventsPath[1])) {
      const callId = endedCallId(await readJson(req, MAX_BODY_BYTES));
      if (callId) {
        sessions.endInBackground(`vapi:${callId}`);
      }
      sendJson(res, 200, {});
      return true;
    }
    return false;
  };

  function isSecret(given: string | undefined): boolean {
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // One turn of a call. The answer streams as it's ready: the filler as soon
  // as the agent starts on tools, then the reply.
  async function turn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, MAX_BODY_BYTES);
    const request = parseVapiRequest(body);
    if (!request) {
      // Vapi doesn't document its request body; the field names (never the
      // values) show what it sent instead.
      logger.warn('vapi_request_without_call_id', { fields: Object.keys(body) });
      throw new HttpError(400, 'call.id is required');
    }
    const sessionId = `vapi:${request.callId}`;
    const id = `chatcmpl-${randomUUID()}`;
    if (request.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
    }
    const say = (text: string) => {
      if (request.stream && !res.destroyed) {
        res.write(streamChunk(id, text));
      }
    };

    let spoken: string;
    let ended = false;
    try {
      ({ spoken, ended } = await answer(sessionId, request.callerPhone, request.userMessages, say));
    } catch (err) {
      // Headers may already be sent, so the caller gets an apology instead
      // of an error status.
      logger.error('vapi_turn_failed', { err });
      spoken = "Sorry, I'm having trouble with our system. Could you say that again?";
    }
    if (request.stream) {
      if (!res.destroyed) {
        res.write(streamChunk(id, spoken));
        res.write(streamChunk(id, null));
      }
      res.end(STREAM_END);
    } else {
      sendJson(res, 200, completion(id, spoken));
    }
    logger.info('vapi_turn', { callerId: request.callerPhone !== null, ended });
    if (ended) {
      sessions.endInBackground(sessionId);
    }
  }

  async function answer(
    sessionId: string,
    callerPhone: string | null,
    userMessages: string[],
    say: (text: string) => void,
  ): Promise<{ spoken: string; ended: boolean }> {
    if (finished.has(sessionId)) {
      return { spoken: CLOSING, ended: false };
    }
    const conversation = sessions.getOrStart(sessionId, () => createConversation({ channel: 'voice', callerPhone }));
    let state = calls.get(sessionId);
    if (!state) {
      state = { answered: [], lastReply: OPENING, queue: new SerialQueue() };
      calls.set(sessionId, state);
    }
    const call = state;
    return call.queue.run(async () => {
      const text = newCallerText(userMessages, call.answered);
      if (text === null) {
        return { spoken: call.lastReply, ended: false };
      }
      call.answered = [...userMessages];
      const turn = await conversation.send(text, {
        onToolStart: (names) => {
          if (needsFiller(names)) say(`${FILLER} `);
        },
      });
      const ended = turn.ended === true;
      call.lastReply = spokenReply(turn.reply, ended);
      return { spoken: call.lastReply, ended };
    });
  }
}

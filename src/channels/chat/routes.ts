// Phase 1: the text chat. Each browser tab is one "call".
//   GET  /           the chat page
//   POST /api/chat   { sessionId, message } -> { reply, toolCalls, ended }
//   POST /api/end    { sessionId }          -> ends the call so it gets logged
//   POST /api/hangup { sessionId }          -> the same, sent when the tab closes
import { readFile } from 'node:fs/promises';
import type { Logger } from '../../lib/logger.ts';
import { type Route, readJson, requireString, sendJson } from '../../server/http.ts';
import type { CreateConversation, Sessions } from '../../server/sessions.ts';

export type ChatRoutesDeps = {
  sessions: Sessions;
  createConversation: CreateConversation;
  pagePath: string;
  logger: Logger;
};

export function createChatRoutes({ sessions, createConversation, pagePath, logger }: ChatRoutesDeps): Route {
  return async (req, res, path) => {
    if (req.method === 'GET' && path === '/') {
      const html = await readFile(pagePath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      return true;
    }

    if (req.method === 'POST' && path === '/api/chat') {
      const body = await readJson(req);
      const sessionId = requireString(body, 'sessionId');
      const message = requireString(body, 'message');
      const turn = await sessions.getOrStart(sessionId, () => createConversation()).send(message);
      if (!turn.ended) {
        sendJson(res, 200, turn);
        return true;
      }
      // The agent hung up after its goodbye: end and log the call now, as the
      // End call button would. If logging fails, the sweeper retries it, and
      // the caller still gets the goodbye.
      const end = await sessions.end(sessionId).catch((err: unknown) => {
        logger.error('end_call_failed', { err });
        return null;
      });
      sendJson(res, 200, { ...turn, toolCalls: [...turn.toolCalls, ...(end?.toolCalls ?? [])] });
      return true;
    }

    if (req.method === 'POST' && path === '/api/end') {
      sendJson(res, 200, await sessions.end(requireString(await readJson(req), 'sessionId')));
      return true;
    }

    // Sent by the page when its tab closes, so the call still gets logged.
    // The browser doesn't wait for an answer, so the call ends in the background.
    if (req.method === 'POST' && path === '/api/hangup') {
      sessions.endInBackground(requireString(await readJson(req), 'sessionId'));
      res.writeHead(204).end();
      return true;
    }

    return false;
  };
}

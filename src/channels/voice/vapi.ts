// Phase 2: the same agent on a phone call, through Vapi. Vapi handles the
// phone line, speech-to-text and text-to-speech, and calls this server as a
// "custom LLM": an OpenAI-compatible chat completions endpoint that streams
// its answer. These helpers turn Vapi's requests into Conversation turns and
// the turns back into the stream Vapi expects. The routes are in routes.ts.
//
// Vapi sends the whole conversation on every request, but each call already
// has a Conversation here with its own history (tool calls, guards and all),
// so only the caller's new words are passed on.

import { normalizePhone } from '../../domain/phone.ts';

// Said while tools run, so the caller isn't left in silence for the 2–3
// model round trips a tool turn takes. Spoken only, never added to the
// history: the reply that follows is what the agent actually said.
export const FILLER = 'One moment, let me check.';

// When the agent hangs up, it says this, and the assistant's endCallPhrases
// (see assistant.ts) make Vapi end the call once it's spoken.
// Vapi doesn't document how a custom LLM ends a call directly, so the phrase
// is the hang-up signal, and no other reply may contain it.
export const CLOSING = 'Thanks for calling Cedar Lane. Goodbye!';
export const END_CALL_PHRASE = 'thanks for calling cedar lane';

export type VapiRequest = {
  callId: string;
  // The caller's number from the phone system, as E.164; null on web calls
  // and when caller ID is withheld or isn't a usable number.
  callerPhone: string | null;
  // Everything the caller has said, one entry per caller message.
  userMessages: string[];
  stream: boolean;
};

// Reads the parts of Vapi's request we use. Returns null without a call id,
// since a turn can't be matched to its call without one.
export function parseVapiRequest(body: Record<string, unknown>): VapiRequest | null {
  const call = asRecord(body.call);
  const callId = typeof call?.id === 'string' ? call.id : null;
  if (!callId) {
    return null;
  }
  // Caller ID becomes the caller's identity, so only a real number counts.
  // Anything else ("anonymous", a withheld ID) would make every booking tool
  // fail; without it, the agent asks for a name and number as in the chat.
  const number = asRecord(call?.customer)?.number;
  const callerPhone = typeof number === 'string' ? normalizePhone(number) : null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessages = messages
    .map(asRecord)
    .filter((m) => m?.role === 'user')
    .map((m) => contentText(m?.content))
    .filter((text) => text.length > 0);
  return {
    callId,
    callerPhone,
    userMessages,
    // OpenAI's default is not to stream, but Vapi streams; only an explicit
    // false gets a plain JSON answer.
    stream: body.stream !== false,
  };
}

// What the caller said that this call hasn't answered yet, given the caller
// messages already answered. Usually one message; several are joined into
// one turn; none means Vapi asked again for a turn already answered.
//
// Vapi keeps transcribing while it waits for a reply, and if the caller
// carries on (a phone number said in pieces), it can extend its last message
// instead of adding one. On the first real call, comparing only the number of
// messages dropped the rest of a phone number and logged it as "+41". So a
// last message that has grown is sent again, whole.
export function newCallerText(userMessages: string[], answered: string[]): string | null {
  const last = answered.length - 1;
  const current = userMessages[last];
  const previous = answered[last];
  const lastChanged = current !== undefined && previous !== undefined && comparable(current) !== comparable(previous);
  const unanswered = userMessages.slice(lastChanged ? last : answered.length);
  return unanswered.length > 0 ? unanswered.join(' ') : null;
}

// Ignores changes a transcript makes that don't change the words, like
// punctuation and capitals.
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// What the caller hears for a turn. A hang-up always ends with the closing
// phrase, which is the signal for Vapi to end the call; any other reply has
// the phrase taken out, so it can't end the call by accident.
export function spokenReply(reply: string, ended: boolean): string {
  if (ended) {
    return CLOSING;
  }
  return reply.replace(/thanks for calling cedar lane/gi, 'Thanks');
}

// A filler only helps when the caller would otherwise wait on real work:
// hanging up needs no "let me check".
export function needsFiller(toolNames: string[]): boolean {
  return toolNames.some((name) => name !== 'end_call');
}

// One server-sent event in OpenAI's streaming format.
export function streamChunk(id: string, content: string | null): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'cedar-lane-receptionist',
    choices: [
      content === null
        ? { index: 0, delta: {}, finish_reason: 'stop' }
        : { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const STREAM_END = 'data: [DONE]\n\n';

// The same answer as one JSON response, for a request with stream: false.
export function completion(id: string, content: string): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'cedar-lane-receptionist',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

// The call id of a server message that means the call is over, or null.
// Vapi sends these to the assistant's server URL.
export function endedCallId(body: Record<string, unknown>): string | null {
  const message = asRecord(body.message);
  const over =
    message?.type === 'end-of-call-report' || (message?.type === 'status-update' && message.status === 'ended');
  const id = asRecord(message?.call)?.id;
  return over && typeof id === 'string' ? id : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Message content is a string, or a list of parts in OpenAI's format.
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = asRecord(part)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

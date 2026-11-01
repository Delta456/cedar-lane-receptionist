// One phone call or chat with the receptionist. Owns the message history and
// runs the tool loop: send the conversation to the model, run any tools it
// asks for, send the results back, and repeat until it replies to the caller.
// When the call ends, it writes the call log entry.
//
// Uses the OpenAI chat completions format, which NVIDIA's API, local servers
// like Ollama, and Vapi's custom LLM option all speak.

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type OpenAI from 'openai';
import { speakTimes } from '../domain/spoken-time.ts';
import { createLogger, type Logger } from '../lib/logger.ts';
import { SerialQueue } from '../lib/serial-queue.ts';
import type { CallLog } from '../services/call-log-service.ts';
import { type CallSummary, summarizeCall } from './call-summary.ts';
import { checkBookingClaim, claimsLateNote, saysUnavailable } from './claim-check.ts';
import { buildSystemPrompt, type Channel } from './prompt.ts';
import { createTextToolCallDetector } from './text-tool-calls.ts';
import { type CallState, findTool, newCallState, type Services, type Tool, tools } from './tools.ts';

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type ToolCall = { name: string; input: unknown; result: unknown };
// ended: the agent hung up (end_call) and this reply was its goodbye, so the
// call should now be ended and logged.
export type Turn = { reply: string; toolCalls: ToolCall[]; ended?: boolean | undefined };

export type TurnHooks = {
  // Called once per turn, just before the first tools run, with their names.
  // The voice server uses it to say "let me check" while the tools work.
  onToolStart?: ((toolNames: string[]) => void) | undefined;
};

export type ConversationDeps = {
  llm: OpenAI;
  model: string;
  services: Services;
  // A chat or a phone call; decides which prompt sections apply. Chat if left out.
  channel?: Channel | undefined;
  // The caller's number from the phone system, when there is one (voice).
  callerPhone?: string | null;
  now?: () => DateTime;
  logger?: Logger;
};

// A turn needs at most a few tool calls; this only stops a runaway loop.
const MAX_STEPS = 10;
// Attempts per model response before giving up with the TROUBLE reply.
const MAX_ATTEMPTS = 3;
// The sampling NVIDIA recommends for this model.
const SAMPLING = { temperature: 1.0, top_p: 0.95 };
const TROUBLE = "Sorry, I'm having trouble with our system. Can I take your number and have someone call you back?";
const NO_REPLY = 'Sorry, could you say that again?';
// If the model hangs up but gives no usable goodbye.
const GOODBYE = 'Thanks for calling Cedar Lane. Goodbye!';
// Tool results are cut to this length in the transcript the summary reads.
const TRANSCRIPT_RESULT_CHARS = 400;

const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(toToolDefinition);
const textToolCalls = createTextToolCallDetector(tools.map((t) => t.name));

// A call-log outcome saying a booking was made, moved or cancelled.
const CLAIMS_CHANGE_IN_LOG = /\b(booked|rescheduled|moved|cancell?ed)\b/i;
const BOOKING_CHANGES = new Set(['book_appointment', 'reschedule_appointment', 'cancel_appointment']);
// Sent when a reply claims a change no tool made. In brackets, like a note
// from the system, and kept out of the transcript.
// Sent when a reply says the caller is (or will be) noted as running late,
// and mark_running_late hasn't succeeded in this call.
const UNBACKED_LATE_NOTE =
  "[Check: you told the caller you've noted, or will note, that they're running late, but mark_running_late hasn't succeeded. Call it now with their phone number, name and how late they'll be, then tell them what it says.]";
// Sent when a check this turn found the caller's time unavailable and the
// reply doesn't say so. The tool result's tellCaller is added after it.
const UNTOLD_UNAVAILABLE = "[Check: your reply didn't tell the caller that the time they asked for isn't available.";
const UNBACKED_CLAIM =
  "[Check: you just told the caller a booking was made, moved or cancelled, but no booking tool succeeded in this turn. If the caller confirmed the change, call the tool now. If not, don't claim it; ask them to confirm.";

export class Conversation {
  // Ties together every log line for this call.
  readonly id = randomUUID();
  private readonly deps: ConversationDeps;
  private readonly log: Logger;
  private readonly messages: Message[];
  private readonly call: CallState;
  // A readable record of the call, for the call log summary.
  private readonly transcript: string[] = [];
  private logged = false;
  // Turns run one at a time. Two overlapping turns would interleave their
  // messages, and the API rejects a tool call that isn't followed by its result.
  private readonly turns = new SerialQueue();
  private lastActiveAt = Date.now();
  private recoveredCalls = 0;
  // Confirmations of booking changes made earlier in the call, so a reply
  // that only repeats one can be told apart from a new, false claim.
  private readonly changesMade: string[] = [];
  // Whether mark_running_late has succeeded in this call, so a reply saying
  // the caller is noted as late is true.
  private lateNoted = false;

  constructor(deps: ConversationDeps) {
    this.deps = deps;
    this.log = (deps.logger ?? createLogger()).child({ callId: this.id });
    this.call = newCallState(deps.callerPhone ?? null);
    // The prompt is fixed when the call starts, so "today" doesn't shift mid-call.
    const now = deps.now ? deps.now() : DateTime.now();
    const prompt = buildSystemPrompt(now, undefined, { channel: deps.channel, callerPhone: deps.callerPhone });
    this.messages = [{ role: 'system', content: prompt }];
  }

  get lastActive(): number {
    return this.lastActiveAt;
  }

  send(userText: string, hooks: TurnHooks = {}): Promise<Turn> {
    this.lastActiveAt = Date.now();
    return this.turns.run(() => this.runTurn(userText, hooks));
  }

  // The caller has hung up: summarise the call and log it, exactly once. If
  // the summary fails, the call is still logged from what the code saw, and
  // flagged for a human. Returns the log entry as a tool call, so the chat
  // page can show it.
  end(): Promise<Turn> {
    return this.turns.run(async () => {
      if (this.logged || this.transcript.length === 0) {
        return { reply: '', toolCalls: [] };
      }
      let summary: CallSummary | null = null;
      try {
        summary = await summarizeCall(this.deps.llm, this.deps.model, this.summaryInput());
      } catch (err) {
        this.log.warn('summary_failed', { err });
      }
      const log = this.callLog(summary);
      const contactSaved = await this.call.contactSaved;
      const result = await this.deps.services.callLog.logCall(log, { contactSaved });
      this.logged = true;
      this.log.info('call_logged', {
        intent: log.intent,
        needsHuman: log.needsHuman,
        summarised: summary !== null,
        booking: log.eventId !== undefined,
        turns: this.transcript.filter((line) => line.startsWith('Caller:')).length,
      });
      return { reply: '', toolCalls: [{ name: 'log_call', input: log, result }] };
    });
  }

  // The log entry. What the code saw (caller ID, the booking made) is a fact
  // and wins over the summary; the summary fills in the rest.
  private callLog(summary: CallSummary | null): CallLog {
    const facts = {
      // call.phone is caller ID or the number a booking tool used, so it beats
      // the summary's reading of the transcript. Otherwise a misread number
      // would log the call, and count it, against a second contact.
      phone: this.call.phone ?? summary?.phone ?? undefined,
      name: summary?.name ?? this.call.name ?? undefined,
      eventId: this.call.lastEventId ?? undefined,
    };
    if (summary) {
      // The summary model can infer a booking from talk about one ("is 9
      // open?"). Only a booking tool makes a booking, so with none, the
      // outcome can't claim one.
      const outcome =
        facts.eventId === undefined && CLAIMS_CHANGE_IN_LOG.test(summary.outcome)
          ? 'No booking was made or changed.'
          : summary.outcome;
      // A callback the code recorded means a human must follow up, whatever
      // the summary decided.
      const needsHuman = summary.needsHuman || this.call.callback !== null;
      return { ...facts, ...pick(summary, 'intent', 'summary'), needsHuman, outcome: this.withCallback(outcome) };
    }
    const first = this.transcript.find((line) => line.startsWith('Caller:')) ?? '';
    return {
      ...facts,
      intent: 'other',
      summary: `No summary could be made. The call began: ${truncate(first, 200)}`,
      outcome: this.withCallback(
        this.call.lastEventId ? 'A booking was created or changed during the call.' : 'Unknown.',
      ),
      needsHuman: true,
    };
  }

  // Adds the callback the agent requested, so staff see what to call back
  // about, from the tool call rather than the summary's reading of it.
  private withCallback(outcome: string): string {
    const callback = this.call.callback;
    return callback ? `${outcome} Callback requested: ${callback.reason.replace(/[.\s]+$/, '')}.` : outcome;
  }

  private async runTurn(userText: string, hooks: TurnHooks): Promise<Turn> {
    const started = performance.now();
    // Shared with playTurn, so a failure can see what the tools already did.
    const toolCalls: ToolCall[] = [];
    this.call.changedThisTurn = false;
    this.call.endRequested = false;
    this.call.callerMessage = userText;
    let turn: Turn;
    let failed = false;
    try {
      turn = await this.playTurn(userText, toolCalls, hooks);
    } catch (err) {
      failed = true;
      turn = this.recoverFromFailure(err, toolCalls);
    }
    // Never hang up on an error reply: it offers the caller a callback. Nor
    // after a booking change this turn: end_call refuses one made before it,
    // and this catches one made after it in the same response.
    const ended = this.call.endRequested && !this.call.changedThisTurn && !failed && turn.reply !== TROUBLE;
    this.log.info('turn', {
      latencyMs: Math.round(performance.now() - started),
      tools: turn.toolCalls.map((c) => c.name),
      fallback: turn.reply === TROUBLE,
      ended,
    });
    return { ...turn, ended };
  }

  // The transcript, plus what the booking tools actually did, so the summary
  // can't mistake talk about a booking for a booking.
  private summaryInput(): string {
    const facts = this.call.lastEventId
      ? 'A booking was created, moved or cancelled during this call (see the tool results above).'
      : 'No booking was created, moved or cancelled during this call.';
    return `${this.transcript.join('\n')}\n\nFrom the booking system: ${facts}`;
  }

  // The model failed mid-turn (after retries). Never leave the caller with an
  // error when something already happened: confirm it from the tool results,
  // which are facts. The reply also goes into the history, so the next turn
  // starts from a valid conversation that knows what was said.
  private recoverFromFailure(err: unknown, toolCalls: ToolCall[]): Turn {
    this.log.error('turn_failed', { err, tools: toolCalls.map((c) => c.name) });
    const done = confirmations(toolCalls);
    const text =
      done.length > 0
        ? `${done.join(' ')} I'm having some trouble with our system, so for anything else, someone from the shop can call you back.`
        : TROUBLE;
    this.messages.push({ role: 'assistant', content: text });
    return this.reply(text, toolCalls);
  }

  private async playTurn(userText: string, toolCalls: ToolCall[], hooks: TurnHooks): Promise<Turn> {
    this.messages.push({ role: 'user', content: userText });
    this.transcript.push(`Caller: ${userText}`);

    let corrected = false;
    let lateCorrected = false;
    let unavailableCorrected = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      const message = await this.complete();
      if (!message) {
        // Once the agent has hung up, a goodbye is all that's left to say.
        return this.reply(this.call.endRequested ? GOODBYE : TROUBLE, toolCalls);
      }

      const calls = (message.tool_calls ?? []).filter((c) => c.type === 'function');
      // Send back only what the model said. Reasoning traces stay out of the
      // history, as reasoning models expect.
      // The history gets the reply as the caller sees it, so the model keeps
      // to the spoken times from then on.
      this.messages.push(
        calls.length > 0
          ? { role: 'assistant', content: message.content ?? null, tool_calls: calls }
          : { role: 'assistant', content: speakTimes(message.content ?? '') },
      );
      if (calls.length === 0) {
        const text = speakTimes(message.content?.trim() || (this.call.endRequested ? GOODBYE : NO_REPLY));
        // A reply that claims a booking change no tool made would send the
        // caller away believing something false. Ask the model once to act
        // on it or take it back. The cheap check runs first, so the claim
        // check only costs a request when it could matter.
        if (!corrected && !this.backsBookingClaim(toolCalls) && (await this.claimsBookingChange(text))) {
          corrected = true;
          const earlier = this.changesMade.length
            ? ` Done earlier in this call: ${this.changesMade.join(' ')} If your reply only repeats one of these, say it again as it was.`
            : '';
          this.messages.push({ role: 'user', content: `${UNBACKED_CLAIM}${earlier}]` });
          continue;
        }
        // The same for saying the caller is noted as late: once per turn, and
        // only when no running-late note has been made in this call.
        if (!lateCorrected && !this.lateNoted && claimsLateNote(text)) {
          lateCorrected = true;
          this.log.warn('unbacked_late_note');
          this.messages.push({ role: 'user', content: UNBACKED_LATE_NOTE });
          continue;
        }
        // A caller who asked for a taken time must hear that it's taken.
        // The tool result says so (tellCaller), but the model sometimes
        // skipped it and asked for a name and number as if it were free.
        const untold = untoldUnavailable(toolCalls);
        if (!unavailableCorrected && untold && !saysUnavailable(text)) {
          unavailableCorrected = true;
          this.log.warn('untold_unavailable');
          this.messages.push({ role: 'user', content: `${UNTOLD_UNAVAILABLE} ${untold} Then reply to the caller.]` });
          continue;
        }
        return this.reply(text, toolCalls);
      }

      if (toolCalls.length === 0) {
        hooks.onToolStart?.(calls.map((c) => c.function.name));
      }
      // Every tool call gets a result message, matched by id.
      for (const call of calls) {
        const { name } = call.function;
        const input = parseArguments(call.function.arguments);
        const result = input === undefined ? invalidJson() : await this.runTool(name, input);
        toolCalls.push({ name, input, result });
        this.changesMade.push(...confirmations([{ name, input, result }]));
        if (name === 'mark_running_late' && (result as { ok?: unknown } | null)?.ok === true) {
          this.lateNoted = true;
        }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        this.transcript.push(
          `[${name} ${JSON.stringify(input)} -> ${truncate(JSON.stringify(result), TRANSCRIPT_RESULT_CHARS)}]`,
        );
      }
    }
    return this.reply(TROUBLE, toolCalls);
  }

  // A booking claim is backed if a booking change succeeded this turn, or the
  // turn looked up the caller's bookings ("yes, you're booked Thursday").
  // Changes from earlier turns don't count: otherwise, once anything was
  // booked, a false "moved you to Friday" later in the call would pass. A
  // reply that repeats an earlier change is checked, and the correction note
  // lists those changes so the model can simply say it again.
  private backsBookingClaim(toolCalls: ToolCall[]): boolean {
    return toolCalls.some(
      (c) =>
        c.name === 'find_bookings' ||
        (BOOKING_CHANGES.has(c.name) && (c.result as { ok?: unknown } | null)?.ok === true),
    );
  }

  private async claimsBookingChange(text: string): Promise<boolean> {
    const check = await checkBookingClaim(this.deps.llm, this.deps.model, text);
    if (check.via === 'model_failed') {
      this.log.warn('claim_check_failed');
    }
    if (check.claimsChange) {
      this.log.warn('unbacked_booking_claim', { via: check.via });
    }
    return check.claimsChange;
  }

  private reply(text: string, toolCalls: ToolCall[]): Turn {
    this.transcript.push(`Receptionist: ${text}`);
    return { reply: text, toolCalls };
  }

  // One usable model response. Small models occasionally return nothing, or
  // write a tool call into the reply text instead of making it. Neither must
  // reach the caller: the second would read out a function call, and could
  // claim a booking that never happened. A call in the model's template
  // syntax is turned back into the real call; anything else is discarded and
  // requested again, and sampling makes the retry differ.
  private async complete(): Promise<OpenAI.Chat.Completions.ChatCompletionMessage | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await this.deps.llm.chat.completions.create({
        model: this.deps.model,
        messages: this.messages,
        tools: toolDefinitions,
        ...SAMPLING,
      });
      const message = response.choices[0]?.message;
      if (message?.tool_calls?.length) {
        return message;
      }
      const text = message?.content?.trim() ?? '';
      const recovered = textToolCalls.parse(text);
      if (message && recovered) {
        this.log.warn('tool_call_recovered_from_text', { tool: recovered.name });
        return {
          ...message,
          content: null,
          tool_calls: [
            {
              id: `text-call-${++this.recoveredCalls}`,
              type: 'function',
              function: { name: recovered.name, arguments: JSON.stringify(recovered.args) },
            },
          ],
        };
      }
      if (text && !textToolCalls.detect(text)) {
        return message;
      }
      this.log.warn('model_response_discarded', { reason: text ? 'tool_call_as_text' : 'empty', attempt });
    }
    return undefined;
  }

  // Tool failures go back to the model as results, so it can tell the caller
  // and recover, instead of failing the whole turn.
  private async runTool(name: string, input: unknown): Promise<unknown> {
    const tool = findTool(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}` };
    }
    const started = performance.now();
    try {
      const result = await tool.execute(input, { services: this.deps.services, call: this.call });
      const { ok, reason } = (result ?? {}) as { ok?: unknown; reason?: unknown };
      this.log.debug('tool', { tool: name, ok, reason, latencyMs: Math.round(performance.now() - started) });
      return result;
    } catch (err) {
      this.log.error('tool_failed', { tool: name, err });
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// What to tell the caller, if this turn's last availability check or booking
// change was a check that found the time unavailable. A later booking or a
// successful check means the caller has moved on.
function untoldUnavailable(toolCalls: ToolCall[]): string | null {
  const last = toolCalls.findLast((c) => c.name === 'check_availability' || BOOKING_CHANGES.has(c.name));
  const result =
    last?.name === 'check_availability' ? (last.result as { available?: unknown; tellCaller?: unknown }) : null;
  return result?.available === false && typeof result.tellCaller === 'string' ? result.tellCaller : null;
}

// What the caller must be told about booking actions that succeeded.
function confirmations(toolCalls: ToolCall[]): string[] {
  return toolCalls.flatMap((call) => {
    const result = call.result as { ok?: unknown; booking?: { service: string; when: string } } | null;
    if (result?.ok !== true || !result.booking) {
      return [];
    }
    const { service, when } = result.booking;
    switch (call.name) {
      case 'book_appointment':
        return [`You're booked for ${service.toLowerCase()} on ${when}.`];
      case 'reschedule_appointment':
        return [`Your ${service.toLowerCase()} is moved to ${when}.`];
      case 'cancel_appointment':
        return [`Your ${service.toLowerCase()} on ${when} is cancelled.`];
      case 'mark_running_late':
        return ["I've let the shop know you're running late."];
      default:
        return [];
    }
  });
}

function toToolDefinition(tool: Tool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

// Tool arguments arrive as a JSON string; undefined means it didn't parse.
function parseArguments(json: string): unknown {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return undefined;
  }
}

function pick<T, K extends keyof T>(value: T, ...keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function invalidJson() {
  return { ok: false, reason: 'invalid_input', issues: ['arguments were not valid JSON'] };
}

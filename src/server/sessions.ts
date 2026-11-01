// The calls in progress, from every channel (chat tabs and phone calls), and
// how they end. Every call is logged, including ones the caller just walked
// away from: a call is ended, not just forgotten, when it's dropped.
import type { Conversation, Turn } from '../agent/conversation.ts';
import type { Channel } from '../agent/prompt.ts';
import type { Logger } from '../lib/logger.ts';

// Starts a call's conversation, for a channel (chat if left out). callerPhone:
// the caller's number from the phone system (voice calls).
export type CreateConversation = (options?: {
  channel?: Channel | undefined;
  callerPhone?: string | null | undefined;
}) => Conversation;

// A call left without a word for this long is ended (and logged).
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type SessionsDeps = {
  logger: Logger;
  // How often to end idle calls and retry failed ends. Tests shorten it.
  sweepIntervalMs?: number | undefined;
};

export class Sessions {
  private readonly log: Logger;
  private readonly conversations = new Map<string, Conversation>();
  // Calls whose end failed (e.g. the Sheet was down). They stay open and the
  // sweeper retries them, so a failure doesn't lose the call.
  private readonly endFailed = new Set<string>();
  private readonly endedListeners: ((sessionId: string) => void)[] = [];

  constructor({ logger, sweepIntervalMs = 60_000 }: SessionsDeps) {
    this.log = logger;
    const sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    // The sweeper alone shouldn't keep the process running.
    sweeper.unref();
  }

  get(sessionId: string): Conversation | undefined {
    return this.conversations.get(sessionId);
  }

  // The session's conversation, started with `create` if there isn't one.
  getOrStart(sessionId: string, create: () => Conversation): Conversation {
    let conversation = this.conversations.get(sessionId);
    if (!conversation) {
      conversation = create();
      this.conversations.set(sessionId, conversation);
    }
    return conversation;
  }

  // Told the id of each call once it's logged and forgotten.
  onEnded(listener: (sessionId: string) => void): void {
    this.endedListeners.push(listener);
  }

  // Ends and logs the call. It's only forgotten once it's logged, and end()
  // logs at most once, so a retry, or two ends at the same time, can't log a
  // call twice.
  async end(sessionId: string): Promise<Turn> {
    const conversation = this.conversations.get(sessionId);
    if (!conversation) {
      return { reply: '', toolCalls: [] };
    }
    try {
      const turn = await conversation.end();
      this.conversations.delete(sessionId);
      this.endFailed.delete(sessionId);
      for (const listener of this.endedListeners) {
        listener(sessionId);
      }
      return turn;
    } catch (err) {
      this.endFailed.add(sessionId);
      throw err;
    }
  }

  endInBackground(sessionId: string): void {
    this.end(sessionId).catch((err: unknown) => this.log.error('end_call_failed', { err }));
  }

  // Ends (and so logs) every call still open, e.g. before shutting down.
  async endAll(): Promise<void> {
    await Promise.allSettled([...this.conversations.keys()].map((id) => this.end(id)));
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [id, conversation] of this.conversations) {
      if (this.endFailed.has(id) || conversation.lastActive < cutoff) {
        this.endInBackground(id);
      }
    }
  }
}

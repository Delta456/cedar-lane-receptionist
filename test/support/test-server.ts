// A real HTTP server on a free port, with stub conversations that record what
// the server asks of them. Start one per test and close it afterwards.
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, Turn, TurnHooks } from '../../src/agent/conversation.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { createHttpServer } from '../../src/server/http-server.ts';

export const SECRET = 'test-secret-1234567890';

// Scripted by what it's sent: "boom" throws, "what is open" uses a tool,
// "bye" hangs up, anything else is echoed.
export class StubConversation {
  channel: string | undefined;
  callerPhone: string | null = null;
  sent: string[] = [];
  ended = 0;
  // How many end() calls fail before one succeeds, like a Sheet outage.
  failEnds = 0;
  lastActive = Date.now();

  async send(text: string, hooks: TurnHooks = {}): Promise<Turn> {
    this.sent.push(text);
    if (text === 'boom') throw new Error('secret internal detail');
    if (text === 'what is open') {
      hooks.onToolStart?.(['find_open_times']);
      return { reply: 'We have 9 AM.', toolCalls: [] };
    }
    if (text === 'bye') return { reply: 'Goodbye!', toolCalls: [], ended: true };
    return { reply: `echo: ${text}`, toolCalls: [] };
  }

  async end(): Promise<Turn> {
    this.ended++;
    if (this.failEnds > 0) {
      this.failEnds--;
      throw new Error('sheet unavailable');
    }
    return { reply: '', toolCalls: [{ name: 'log_call', input: {}, result: {} }] };
  }
}

export type TestServer = {
  base: string;
  // Every conversation the server started, in order.
  created: StubConversation[];
  // Every log line the server wrote.
  logs: string[];
  post(path: string, body: unknown): Promise<Response>;
  endOpenCalls(): Promise<void>;
  close(): Promise<void>;
};

export async function startTestServer(): Promise<TestServer> {
  const pagePath = join(tmpdir(), `cedar-lane-test-${process.pid}.html`);
  await writeFile(pagePath, '<!doctype html><title>chat</title>');
  const created: StubConversation[] = [];
  const logs: string[] = [];
  const http = createHttpServer({
    createConversation: (options) => {
      const conversation = new StubConversation();
      conversation.channel = options?.channel;
      conversation.callerPhone = options?.callerPhone ?? null;
      created.push(conversation);
      return conversation as unknown as Conversation;
    },
    pagePath,
    vapiSecret: SECRET,
    logger: createLogger({ level: () => 'debug', write: (line) => logs.push(line) }),
    sweepIntervalMs: 20,
  });
  await new Promise<void>((resolve) => http.server.listen(0, resolve));
  const base = `http://localhost:${(http.server.address() as AddressInfo).port}`;
  return {
    base,
    created,
    logs,
    post: (path, body) =>
      fetch(`${base}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
    endOpenCalls: () => http.endOpenCalls(),
    // Open keep-alive sockets would otherwise keep the test process running.
    async close() {
      http.server.closeAllConnections();
      await new Promise((resolve) => http.server.close(resolve));
    },
  };
}

// Waits for something that happens in the background, like a call being logged.
export async function eventually(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

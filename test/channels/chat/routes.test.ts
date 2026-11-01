import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Turn } from '../../../src/agent/conversation.ts';
import { eventually, startTestServer, type TestServer } from '../../support/test-server.ts';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => server.close());

test('serves the chat page, ignoring query strings', async () => {
  const res = await fetch(`${server.base}/?utm=x`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>chat<\/title>/);
});

test('one conversation per session, kept across messages', async () => {
  const first = await (await server.post('/api/chat', { sessionId: 'a', message: 'hi' })).json();
  await server.post('/api/chat', { sessionId: 'a', message: 'again' });
  await server.post('/api/chat', { sessionId: 'b', message: 'other' });
  assert.deepEqual(first, { reply: 'echo: hi', toolCalls: [] });
  assert.equal(server.created.length, 2);
  assert.deepEqual(server.created[0]?.sent, ['hi', 'again']);
  assert.equal(server.created[0]?.channel, undefined);
});

test('ending a call logs it once, and forgets the session', async () => {
  await server.post('/api/chat', { sessionId: 'a', message: 'hi' });
  const end = (await (await server.post('/api/end', { sessionId: 'a' })).json()) as Turn;
  assert.equal(end.toolCalls[0]?.name, 'log_call');
  assert.equal(server.created[0]?.ended, 1);

  // A second end for the same session does nothing.
  await server.post('/api/end', { sessionId: 'a' });
  assert.equal(server.created[0]?.ended, 1);
});

test('closing the tab ends the call in the background', async () => {
  await server.post('/api/chat', { sessionId: 'a', message: 'hi' });
  const res = await server.post('/api/hangup', { sessionId: 'a' });
  assert.equal(res.status, 204);
  await eventually(() => server.created[0]?.ended === 1);
  assert.equal(server.created[0]?.ended, 1);
});

test('when the agent hangs up, the call is logged and the session forgotten', async () => {
  await server.post('/api/chat', { sessionId: 'a', message: 'hi' });
  const turn = (await (await server.post('/api/chat', { sessionId: 'a', message: 'bye' })).json()) as Turn;
  assert.equal(turn.reply, 'Goodbye!');
  assert.equal(turn.ended, true);
  assert.equal(turn.toolCalls.at(-1)?.name, 'log_call');
  assert.equal(server.created[0]?.ended, 1);

  await server.post('/api/chat', { sessionId: 'a', message: 'new call' });
  assert.equal(server.created.length, 2);
});

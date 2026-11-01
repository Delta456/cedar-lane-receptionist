// What the server does for every channel: errors, ending calls on shutdown,
// and retrying calls whose logging failed. The chat routes are used to
// drive it.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { eventually, startTestServer, type TestServer } from '../support/test-server.ts';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => server.close());

test('bad requests get clear errors, and internal errors stay internal', async () => {
  assert.equal((await server.post('/api/chat', { sessionId: 'a' })).status, 400);
  assert.equal((await server.post('/api/chat', 'not json')).status, 400);
  assert.equal((await server.post('/api/chat', 'x'.repeat(70_000))).status, 413);
  assert.equal((await fetch(`${server.base}/nope`)).status, 404);

  const crash = await server.post('/api/chat', { sessionId: 'a', message: 'boom' });
  assert.equal(crash.status, 500);
  assert.doesNotMatch(await crash.text(), /secret internal detail/);
});

test('endOpenCalls ends every open call, e.g. on shutdown', async () => {
  await server.post('/api/chat', { sessionId: 'a', message: 'hi' });
  await server.post('/api/chat', { sessionId: 'b', message: 'hi' });
  await server.endOpenCalls();
  assert.deepEqual(
    server.created.map((c) => c.ended),
    [1, 1],
  );
});

test('if ending a call fails, the call is kept and retried until it is logged', async () => {
  await server.post('/api/chat', { sessionId: 'a', message: 'hi' });
  const stub = server.created[0];
  assert.ok(stub);
  stub.failEnds = 1;

  const failed = await server.post('/api/end', { sessionId: 'a' });
  assert.equal(failed.status, 500);

  // The sweeper retries it without waiting for the idle timeout.
  await eventually(() => stub.ended >= 2);
  assert.equal(stub.ended, 2);
  // Once logged, the session is forgotten: a new message starts a new call.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await server.post('/api/chat', { sessionId: 'a', message: 'new call' });
  assert.equal(server.created.length, 2);
});

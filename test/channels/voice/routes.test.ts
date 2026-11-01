import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { eventually, SECRET, startTestServer, type TestServer } from '../../support/test-server.ts';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => server.close());

// A Vapi request for one call, with everything the caller has said so far.
const vapiTurn = (said: string[], { secret = SECRET, number = '+14155550190' } = {}) =>
  server.post(`/vapi/${secret}/v1/chat/completions`, {
    model: 'cedar-lane-receptionist',
    stream: true,
    call: { id: 'call-1', customer: { number } },
    messages: said.flatMap((content) => [
      { role: 'user', content },
      { role: 'assistant', content: '...' },
    ]),
  });

// The text Vapi would speak, from a streamed answer.
async function spoken(res: Response): Promise<string> {
  const events = (await res.text()).split('\n\n').filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]');
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  return events.map((e) => JSON.parse(e.slice(6)).choices[0].delta.content ?? '').join('');
}

test("each turn passes only the caller's new words, with caller ID, and streams the reply", async () => {
  assert.equal(await spoken(await vapiTurn(['hi'])), 'echo: hi');
  assert.equal(await spoken(await vapiTurn(['hi', 'again'])), 'echo: again');
  assert.equal(server.created.length, 1);
  assert.deepEqual(server.created[0]?.sent, ['hi', 'again']);
  assert.equal(server.created[0]?.callerPhone, '+14155550190');
  assert.equal(server.created[0]?.channel, 'voice');
});

test('when Vapi extends the last message, the agent hears the whole of it', async () => {
  await vapiTurn(['my number is plus four one']);
  assert.equal(
    await spoken(await vapiTurn(['my number is plus four one five five five five oh one ninety'])),
    'echo: my number is plus four one five five five five oh one ninety',
  );
  assert.equal(server.created[0]?.sent.length, 2);
});

test('a tool turn says the filler first', async () => {
  assert.equal(await spoken(await vapiTurn(['what is open'])), 'One moment, let me check. We have 9 AM.');
});

test('a repeated request gets the same answer, without a new turn', async () => {
  await vapiTurn(['hi']);
  assert.equal(await spoken(await vapiTurn(['hi'])), 'echo: hi');
  assert.deepEqual(server.created[0]?.sent, ['hi']);
});

test('when the agent hangs up, it says the closing line and the call is logged', async () => {
  await vapiTurn(['hi']);
  assert.equal(await spoken(await vapiTurn(['hi', 'bye'])), 'Thanks for calling Cedar Lane. Goodbye!');
  await eventually(() => server.created[0]?.ended === 1);
  assert.equal(server.created[0]?.ended, 1);
  // A late request for the same call doesn't start it again.
  assert.equal(await spoken(await vapiTurn(['hi', 'bye', 'hello?'])), 'Thanks for calling Cedar Lane. Goodbye!');
  assert.equal(server.created.length, 1);
});

test('the end-of-call event logs a call the caller hung up on', async () => {
  await vapiTurn(['hi']);
  const res = await server.post(`/vapi/${SECRET}/events`, {
    message: { type: 'end-of-call-report', call: { id: 'call-1' } },
  });
  assert.equal(res.status, 200);
  await eventually(() => server.created[0]?.ended === 1);
  assert.equal(server.created[0]?.ended, 1);
});

test('the secret in the URL never reaches the logs', async () => {
  await vapiTurn(['hi']);
  await eventually(() => server.logs.some((line) => line.includes('"request"')));
  assert.ok(server.logs.length > 0);
  assert.ok(!server.logs.some((line) => line.includes(SECRET)));
});

test('without the right secret the voice routes do not exist', async () => {
  assert.equal((await vapiTurn(['hi'], { secret: 'wrong-secret-123456789' })).status, 404);
  const events = await server.post('/vapi/wrong-secret-123456789/events', { message: { type: 'end-of-call-report' } });
  assert.equal(events.status, 404);
  assert.equal(server.created.length, 0);
});

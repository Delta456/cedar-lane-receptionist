import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOSING,
  END_CALL_PHRASE,
  endedCallId,
  needsFiller,
  newCallerText,
  parseVapiRequest,
  spokenReply,
  streamChunk,
} from '../../../src/channels/voice/vapi.ts';

test('reads the call id, caller ID and what the caller said from a Vapi request', () => {
  const request = parseVapiRequest({
    model: 'cedar-lane-receptionist',
    stream: true,
    call: { id: 'call-1', customer: { number: '+14155550190' } },
    messages: [
      { role: 'system', content: 'ignored' },
      { role: 'assistant', content: 'Cedar Lane Auto Detailing, how can I help you?' },
      { role: 'user', content: ' Is Thursday at 3:30 open? ' },
      { role: 'assistant', content: 'That one is full.' },
      { role: 'user', content: [{ type: 'text', text: 'Sure, 4:30 works.' }] },
    ],
  });
  assert.deepEqual(request, {
    callId: 'call-1',
    callerPhone: '+14155550190',
    userMessages: ['Is Thursday at 3:30 open?', 'Sure, 4:30 works.'],
    stream: true,
  });
});

test('a web call has no caller ID, and a request without a call id is refused', () => {
  assert.equal(parseVapiRequest({ call: { id: 'web-1' }, messages: [] })?.callerPhone, null);
  // A withheld or unusable caller ID counts as none, so the caller can still book.
  assert.equal(parseVapiRequest({ call: { id: 'c', customer: { number: 'anonymous' } } })?.callerPhone, null);
  assert.equal(
    parseVapiRequest({ call: { id: 'c', customer: { number: '(415) 555-0190' } } })?.callerPhone,
    '+14155550190',
  );
  assert.equal(parseVapiRequest({ messages: [{ role: 'user', content: 'hi' }] }), null);
});

test('only what the caller said since the last answer is new', () => {
  assert.equal(newCallerText(['a', 'b'], ['a']), 'b');
  assert.equal(newCallerText(['a', 'b', 'c'], ['a']), 'b c');
  // Vapi asked again for a turn already answered.
  assert.equal(newCallerText(['a', 'b'], ['a', 'b']), null);
  // The same words with different punctuation aren't new.
  assert.equal(newCallerText(['Sara.'], ['sara']), null);
});

test('a last message Vapi extended is sent again whole, as on the first real call', () => {
  const answered = ["It's Sarah, my number is plus four one"];
  const extended = ["It's Sarah, my number is plus four one five five five five oh one ninety"];
  assert.equal(newCallerText(extended, answered), extended[0]);
});

test('a hang-up says the closing line, and no other reply can say the end-call phrase', () => {
  assert.equal(spokenReply('Bye Sara!', true), CLOSING);
  assert.ok(CLOSING.toLowerCase().includes(END_CALL_PHRASE));
  const reply = spokenReply('Thanks for calling Cedar Lane earlier! What can I do?', false);
  assert.ok(!reply.toLowerCase().includes(END_CALL_PHRASE), reply);
});

test('the filler is only for tools that do real work', () => {
  assert.equal(needsFiller(['check_availability']), true);
  assert.equal(needsFiller(['end_call']), false);
});

test("stream chunks are in OpenAI's format", () => {
  const text = streamChunk('id-1', 'Hello');
  assert.ok(text.startsWith('data: ') && text.endsWith('\n\n'));
  const chunk = JSON.parse(text.slice('data: '.length));
  assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(chunk.choices[0].delta.content, 'Hello');
  assert.equal(JSON.parse(streamChunk('id-1', null).slice(6)).choices[0].finish_reason, 'stop');
});

test('the end of a call is recognised from either Vapi event', () => {
  assert.equal(endedCallId({ message: { type: 'end-of-call-report', call: { id: 'c1' } } }), 'c1');
  assert.equal(endedCallId({ message: { type: 'status-update', status: 'ended', call: { id: 'c2' } } }), 'c2');
  assert.equal(endedCallId({ message: { type: 'status-update', status: 'in-progress', call: { id: 'c3' } } }), null);
});

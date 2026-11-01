import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTextToolCallDetector } from '../../src/agent/text-tool-calls.ts';

const calls = createTextToolCallDetector(['check_availability', 'book_appointment', 'mark_running_late', 'end_call']);

test('parses a call written in Gemma template syntax, as seen in the eval', () => {
  const text =
    'book_appointment{date:<|"|>monday<|"|>,name:<|"|>Mike<|"|>,phone:<|"|>650-555-0142<|"|>,serviceId:<|"|>exterior-wash<|"|>,time:<|"|>09:00<|"|>}';
  assert.deepEqual(calls.parse(text), {
    name: 'book_appointment',
    args: { date: 'monday', name: 'Mike', phone: '650-555-0142', serviceId: 'exterior-wash', time: '09:00' },
  });
});

test('keeps numbers and booleans, and string values with commas or colons intact', () => {
  assert.deepEqual(calls.parse('mark_running_late{eventId:<|"|>a,b:c<|"|>,minutesLate:10,urgent:true}'), {
    name: 'mark_running_late',
    args: { eventId: 'a,b:c', minutesLate: 10, urgent: true },
  });
});

test('detects calls in either syntax, and raw template tokens', () => {
  assert.equal(calls.detect('check_availability(serviceId="exterior-wash")'), true);
  assert.equal(calls.detect('check_availability{serviceId:<|"|>x<|"|>}'), true);
  assert.equal(calls.detect('Sure <|"|> thing'), true);
});

test('a reply that is only a tool name is the call, with no arguments, as seen in the eval', () => {
  assert.deepEqual(calls.parse('end_call'), { name: 'end_call', args: {} });
  assert.deepEqual(calls.parse(' end_call() '), { name: 'end_call', args: {} });
  assert.equal(calls.detect('end_call'), true);
});

test('a tool name anywhere in a reply is detected, so it never reaches the caller', () => {
  assert.equal(calls.detect('Goodbye! end_call'), true);
  assert.equal(calls.parse('Goodbye! end_call'), null);
});

test('ordinary replies are left alone', () => {
  for (const text of [
    'Sure, I can check availability for you (it only takes a second).',
    'Booked you in for Thursday at 4:30. Anything else?',
    'Our prices: {exterior wash: $40}',
  ]) {
    assert.equal(calls.detect(text), false, text);
    assert.equal(calls.parse(text), null, text);
  }
});

test('function-call syntax and unknown tools are detected but not parsed', () => {
  assert.equal(calls.parse('check_availability(serviceId="exterior-wash")'), null);
  assert.equal(calls.parse('delete_everything{all:true}'), null);
});

test('broken template syntax is not parsed', () => {
  assert.equal(calls.parse('book_appointment{date:<|"|>monday}'), null);
});

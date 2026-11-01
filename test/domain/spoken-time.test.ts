import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockMinutes, speakDates, speakTimes, spokenTime } from '../../src/domain/spoken-time.ts';

test('spokenTime says a 24-hour time the way a receptionist would', () => {
  assert.equal(spokenTime('18:00'), '6 PM');
  assert.equal(spokenTime('09:30'), '9:30 AM');
  assert.equal(spokenTime('12:00'), '12 PM');
});

test('clearly 24-hour times in a reply are rewritten, as seen in testing', () => {
  assert.equal(
    speakTimes('You have an appointment on Thursday, Nov 5 at 16:30. Anything else?'),
    'You have an appointment on Thursday, Nov 5 at 4:30 PM. Anything else?',
  );
  assert.equal(
    speakTimes('I have openings Friday at 09:00, 10:30, or 12:00.'),
    'I have openings Friday at 9 AM, 10:30, or 12:00.',
  );
  assert.equal(speakTimes('Moved you to Friday at 09:00.'), 'Moved you to Friday at 9 AM.');
});

test('a 24-hour time given AM or PM is rewritten too', () => {
  // From the bug hunt.
  assert.equal(speakTimes('I have 9:00 AM, 12:00 PM, or 13:00 PM.'), 'I have 9:00 AM, 12:00 PM, or 1 PM.');
});

test('times people already say are left alone', () => {
  for (const text of [
    'Booked you in for 4:30 PM.',
    'How about 10:30?',
    'We open at 9:00 am.',
    'It takes 1:30 hours.',
  ]) {
    assert.equal(speakTimes(text), text);
  }
});

test('clock times are found as minutes after midnight, spoken or 24-hour', () => {
  assert.deepEqual(clockMinutes('I can book 3:30 PM, or 9 am, or 12 PM.'), [930, 540, 720]);
  assert.deepEqual(clockMinutes('{"time":"16:30","label":"Thursday, Nov 5 at 4:30 PM"}'), [990, 990]);
  // A bare "10:30" could be morning or evening, so it isn't counted.
  assert.deepEqual(clockMinutes('How about 10:30?'), []);
});

test('ISO dates in a reply are said the way people say them', () => {
  assert.equal(
    speakDates('I can book that for you on 2026-11-05 at 3:30 PM.', 2026),
    'I can book that for you on Thursday, Nov 5 at 3:30 PM.',
  );
  // From the demo: the caller typed last year.
  assert.equal(speakDates('on 2025-11-05', 2026), 'on Wednesday, Nov 5, 2025');
  assert.equal(speakDates('Event 2026-13-45 stays.', 2026), 'Event 2026-13-45 stays.');
});

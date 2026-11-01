import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speakTimes, spokenTime } from '../../src/domain/spoken-time.ts';

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

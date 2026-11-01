import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { DATE_INPUT_PATTERN, resolveDate } from '../../src/domain/dates.ts';

// Saturday Oct 31, 2026.
const saturday = DateTime.fromISO('2026-10-31T12:00', { zone: 'America/Los_Angeles' });

test('a weekday name means the next day with that name', () => {
  assert.equal(resolveDate('friday', saturday), '2026-11-06');
  assert.equal(resolveDate('Thursday', saturday), '2026-11-05');
  assert.equal(resolveDate('sunday', saturday), '2026-11-01');
  assert.equal(resolveDate('monday', saturday), '2026-11-02');
});

test("today's weekday name means today", () => {
  assert.equal(resolveDate('saturday', saturday), '2026-10-31');
});

test('today and tomorrow', () => {
  assert.equal(resolveDate('today', saturday), '2026-10-31');
  assert.equal(resolveDate('tomorrow', saturday), '2026-11-01');
});

test('ISO dates pass through unchanged', () => {
  assert.equal(resolveDate('2026-11-13', saturday), '2026-11-13');
});

test('anything else is rejected', () => {
  for (const input of ['next friday', 'fri', '11/6', 'someday', '']) {
    assert.equal(resolveDate(input, saturday), null, input);
    assert.equal(DATE_INPUT_PATTERN.test(input), false, input);
  }
});

test('the input pattern matches exactly what resolveDate accepts', () => {
  for (const input of ['2026-11-06', 'today', 'Tomorrow', 'FRIDAY']) {
    assert.equal(DATE_INPUT_PATTERN.test(input), true, input);
    assert.notEqual(resolveDate(input, saturday), null, input);
  }
});

test('works across the end of daylight saving time', () => {
  // Saturday Oct 31 -> Sunday Nov 1, when the clocks go back.
  const lateSaturday = DateTime.fromISO('2026-10-31T23:30', { zone: 'America/Los_Angeles' });
  assert.equal(resolveDate('tomorrow', lateSaturday), '2026-11-01');
  assert.equal(resolveDate('monday', lateSaturday), '2026-11-02');
});

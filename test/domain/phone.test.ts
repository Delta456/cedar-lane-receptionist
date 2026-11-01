import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPhone, normalizePhone } from '../../src/domain/phone.ts';

test('typed formats all normalise to the same number', () => {
  for (const input of ['415-555-0190', '(415) 555-0190', '415.555.0190', '4155550190', '+1 415 555 0190']) {
    assert.equal(normalizePhone(input), '+14155550190', input);
  }
});

test('the brief: spoken digits with "oh" and "ninety"', () => {
  assert.equal(normalizePhone('four one five five five five oh one ninety'), '+14155550190');
});

test('other spoken forms', () => {
  assert.equal(normalizePhone('four one five double five five zero one nine zero'), '+14155550190');
  assert.equal(normalizePhone('four one five triple five oh one nine oh'), '+14155550190');
  assert.equal(normalizePhone('my number is 415 555 oh one nine oh'), '+14155550190');
  assert.equal(normalizePhone('four one five five five five oh one ninety one'), '+14155550191');
  assert.equal(normalizePhone('eight hundred five five five oh one nine oh'), '+18005550190');
  assert.equal(normalizePhone('four one five, five five five, twenty-one ninety'), '+14155552190');
});

test('incomplete or impossible numbers are rejected', () => {
  assert.equal(normalizePhone('555-0190'), null);
  assert.equal(normalizePhone('415-555-01900'), null);
  assert.equal(normalizePhone('015-555-0190'), null);
  assert.equal(normalizePhone('415-155-0190'), null);
  assert.equal(normalizePhone(''), null);
});

test('formatPhone', () => {
  assert.equal(formatPhone('+14155550190'), '(415) 555-0190');
});

test('a number with a country code is checked for its own country, as for a test caller in India', () => {
  assert.equal(
    normalizePhone('plus nine one nine eight double one four one double six eight five'),
    '+919811416685',
  );
  assert.equal(normalizePhone('+91 98114 16685'), '+919811416685');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('plus one four one five five five five zero one nine zero'), '+14155550190');
  // Too short for India, and without a country code it's read as a US number.
  assert.equal(normalizePhone('plus nine one nine seven one one'), null);
  assert.equal(normalizePhone('nine eight double one four one double six eight five'), null);
  assert.equal(formatPhone('+919811416685'), '+91 98114 16685');
});

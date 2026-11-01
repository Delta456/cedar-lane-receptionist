import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstNamesMatch } from '../../src/domain/names.ts';

test('a one-letter spelling difference still matches, as when speech-to-text wrote "Sarah" for "Sara"', () => {
  for (const [given, onBooking] of [
    ['Sarah', 'Sara'],
    ['sara', 'Sarah'],
    ['Jon', 'John'],
    ['Katie', 'Kate'],
    ['Mike', 'Mike'],
  ]) {
    assert.equal(firstNamesMatch(given as string, onBooking as string), true, `${given} / ${onBooking}`);
  }
});

test('different names, and short names one letter apart, do not match', () => {
  for (const [given, onBooking] of [
    ['Mike', 'Sara'],
    ['Steven', 'Stephen'],
    ['Al', 'Ed'],
    ['Al', 'Ali'],
    ['Sarah', 'Sasha'],
  ]) {
    assert.equal(firstNamesMatch(given as string, onBooking as string), false, `${given} / ${onBooking}`);
  }
});

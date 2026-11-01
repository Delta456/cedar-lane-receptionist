import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { shop } from '../../src/config/shop.ts';
import { type BusyBlock, evaluate, findOpenTimes } from '../../src/domain/availability.ts';

const zone = shop.timezone;
const at = (iso: string) => DateTime.fromISO(iso, { zone });
const times = (slots: { start: DateTime }[]) => slots.map((s) => s.start.toFormat('ccc HH:mm'));

// Saturday Oct 31, noon in the shop's timezone.
const now = at('2026-10-31T12:00');
// The test booking on the real Calendar: Thursday 3:30-4:30 PM.
const thursday: BusyBlock[] = [{ id: 'e1', start: at('2026-11-05T15:30'), end: at('2026-11-05T16:30') }];
const interior = (date: string, time: string, ignoreEventId?: string) => ({
  serviceId: 'interior-detail-wash',
  date,
  time,
  ignoreEventId,
});

test('the brief: 3:30 Thursday is full and 4:30 is offered first', () => {
  const result = evaluate(interior('2026-11-05', '15:30'), thursday, now);
  assert.equal(result.available, false);
  assert.ok(!result.available);
  assert.equal(result.reason, 'booked');
  assert.deepEqual(times(result.alternatives), ['Thu 16:30', 'Thu 14:30', 'Thu 17:00']);
});

test('the brief: 4:30 Thursday is open', () => {
  const result = evaluate(interior('2026-11-05', '16:30'), thursday, now);
  assert.equal(result.available, true);
});

test('a slot that starts before a booking but runs into it is full', () => {
  const result = evaluate(interior('2026-11-05', '15:00'), thursday, now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'booked');
});

test('a slot that ends exactly when a booking starts is open', () => {
  const result = evaluate(interior('2026-11-05', '14:30'), thursday, now);
  assert.equal(result.available, true);
});

test('Sunday is closed and Monday slots are offered', () => {
  const result = evaluate(interior('2026-11-01', '10:00'), thursday, now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'closed');
  assert.deepEqual(times(result.alternatives), ['Mon 09:00', 'Mon 09:30', 'Mon 10:00']);
});

test('a service must finish by closing time', () => {
  const result = evaluate({ serviceId: 'full-detail', date: '2026-11-05', time: '16:00' }, [], now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'outside_hours');
  assert.equal(evaluate({ serviceId: 'full-detail', date: '2026-11-05', time: '15:00' }, [], now).available, true);
});

test('times off the 30-minute grid are rejected', () => {
  const result = evaluate(interior('2026-11-05', '10:15'), [], now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'not_on_slot');
});

test('past times are rejected, with later slots today offered', () => {
  const result = evaluate(interior('2026-10-31', '11:00'), [], now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'in_past');
  assert.equal(times(result.alternatives)[0], 'Sat 12:30');
});

test('a reschedule does not conflict with the booking being moved', () => {
  assert.equal(evaluate(interior('2026-11-05', '15:30', 'e1'), thursday, now).available, true);
});

test('quote-only services are handed off, unknown services rejected', () => {
  const quote = evaluate({ serviceId: 'paint-correction', date: '2026-11-05', time: '10:00' }, [], now);
  assert.ok(!quote.available);
  assert.equal(quote.reason, 'needs_quote');
  const unknown = evaluate({ serviceId: 'oil-change', date: '2026-11-05', time: '10:00' }, [], now);
  assert.ok(!unknown.available);
  assert.equal(unknown.reason, 'unknown_service');
});

test('invalid dates are rejected', () => {
  const result = evaluate(interior('2026-02-30', '10:00'), [], now);
  assert.ok(!result.available);
  assert.equal(result.reason, 'invalid_time');
});

test('with two bays, a slot is full only when both are taken', () => {
  const twoBays = { ...shop, bays: 2 };
  const one: BusyBlock[] = [{ id: 'a', start: at('2026-11-05T10:00'), end: at('2026-11-05T11:00') }];
  assert.equal(evaluate(interior('2026-11-05', '10:00'), one, now, twoBays).available, true);

  // These two never overlap each other, so one bay is always free.
  const staggered: BusyBlock[] = [...one, { id: 'b', start: at('2026-11-05T11:00'), end: at('2026-11-05T12:00') }];
  assert.equal(evaluate(interior('2026-11-05', '10:30'), staggered, now, twoBays).available, true);

  const both: BusyBlock[] = [...one, { id: 'c', start: at('2026-11-05T10:30'), end: at('2026-11-05T11:30') }];
  const result = evaluate(interior('2026-11-05', '10:00'), both, now, twoBays);
  assert.ok(!result.available);
  assert.equal(result.reason, 'booked');
});

test('open times are a spread across the day, skipping booked slots', () => {
  const result = findOpenTimes({ serviceId: 'interior-detail-wash', date: '2026-11-05' }, thursday, now);
  assert.ok(result.ok);
  assert.equal(result.date, '2026-11-05');
  const shown = times(result.slots);
  assert.equal(shown.length, 6);
  assert.equal(shown[0], 'Thu 09:00');
  assert.equal(shown.at(-1), 'Thu 17:00');
  // 15:00 and 15:30 overlap the 3:30 booking.
  assert.ok(!shown.includes('Thu 15:00') && !shown.includes('Thu 15:30'));
});

test('open times on a closed day move to the next open day', () => {
  const result = findOpenTimes({ serviceId: 'exterior-wash', date: '2026-11-01' }, [], now);
  assert.ok(result.ok);
  assert.equal(result.requestedDate, '2026-11-01');
  assert.equal(result.date, '2026-11-02');
});

test('open times today only include times still ahead', () => {
  const result = findOpenTimes({ serviceId: 'exterior-wash', date: '2026-10-31' }, [], now);
  assert.ok(result.ok);
  assert.ok(result.slots.every((s) => s.start > now));
});

test('open times for a quote-only service are handed off', () => {
  const result = findOpenTimes({ serviceId: 'paint-correction', date: '2026-11-05' }, [], now);
  assert.deepEqual(result, { ok: false, reason: 'needs_quote' });
});

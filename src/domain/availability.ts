// Decides whether a service can be booked at a given time, and if not, which
// nearby slots are open. Pure: it takes the existing bookings and the current
// time as arguments, so every rule can be tested without a calendar.
import { DateTime } from 'luxon';
import { type ShopConfig, shop } from '../config/shop.ts';

// Time taken by an existing booking. `id` is the calendar event ID.
export type BusyBlock = { id: string; start: DateTime; end: DateTime };

export type Slot = { start: DateTime; end: DateTime };

export type UnavailableReason =
  | 'unknown_service'
  | 'needs_quote'
  | 'invalid_time'
  | 'in_past'
  | 'closed'
  | 'outside_hours'
  | 'not_on_slot'
  | 'booked';

export type AvailabilityResult =
  | { available: true; slot: Slot }
  | { available: false; reason: UnavailableReason; alternatives: Slot[] };

export type AvailabilityQuery = {
  serviceId: string;
  // Local date and time in the shop's timezone: "2026-11-05" and "15:30".
  date: string;
  time: string;
  // When rescheduling, the caller's current booking must not block itself.
  ignoreEventId?: string | undefined;
};

// A slot as the agent sees it: the date and time to pass back when booking,
// plus a label to read out.
export type SlotOption = { date: string; time: string; label: string };

const MAX_ALTERNATIVES = 3;
// How many days ahead to look for alternatives when the requested day is full.
export const LOOKAHEAD_DAYS = 7;

export function evaluate(
  query: AvailabilityQuery,
  busy: readonly BusyBlock[],
  now: DateTime,
  config: ShopConfig = shop,
): AvailabilityResult {
  const service = config.services.find((s) => s.id === query.serviceId);
  if (!service) {
    return { available: false, reason: 'unknown_service', alternatives: [] };
  }
  if (service.priceUsd === null) {
    return { available: false, reason: 'needs_quote', alternatives: [] };
  }

  const start = DateTime.fromISO(`${query.date}T${query.time}`, { zone: config.timezone });
  if (!start.isValid) {
    return { available: false, reason: 'invalid_time', alternatives: [] };
  }
  const slot = { start, end: start.plus({ minutes: service.durationMinutes }) };
  const others = busy.filter((b) => b.id !== query.ignoreEventId);

  const reason = unavailableReason(slot, others, now, config);
  if (reason === null) {
    return { available: true, slot };
  }
  return {
    available: false,
    reason,
    alternatives: findAlternatives(slot.start, service.durationMinutes, others, now, config),
  };
}

export type OpenTimesResult =
  | { ok: true; date: string; requestedDate: string; slots: Slot[] }
  | { ok: false; reason: 'unknown_service' | 'needs_quote' | 'invalid_time' };

// How many open times to offer for a day; a spread, not just the earliest.
const MAX_OPEN_TIMES = 6;

// Open times for a service on a day, for "what's open Thursday?". If that day
// is closed or full, the next day with openings, within LOOKAHEAD_DAYS.
// `date` is the day the slots are on, so the agent can say if it moved.
export function findOpenTimes(
  query: { serviceId: string; date: string },
  busy: readonly BusyBlock[],
  now: DateTime,
  config: ShopConfig = shop,
): OpenTimesResult {
  const service = config.services.find((s) => s.id === query.serviceId);
  if (!service) {
    return { ok: false, reason: 'unknown_service' };
  }
  if (service.priceUsd === null) {
    return { ok: false, reason: 'needs_quote' };
  }
  const day = DateTime.fromISO(query.date, { zone: config.timezone });
  if (!day.isValid) {
    return { ok: false, reason: 'invalid_time' };
  }
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const candidate = day.plus({ days: i });
    const slots = openSlots(candidate, service.durationMinutes, busy, now, config);
    if (slots.length > 0) {
      return { ok: true, date: candidate.toISODate() ?? '', requestedDate: query.date, slots: spread(slots) };
    }
  }
  return { ok: true, date: query.date, requestedDate: query.date, slots: [] };
}

// Up to MAX_OPEN_TIMES slots, evenly spaced through the day, in time order.
function spread(slots: Slot[]): Slot[] {
  if (slots.length <= MAX_OPEN_TIMES) {
    return slots;
  }
  const step = (slots.length - 1) / (MAX_OPEN_TIMES - 1);
  return Array.from({ length: MAX_OPEN_TIMES }, (_, i) => slots[Math.round(i * step)] as Slot);
}

export function formatSlot(slot: Slot, config: ShopConfig = shop): string {
  return slot.start.setZone(config.timezone).toFormat("cccc, LLL d 'at' h:mm a");
}

export function toSlotOption(slot: Slot, config: ShopConfig = shop): SlotOption {
  const start = slot.start.setZone(config.timezone);
  return { date: start.toISODate() ?? '', time: start.toFormat('HH:mm'), label: formatSlot(slot, config) };
}

function unavailableReason(
  slot: Slot,
  busy: readonly BusyBlock[],
  now: DateTime,
  config: ShopConfig,
): UnavailableReason | null {
  if (slot.start <= now) {
    return 'in_past';
  }
  const hours = openingHours(slot.start, config);
  if (hours === null) {
    return 'closed';
  }
  if (slot.start < hours.open || slot.end > hours.close) {
    return 'outside_hours';
  }
  if (slot.start.diff(hours.open, 'minutes').minutes % config.slotMinutes !== 0) {
    return 'not_on_slot';
  }
  if (isFull(slot, busy, config.bays)) {
    return 'booked';
  }
  return null;
}

// Open slots nearest to the requested time on the same day. If that day has
// none, the earliest open slots on the next days the shop is open.
function findAlternatives(
  requested: DateTime,
  durationMinutes: number,
  busy: readonly BusyBlock[],
  now: DateTime,
  config: ShopConfig,
): Slot[] {
  const sameDay = openSlots(requested, durationMinutes, busy, now, config);
  if (sameDay.length > 0) {
    const distance = (s: Slot) => Math.abs(s.start.diff(requested).toMillis());
    // Closest first; on a tie, prefer the later slot.
    sameDay.sort((a, b) => distance(a) - distance(b) || b.start.toMillis() - a.start.toMillis());
    return sameDay.slice(0, MAX_ALTERNATIVES);
  }

  for (let i = 1; i <= LOOKAHEAD_DAYS; i++) {
    const slots = openSlots(requested.plus({ days: i }), durationMinutes, busy, now, config);
    if (slots.length > 0) {
      return slots.slice(0, MAX_ALTERNATIVES);
    }
  }
  return [];
}

// Every bookable slot on the local day of `day`, in time order.
function openSlots(
  day: DateTime,
  durationMinutes: number,
  busy: readonly BusyBlock[],
  now: DateTime,
  config: ShopConfig,
): Slot[] {
  const hours = openingHours(day, config);
  if (hours === null) {
    return [];
  }
  const slots: Slot[] = [];
  for (
    let start = hours.open;
    start.plus({ minutes: durationMinutes }) <= hours.close;
    start = start.plus({ minutes: config.slotMinutes })
  ) {
    const slot = { start, end: start.plus({ minutes: durationMinutes }) };
    if (slot.start > now && !isFull(slot, busy, config.bays)) {
      slots.push(slot);
    }
  }
  return slots;
}

// True when, at some moment inside `slot`, every bay is already taken.
export function isFull(slot: Slot, busy: readonly BusyBlock[], bays: number): boolean {
  const overlapping = busy.filter((b) => b.start < slot.end && b.end > slot.start);
  // The busiest moment starts when some booking starts (or at the slot start),
  // so it is enough to count overlaps at each of those points.
  const points = [slot.start, ...overlapping.map((b) => b.start).filter((t) => t > slot.start)];
  return points.some((t) => overlapping.filter((b) => b.start <= t && b.end > t).length >= bays);
}

// Opening and closing times on the local day of `day`, or null if closed.
function openingHours(day: DateTime, config: ShopConfig): { open: DateTime; close: DateTime } | null {
  // Luxon numbers weekdays 1 (Monday) to 7 (Sunday); the config starts at Sunday.
  const hours = config.hours[day.weekday % 7];
  if (!hours) {
    return null;
  }
  return { open: atTime(day, hours.open), close: atTime(day, hours.close) };
}

function atTime(day: DateTime, hhmm: string): DateTime {
  const [hour = 0, minute = 0] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

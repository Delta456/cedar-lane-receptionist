import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { DateTime } from 'luxon';
import { shop } from '../../src/config/shop.ts';
import { BookingService } from '../../src/services/booking-service.ts';
import { FakeCalendarStore } from '../support/fake-stores.ts';

const at = (iso: string) => DateTime.fromISO(iso, { zone: shop.timezone });
// Saturday Oct 31, noon shop time.
let now = at('2026-10-31T12:00');

const SARA = '+14155550190';
const MIKE = '+16505550142';
const interior = { serviceId: 'interior-detail-wash', date: '2026-11-05' };

let calendar: FakeCalendarStore;
let bookings: BookingService;

beforeEach(() => {
  now = at('2026-10-31T12:00');
  calendar = new FakeCalendarStore();
  bookings = new BookingService({ calendar, now: () => now });
});

async function bookSara(time = '16:30') {
  const result = await bookings.book({ ...interior, time, name: 'Sara', phone: '415-555-0190' });
  assert.ok(result.ok, `booking failed: ${JSON.stringify(result)}`);
  return result.booking;
}

describe('book', () => {
  test('creates an event owned by the normalised phone number', async () => {
    const booking = await bookSara();
    assert.equal(booking.when, 'Thursday, Nov 5 at 4:30 PM');
    const event = calendar.events.get(booking.eventId);
    assert.deepEqual(event?.owner, { phone: SARA, name: 'Sara', serviceId: 'interior-detail-wash' });
    assert.equal(event?.end.toFormat('HH:mm'), '17:30');
  });

  test('refuses a taken slot and offers alternatives', async () => {
    await bookSara();
    const result = await bookings.book({ ...interior, time: '16:30', name: 'Mike', phone: MIKE });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'booked');
    // 5:30 would run past the 6 PM close, so the nearest open slot is 3:30.
    assert.equal(result.alternatives?.[0]?.label, 'Thursday, Nov 5 at 3:30 PM');
  });

  test('two concurrent bookings for one slot: exactly one succeeds', async () => {
    const results = await Promise.all([
      bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: SARA }),
      bookings.book({ ...interior, time: '10:00', name: 'Mike', phone: MIKE }),
    ]);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false],
    );
    assert.equal(calendar.events.size, 1);
  });

  test('ignores events marked free in the calendar', async () => {
    calendar.add({
      summary: 'Staff lunch',
      description: '',
      start: at('2026-11-05T10:00'),
      end: at('2026-11-05T11:00'),
      busy: false,
      owner: null,
    });
    assert.ok((await bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: SARA })).ok);
  });

  test('rejects an invalid phone number or a blank name', async () => {
    const badPhone = await bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: '555-0190' });
    assert.ok(!badPhone.ok);
    assert.equal(badPhone.reason, 'invalid_phone');
    const noName = await bookings.book({ ...interior, time: '10:00', name: '  ', phone: SARA });
    assert.ok(!noName.ok);
    assert.equal(noName.reason, 'missing_name');
  });
});

test('book accepts a weekday name and books the next one', async () => {
  const result = await bookings.book({
    serviceId: 'exterior-wash',
    date: 'friday',
    time: '11:00',
    name: 'Sara',
    phone: SARA,
  });
  assert.ok(result.ok);
  assert.equal(result.booking.date, '2026-11-06');
});

describe('find', () => {
  test("lists only the caller's upcoming bookings, soonest first", async () => {
    await bookSara('16:30');
    await bookSara('10:00');
    await bookings.book({ ...interior, time: '12:00', name: 'Mike', phone: MIKE });

    const result = await bookings.find('four one five five five five oh one ninety');
    assert.ok(result.ok);
    assert.deepEqual(
      result.bookings.map((b) => b.time),
      ['10:00', '16:30'],
    );
  });
});

describe('reschedule', () => {
  test('moves the booking, and its own old slot does not block it', async () => {
    const booking = await bookSara('16:30');
    const result = await bookings.reschedule({
      eventId: booking.eventId,
      phone: SARA,
      date: '2026-11-05',
      time: '17:00',
    });
    assert.ok(result.ok);
    assert.equal(result.booking.when, 'Thursday, Nov 5 at 5:00 PM');
    assert.equal(calendar.events.size, 1);
  });

  test("refuses to move someone else's booking", async () => {
    const booking = await bookSara();
    const result = await bookings.reschedule({
      eventId: booking.eventId,
      phone: MIKE,
      date: '2026-11-05',
      time: '10:00',
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'not_your_booking');
  });

  test('refuses a booking that has already started', async () => {
    const booking = await bookSara('16:30');
    now = at('2026-11-05T16:45');
    const result = await bookings.reschedule({
      eventId: booking.eventId,
      phone: SARA,
      date: '2026-11-06',
      time: '10:00',
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'already_started');
  });

  test('can change the service', async () => {
    const booking = await bookSara('10:00');
    const result = await bookings.reschedule({
      eventId: booking.eventId,
      phone: SARA,
      date: '2026-11-05',
      time: '10:00',
      serviceId: 'full-detail',
    });
    assert.ok(result.ok);
    assert.equal(result.booking.serviceId, 'full-detail');
    assert.equal(calendar.events.get(booking.eventId)?.end.toFormat('HH:mm'), '13:00');
  });
});

describe('cancel', () => {
  test('deletes the booking', async () => {
    const booking = await bookSara();
    assert.ok((await bookings.cancel({ eventId: booking.eventId, phone: SARA })).ok);
    assert.equal(calendar.events.size, 0);
  });

  test('an unknown event is not found', async () => {
    const result = await bookings.cancel({ eventId: 'nope', phone: SARA });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'not_found');
  });
});

describe('markRunningLate', () => {
  test('adds a note and reports the grace period, even after the start', async () => {
    const booking = await bookSara('16:30');
    now = at('2026-11-05T16:35');
    const result = await bookings.markRunningLate({ phone: SARA, minutesLate: 10 });
    assert.ok(result.ok);
    assert.equal(result.withinGracePeriod, true);
    assert.match(calendar.events.get(booking.eventId)?.description ?? '', /Running late: about 10 min/);

    const later = await bookings.markRunningLate({ phone: SARA, minutesLate: 30 });
    assert.ok(later.ok);
    assert.equal(later.withinGracePeriod, false);
  });

  test("finds today's booking from the phone number, the soonest one still going", async () => {
    const morning = await bookSara('09:00');
    const afternoon = await bookSara('14:00');
    now = at('2026-11-05T10:30');
    const result = await bookings.markRunningLate({ phone: '415-555-0190', minutesLate: 10 });
    assert.ok(result.ok);
    assert.equal(result.booking.eventId, afternoon.eventId);
    assert.doesNotMatch(calendar.events.get(morning.eventId)?.description ?? '', /Running late/);
  });

  test("a booking on another day, or under another name, is not today's booking", async () => {
    await bookSara('16:30');
    now = at('2026-11-04T12:00');
    assert.equal((await bookings.markRunningLate({ phone: SARA, minutesLate: 10 })).ok, false);
    now = at('2026-11-05T12:00');
    const wrongName = await bookings.markRunningLate({ phone: SARA, callerName: 'Mike', minutesLate: 10 });
    assert.ok(!wrongName.ok);
    assert.equal(wrongName.reason, 'no_booking_today');
  });
});

// Another server writing to the same calendar at the same moment. The
// competing write lands either just before or just after ours.
class RacingCalendar extends FakeCalendarStore {
  before: (() => void) | null = null;
  after: (() => void) | null = null;

  override async createEvent(event: Parameters<FakeCalendarStore['createEvent']>[0]) {
    this.before?.();
    const created = await super.createEvent(event);
    this.after?.();
    this.before = this.after = null;
    return created;
  }

  override async updateEvent(id: string, changes: Parameters<FakeCalendarStore['updateEvent']>[1]) {
    this.before?.();
    const updated = await super.updateEvent(id, changes);
    this.after?.();
    this.before = this.after = null;
    return updated;
  }
}

describe('another server writing the same slot', () => {
  let racing: RacingCalendar;
  const competitor = () =>
    racing.add({
      summary: 'Booked by another server',
      description: '',
      start: at('2026-11-05T10:00'),
      end: at('2026-11-05T11:00'),
      busy: true,
      owner: { phone: MIKE, name: 'Mike', serviceId: 'interior-detail-wash' },
    });

  beforeEach(() => {
    racing = new RacingCalendar();
    bookings = new BookingService({ calendar: racing, now: () => now });
  });

  test('if the other write landed first, this booking gives way and offers alternatives', async () => {
    racing.before = competitor;
    const result = await bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: SARA });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'booked');
    assert.ok((result.alternatives ?? []).length > 0);
    assert.deepEqual(
      [...racing.events.values()].map((e) => e.owner?.name),
      ['Mike'],
    );
  });

  test('if this write landed first, it keeps the slot', async () => {
    racing.after = competitor;
    const result = await bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: SARA });
    assert.ok(result.ok);
    assert.ok([...racing.events.values()].some((e) => e.owner?.name === 'Sara'));
  });

  test('a reschedule that loses is moved back to its original time', async () => {
    const booking = await bookSara('16:30');
    racing.before = competitor;
    const result = await bookings.reschedule({
      eventId: booking.eventId,
      phone: SARA,
      date: '2026-11-05',
      time: '10:00',
    });
    assert.ok(!result.ok);
    assert.equal(result.reason, 'booked');
    const event = racing.events.get(booking.eventId);
    assert.ok(event?.start.equals(at('2026-11-05T16:30')));
    assert.ok(event?.end.equals(at('2026-11-05T17:30')));
  });

  test('with a free bay left, an earlier overlapping write is fine', async () => {
    bookings = new BookingService({ calendar: racing, config: { ...shop, bays: 2 }, now: () => now });
    racing.before = competitor;
    const result = await bookings.book({ ...interior, time: '10:00', name: 'Sara', phone: SARA });
    assert.ok(result.ok);
    assert.equal(racing.events.size, 2);
  });
});

describe('name checks', () => {
  test('a booking made by hand with no name can be found and changed by phone alone', async () => {
    const event = calendar.add({
      summary: 'Exterior wash 415-555-0190',
      description: '',
      start: at('2026-11-05T10:00'),
      end: at('2026-11-05T10:30'),
      busy: true,
      owner: { phone: SARA, name: '', serviceId: 'exterior-wash' },
    });
    const found = await bookings.find(SARA, 'Anyone');
    assert.ok(found.ok);
    assert.equal(found.bookings.length, 1);
    assert.ok((await bookings.cancel({ eventId: event.id, phone: SARA, callerName: 'Anyone' })).ok);
  });

  test('a booking under "Sara" is found for "Sarah", but not for a different name', async () => {
    await bookSara();
    const found = await bookings.find(SARA, 'Sarah');
    assert.ok(found.ok);
    assert.equal(found.bookings.length, 1);
    const other = await bookings.find(SARA, 'Mike');
    assert.ok(other.ok);
    assert.equal(other.bookings.length, 0);
  });

  test('first names match regardless of case and surname', async () => {
    const booking = await bookSara();
    const result = await bookings.cancel({ eventId: booking.eventId, phone: SARA, callerName: 'SARA LEE' });
    assert.ok(result.ok);
  });
});

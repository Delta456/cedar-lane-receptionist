import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { DateTime } from 'luxon';
import { findTool, newCallState, soundsFinished, type ToolContext, tools } from '../../src/agent/tools.ts';
import { shop } from '../../src/config/shop.ts';
import { BookingService } from '../../src/services/booking-service.ts';
import { CallLogService } from '../../src/services/call-log-service.ts';
import { FakeCalendarStore, FakeCallLogStore } from '../support/fake-stores.ts';

let context: ToolContext;
let calendar: FakeCalendarStore;
let callStore: FakeCallLogStore;

const SARA = '+14155550190';
const MIKE = '+16505550142';

beforeEach(() => {
  const now = () => DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  calendar = new FakeCalendarStore();
  callStore = new FakeCallLogStore();
  context = {
    services: {
      bookings: new BookingService({ calendar, now }),
      callLog: new CallLogService({ store: callStore, now }),
    },
    call: newCallState(),
  };
});

const bookSara = () =>
  run('book_appointment', {
    serviceId: 'interior-detail-wash',
    date: '2026-11-05',
    time: '10:00',
    name: 'Sara',
    phone: '415-555-0190',
  });

const run = (name: string, input: unknown) => {
  const tool = findTool(name);
  assert.ok(tool, `no tool ${name}`);
  return tool.execute(input, context) as Promise<Record<string, unknown>>;
};

// Fields that may be left out. Everything else must be sent.
const OPTIONAL_FIELDS: Record<string, string[]> = { reschedule_appointment: ['serviceId'] };

test('every tool has a strict object schema, with only known optional fields', () => {
  for (const tool of tools) {
    // Zod leaves out `required` (and an empty `properties`) for a tool with no inputs.
    const {
      properties = {},
      required = [],
      additionalProperties,
    } = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties: boolean;
    };
    const optional = OPTIONAL_FIELDS[tool.name] ?? [];
    assert.equal(additionalProperties, false, tool.name);
    assert.deepEqual(
      [...required].sort(),
      Object.keys(properties)
        .filter((key) => !optional.includes(key))
        .sort(),
      tool.name,
    );
    assert.equal('$schema' in tool.parameters, false, tool.name);
  }
});

test('a missing field is returned to the model, and nothing is booked', async () => {
  const result = await run('book_appointment', {
    serviceId: 'interior-detail-wash',
    date: '2026-11-05',
    time: '10:00',
    phone: '415-555-0190',
  });
  assert.equal(result.reason, 'invalid_input');
  assert.match(String(result.issues), /name/);
  assert.equal(calendar.events.size, 0);
});

test('a booking is remembered in the call state for the call log', async () => {
  const booked = (await bookSara()) as { booking: { eventId: string } };
  assert.equal(context.call.lastEventId, booked.booking.eventId);
  assert.equal(context.call.phone, SARA);
  assert.equal(context.call.name, 'Sara');
});

test('with caller ID, a booking belongs to the calling number, whatever number is given', async () => {
  context.call = newCallState(SARA);
  const booked = await run('book_appointment', {
    serviceId: 'interior-detail-wash',
    date: '2026-11-05',
    time: '10:00',
    name: 'Sara',
    phone: '650-555-0142',
  });
  assert.equal(booked.ok, true);
  const [event] = calendar.events.values();
  assert.equal(event?.owner?.phone, SARA);
  // So the same caller finds it on their next call.
  const found = await run('find_bookings', { phone: '650-555-0142', name: null });
  assert.equal((found.bookings as unknown[]).length, 1);
});

test('find_bookings gives the spoken time and the service to reschedule with, not a 24-hour time', async () => {
  await bookSara();
  context.call = newCallState();
  const result = await run('find_bookings', { phone: '415-555-0190', name: 'Sara' });
  const [booking] = result.bookings as Record<string, unknown>[];
  assert.deepEqual(Object.keys(booking ?? {}).sort(), ['eventId', 'service', 'serviceId', 'when']);
  assert.equal(booking?.when, 'Thursday, Nov 5 at 10:00 AM');
  assert.equal(booking?.serviceId, 'interior-detail-wash');
  assert.match(String(result.note), /find_open_times with that booking's serviceId/);
  assert.doesNotMatch(JSON.stringify(result), /10:00"/);
});

test('end_call marks the call to end, but not in a turn that changed a booking', async () => {
  context.call.callerMessage = "That's all, bye.";
  const ended = await run('end_call', {});
  assert.equal(ended.ok, true);
  assert.equal(context.call.endRequested, true);

  context.call = newCallState();
  context.call.callerMessage = "Book it, that's all.";
  await bookSara();
  const tooSoon = await run('end_call', {});
  assert.equal(tooSoon.reason, 'too_soon');
  assert.equal(context.call.endRequested, false);
});

test('a callback needs a complete number, as on the real call where only five digits came through', async () => {
  const fragment = await run('request_callback', { name: 'David', phone: 'seven nine seven seven five', reason: 'x' });
  assert.equal(fragment.reason, 'invalid_phone');
  assert.match(String(fragment.tellCaller), /whole number again/);
  assert.match(String(fragment.tellCaller), /country code/);
  assert.equal(context.call.callback, null);

  const full = await run('request_callback', { name: 'Mike', phone: '650-555-0142', reason: 'charged twice' });
  assert.equal(full.ok, true);
  assert.match(String(full.tellCaller), /ending in 0142/);
  assert.deepEqual(context.call.callback, { name: 'Mike', phone: MIKE, reason: 'charged twice' });
});

test('a number the caller said is read by the code, over a garbled one from the model', async () => {
  context.call.callerMessage = 'Sorry, the full number is six five oh, five five five, oh one four two.';
  const result = await run('request_callback', { name: 'Mike', phone: '65055550142', reason: 'refund' });
  assert.equal(result.ok, true);
  assert.equal(context.call.callback?.phone, MIKE);
  // Without a complete number in what the caller said, the model's is used.
  context.call.callerMessage = 'Yes, that one.';
  await run('request_callback', { name: 'Mike', phone: '650-555-0142', reason: 'refund' });
  assert.equal(context.call.callback?.phone, MIKE);
});

test('a refused number tells the agent how the caller can fix it; a number with a country code books', async () => {
  const refused = await run('book_appointment', {
    serviceId: 'exterior-wash',
    date: '2026-11-05',
    time: '10:00',
    name: 'Asha',
    phone: '98114 16685',
  });
  assert.equal(refused.reason, 'invalid_phone');
  assert.match(String(refused.tellCaller), /country code/);
  const booked = await run('book_appointment', {
    serviceId: 'exterior-wash',
    date: '2026-11-05',
    time: '10:00',
    name: 'Asha',
    phone: '+91 98114 16685',
  });
  assert.equal(booked.ok, true);
});

test('with caller ID, a callback goes to the calling number', async () => {
  context.call = newCallState(SARA);
  await run('request_callback', { name: 'Sara', phone: '', reason: 'refund' });
  assert.equal(context.call.callback?.phone, SARA);
});

test('a booking saves the contact straight away, once per call', async () => {
  await bookSara();
  assert.equal(await context.call.contactSaved, SARA);
  assert.equal(callStore.contacts.get(SARA)?.name, 'Sara');

  await run('book_appointment', {
    serviceId: 'exterior-wash',
    date: '2026-11-06',
    time: '10:00',
    name: 'Sara',
    phone: '415-555-0190',
  });
  assert.equal(callStore.contacts.get(SARA)?.totalCalls, 1);
});

test('a 12-hour time is sent back with the format to use', async () => {
  const result = await run('check_availability', {
    serviceId: 'interior-detail-wash',
    date: '2026-11-05',
    time: '3:30',
  });
  assert.equal(result.reason, 'invalid_input');
  assert.match(String(result.issues), /24-hour HH:MM/);
});

test('check_availability returns slot options the model can book from', async () => {
  const result = await run('check_availability', {
    serviceId: 'interior-detail-wash',
    date: '2026-11-01',
    time: '10:00',
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'closed');
  assert.deepEqual((result.alternatives as unknown[])[0], {
    date: '2026-11-02',
    time: '09:00',
    label: 'Monday, Nov 2 at 9:00 AM',
  });
});

test('an unknown service id is rejected with the valid choices', async () => {
  const result = await run('check_availability', { serviceId: 'oil-change', date: '2026-11-05', time: '10:00' });
  assert.equal(result.reason, 'invalid_input');
  assert.match(String(result.issues), /interior-detail-wash/);
});

test("with caller ID, a caller can't cancel someone else's booking by giving their number", async () => {
  const booked = (await bookSara()) as { booking: { eventId: string } };
  context.call = newCallState(MIKE);

  // With caller ID no name is needed: the calling number is the proof.
  const found = await run('find_bookings', { phone: '415-555-0190', name: null });
  assert.deepEqual(found.bookings, []);

  const cancelled = await run('cancel_appointment', {
    eventId: booked.booking.eventId,
    phone: '415-555-0190',
    name: null,
  });
  assert.equal(cancelled.reason, 'not_your_booking');
  assert.equal(calendar.events.size, 1);
});

test('running late beyond the grace period tells the agent to offer a reschedule', async () => {
  await run('book_appointment', {
    serviceId: 'exterior-wash',
    date: 'today',
    time: '13:00',
    name: 'Sara',
    phone: '415-555-0190',
  });
  const late = await run('mark_running_late', { phone: SARA, name: 'Sara', minutesLate: 40 });
  assert.equal(late.withinGracePeriod, false);
  assert.match(String(late.tellCaller), /15 minutes.*reschedule/);

  const onTime = await run('mark_running_late', { phone: SARA, name: 'Sara', minutesLate: 5 });
  assert.match(String(onTime.tellCaller), /they're fine/);
});

test('running late needs the name without caller ID, and says when there is no booking today', async () => {
  const noName = await run('mark_running_late', { phone: SARA, name: null, minutesLate: 10 });
  assert.equal(noName.reason, 'name_required');
  const none = await run('mark_running_late', { phone: SARA, name: 'Sara', minutesLate: 10 });
  assert.equal(none.reason, 'no_booking_today');
  assert.match(String(none.tellCaller), /different number or name/);
});

test('find_open_times lists open times, moving past a closed day', async () => {
  const result = await run('find_open_times', { serviceId: 'exterior-wash', date: 'sunday' });
  assert.equal(result.ok, true);
  assert.equal(result.date, '2026-11-02');
  assert.equal(result.movedToAnotherDay, true);
  assert.ok((result.openTimes as unknown[]).length > 0);
});

describe('without caller ID, the name on the booking is also required', () => {
  test('finding bookings without a name asks for it', async () => {
    await bookSara();
    const result = await run('find_bookings', { phone: '415-555-0190', name: null });
    assert.equal(result.reason, 'name_required');
  });

  test('a different name finds nothing', async () => {
    await bookSara();
    const result = await run('find_bookings', { phone: '415-555-0190', name: 'Mike' });
    assert.deepEqual(result.bookings, []);
  });

  test('the right first name finds the booking', async () => {
    await bookSara();
    const result = await run('find_bookings', { phone: '415-555-0190', name: 'sara' });
    assert.equal((result.bookings as unknown[]).length, 1);
  });

  test("someone who knows Sara's number but gives their own name can't cancel", async () => {
    const booked = (await bookSara()) as { booking: { eventId: string } };
    const result = await run('cancel_appointment', { eventId: booked.booking.eventId, phone: SARA, name: 'Mike' });
    assert.equal(result.reason, 'name_mismatch');
    assert.equal(calendar.events.size, 1);

    const noName = await run('cancel_appointment', { eventId: booked.booking.eventId, phone: SARA, name: null });
    assert.equal(noName.reason, 'name_required');
  });

  test('the booking holder can reschedule and cancel', async () => {
    const booked = (await bookSara()) as { booking: { eventId: string } };
    const moved = await run('reschedule_appointment', {
      eventId: booked.booking.eventId,
      phone: SARA,
      name: 'Sara',
      date: 'friday',
      time: '11:00',
    });
    assert.equal(moved.ok, true);
    const cancelled = await run('cancel_appointment', { eventId: booked.booking.eventId, phone: SARA, name: 'Sara' });
    assert.equal(cancelled.ok, true);
  });
});

test("lookup_caller only works with caller ID, so it can't reveal whose number it is", async () => {
  await bookSara();
  await context.services.callLog.logCall({
    phone: SARA,
    name: 'Sara',
    intent: 'booking',
    summary: 's',
    outcome: 'o',
    needsHuman: false,
  });

  const typed = await run('lookup_caller', {});
  assert.deepEqual(typed, { found: false, reason: 'no_caller_id' });

  context.call = newCallState(SARA);
  const withCallerId = await run('lookup_caller', {});
  assert.equal(withCallerId.name, 'Sara');
});

test('end_call needs the caller to say they\'re finishing: "Yes please" to "Anything else?" isn\'t', async () => {
  for (const message of ['Yes please.', 'Yeah, can I also ask about prices?', 'Friday works.']) {
    context.call = newCallState();
    context.call.callerMessage = message;
    const refused = await run('end_call', {});
    assert.equal(refused.reason, 'caller_not_done', message);
    assert.equal(context.call.endRequested, false);
  }
  for (const message of ["That's all, bye.", 'No thanks, goodbye.', 'OK, thanks.', "Yes, that's all."]) {
    assert.equal(soundsFinished(message), true, message);
  }
});

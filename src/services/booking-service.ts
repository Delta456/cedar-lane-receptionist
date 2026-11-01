// Checks availability and creates, finds and changes bookings.
//
// Double booking is prevented at two levels. Within one server, writes run
// one at a time and re-check availability first. Across servers, which can't
// share that queue, every write is verified after it lands: if another
// booking for overlapping time was written first, this write gives way and
// undoes itself. Of two simultaneous writes, exactly one survives.
//
// A booking belongs to the phone number that made it. That is how bookings
// are found, and how a caller is kept from changing someone else's booking.
// Where the number can't be trusted (a text chat, with no caller ID), the
// caller must also give the name on the booking: `callerName` below.
import { DateTime } from 'luxon';
import { type Service, type ShopConfig, shop } from '../config/shop.ts';
import {
  type AvailabilityQuery,
  type AvailabilityResult,
  type BusyBlock,
  evaluate,
  findOpenTimes,
  formatSlot,
  isFull,
  LOOKAHEAD_DAYS,
  type OpenTimesResult,
  type Slot,
  type SlotOption,
  toSlotOption,
  type UnavailableReason,
} from '../domain/availability.ts';
import { resolveDate } from '../domain/dates.ts';
import { formatPhone, normalizePhone } from '../domain/phone.ts';
import { SerialQueue } from '../lib/serial-queue.ts';
import type { BookingOwner, CalendarEvent, CalendarStore } from './ports.ts';

export type BookingSummary = {
  eventId: string;
  serviceId: string;
  service: string;
  name: string;
  phone: string;
  date: string;
  time: string;
  when: string;
};

export type BookingFailureReason =
  | UnavailableReason
  | 'invalid_phone'
  | 'missing_name'
  | 'not_found'
  | 'not_your_booking'
  | 'name_mismatch'
  | 'already_started'
  | 'no_booking_today';

export type BookingFailure = { ok: false; reason: BookingFailureReason; alternatives?: SlotOption[] };

export type BookingResult = { ok: true; booking: BookingSummary } | BookingFailure;

export type LateResult =
  | { ok: true; booking: BookingSummary; withinGracePeriod: boolean; gracePeriodMinutes: number }
  | BookingFailure;

export type BookingServiceDeps = {
  calendar: CalendarStore;
  config?: ShopConfig;
  now?: () => DateTime;
};

// How far ahead find() looks for a caller's bookings.
const FIND_WINDOW_DAYS = 90;

export class BookingService {
  private readonly calendar: CalendarStore;
  private readonly config: ShopConfig;
  private readonly now: () => DateTime;
  private readonly writes = new SerialQueue();

  constructor({ calendar, config = shop, now = () => DateTime.now() }: BookingServiceDeps) {
    this.calendar = calendar;
    this.config = config;
    this.now = now;
  }

  // `query.date` may also be "today", "tomorrow" or a weekday name; see resolveDate.
  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const now = this.now();
    const date = this.resolve(query.date, now);
    if (!date) {
      return { available: false, reason: 'invalid_time', alternatives: [] };
    }
    return evaluate({ ...query, date }, await this.busyFrom(date), now, this.config);
  }

  // A spread of open times on a day, for "what's open Thursday?".
  async findOpenTimes(query: { serviceId: string; date: string }): Promise<OpenTimesResult> {
    const now = this.now();
    const date = this.resolve(query.date, now);
    if (!date) {
      return { ok: false, reason: 'invalid_time' };
    }
    return findOpenTimes({ ...query, date }, await this.busyFrom(date), now, this.config);
  }

  private resolve(input: string, now: DateTime): string | null {
    const date = resolveDate(input, now.setZone(this.config.timezone));
    return date && DateTime.fromISO(date, { zone: this.config.timezone }).isValid ? date : null;
  }

  // Busy time from the start of `date`, far enough ahead to cover the search
  // for alternatives on later days.
  private async busyFrom(date: string): Promise<BusyBlock[]> {
    const day = DateTime.fromISO(date, { zone: this.config.timezone });
    const events = await this.calendar.listEvents(day, day.plus({ days: LOOKAHEAD_DAYS + 1 }));
    return events.filter((e) => e.busy).map((e) => ({ id: e.id, start: e.start, end: e.end }));
  }

  async book(input: {
    serviceId: string;
    date: string;
    time: string;
    name: string;
    phone: string;
  }): Promise<BookingResult> {
    const phone = normalizePhone(input.phone);
    if (!phone) {
      return { ok: false, reason: 'invalid_phone' };
    }
    const name = input.name.trim();
    if (!name) {
      return { ok: false, reason: 'missing_name' };
    }

    return this.writes.run(async () => {
      const check = await this.checkAvailability(input);
      if (!check.available) {
        return this.unavailable(check);
      }
      const service = this.service(input.serviceId);
      const event = await this.calendar.createEvent({
        ...this.eventTiming(service, name, check.slot),
        description: `Name: ${name}\nPhone: ${formatPhone(phone)}\nBooked by the AI receptionist.`,
        owner: { phone, name, serviceId: service.id },
      });
      if (await this.lostRace(event)) {
        await this.calendar.deleteEvent(event.id);
        return this.takenMeanwhile(input);
      }
      return { ok: true, booking: this.summarize(event) };
    });
  }

  // Upcoming bookings for a phone number, soonest first.
  // With `callerName`, only bookings under that name are returned.
  async find(
    phoneInput: string,
    callerName?: string,
  ): Promise<{ ok: true; bookings: BookingSummary[] } | BookingFailure> {
    const phone = normalizePhone(phoneInput);
    if (!phone) {
      return { ok: false, reason: 'invalid_phone' };
    }
    const now = this.now();
    const events = await this.calendar.listEventsByPhone(phone, now, now.plus({ days: FIND_WINDOW_DAYS }));
    const bookings = events
      .filter((event) => callerName === undefined || nameMatches(event.owner, callerName))
      .sort((a, b) => a.start.toMillis() - b.start.toMillis())
      .map((event) => this.summarize(event));
    return { ok: true, bookings };
  }

  async reschedule(input: {
    eventId: string;
    phone: string;
    date: string;
    time: string;
    // Leave out to keep the same service.
    serviceId?: string | undefined;
    callerName?: string | undefined;
  }): Promise<BookingResult> {
    return this.writes.run(async () => {
      const owned = await this.ownedEvent(input.eventId, input.phone, {
        mustNotHaveStarted: true,
        callerName: input.callerName,
      });
      if (!owned.ok) {
        return owned;
      }
      const { event, owner } = owned;
      const serviceId = input.serviceId ?? owner.serviceId;

      const check = await this.checkAvailability({
        serviceId,
        date: input.date,
        time: input.time,
        ignoreEventId: event.id,
      });
      if (!check.available) {
        return this.unavailable(check);
      }
      const service = this.service(serviceId);
      const updated = await this.calendar.updateEvent(event.id, {
        ...this.eventTiming(service, owner.name, check.slot),
        owner: { ...owner, serviceId: service.id },
      });
      if (await this.lostRace(updated)) {
        // Put the booking back where it was.
        await this.calendar.updateEvent(event.id, {
          summary: event.summary,
          start: event.start,
          end: event.end,
          owner,
        });
        return this.takenMeanwhile({ serviceId, date: input.date, time: input.time, ignoreEventId: event.id });
      }
      return { ok: true, booking: this.summarize(updated) };
    });
  }

  async cancel(input: { eventId: string; phone: string; callerName?: string | undefined }): Promise<BookingResult> {
    return this.writes.run(async () => {
      const owned = await this.ownedEvent(input.eventId, input.phone, {
        mustNotHaveStarted: true,
        callerName: input.callerName,
      });
      if (!owned.ok) {
        return owned;
      }
      await this.calendar.deleteEvent(owned.event.id);
      return { ok: true, booking: this.summarize(owned.event) };
    });
  }

  // Notes on the booking that the caller is running late, so the shop sees it.
  // Someone running late means today's booking, so it's found from the
  // phone number (and, with `callerName`, the name) rather than an event id:
  // the model asked callers for "the event ID" instead of looking it up.
  async markRunningLate(input: {
    phone: string;
    callerName?: string | undefined;
    minutesLate: number;
  }): Promise<LateResult> {
    const phone = normalizePhone(input.phone);
    if (!phone) {
      return { ok: false, reason: 'invalid_phone' };
    }
    return this.writes.run(async () => {
      const now = this.now().setZone(this.config.timezone);
      // Bookings still going at some point from now to the end of today. One
      // that has already started can still have a late caller.
      const events = await this.calendar.listEventsByPhone(phone, now, now.endOf('day'));
      const event = events
        .filter((e) => input.callerName === undefined || nameMatches(e.owner, input.callerName))
        .sort((a, b) => a.start.toMillis() - b.start.toMillis())[0];
      if (!event) {
        return { ok: false, reason: 'no_booking_today' };
      }
      const calledAt = now.toFormat('h:mm a');
      const note = `Running late: about ${input.minutesLate} min (called at ${calledAt}).`;
      const updated = await this.calendar.updateEvent(event.id, {
        description: `${event.description}\n${note}`.trim(),
      });
      const grace = this.config.policies.lateGraceMinutes;
      return {
        ok: true,
        booking: this.summarize(updated),
        withinGracePeriod: input.minutesLate <= grace,
        gracePeriodMinutes: grace,
      };
    });
  }

  // The event, if it exists, hasn't ended, and belongs to this phone number
  // (and, with `callerName`, to this name).
  private async ownedEvent(
    eventId: string,
    phoneInput: string,
    { mustNotHaveStarted, callerName }: { mustNotHaveStarted: boolean; callerName?: string | undefined },
  ): Promise<{ ok: true; event: CalendarEvent; owner: BookingOwner } | BookingFailure> {
    const phone = normalizePhone(phoneInput);
    if (!phone) {
      return { ok: false, reason: 'invalid_phone' };
    }
    const event = await this.calendar.getEvent(eventId);
    const now = this.now();
    if (!event || event.end <= now) {
      return { ok: false, reason: 'not_found' };
    }
    if (event.owner?.phone !== phone) {
      return { ok: false, reason: 'not_your_booking' };
    }
    if (callerName !== undefined && !nameMatches(event.owner, callerName)) {
      return { ok: false, reason: 'name_mismatch' };
    }
    if (mustNotHaveStarted && event.start <= now) {
      return { ok: false, reason: 'already_started' };
    }
    return { ok: true, event, owner: event.owner };
  }

  // After a write: did a booking for overlapping time get written before this
  // one, leaving no bay free? Writes are ordered by the calendar's own
  // timestamp (then id), so every server reaches the same answer about which
  // of two conflicting writes came second.
  private async lostRace(written: CalendarEvent): Promise<boolean> {
    const overlapping = await this.calendar.listEvents(written.start, written.end);
    const earlier = overlapping.filter((e) => e.busy && e.id !== written.id && wroteFirst(e, written));
    return isFull({ start: written.start, end: written.end }, earlier, this.config.bays);
  }

  // The slot was taken by another booking while this one was being written.
  private async takenMeanwhile(query: AvailabilityQuery): Promise<BookingFailure> {
    const check = await this.checkAvailability(query);
    return check.available ? { ok: false, reason: 'booked', alternatives: [] } : this.unavailable(check);
  }

  private unavailable(check: AvailabilityResult & { available: false }): BookingFailure {
    return {
      ok: false,
      reason: check.reason,
      alternatives: check.alternatives.map((slot) => toSlotOption(slot, this.config)),
    };
  }

  private eventTiming(service: Service, name: string, slot: Slot) {
    return { summary: `${service.name} – ${name}`, start: slot.start, end: slot.end };
  }

  private summarize(event: CalendarEvent): BookingSummary {
    const start = event.start.setZone(this.config.timezone);
    const serviceId = event.owner?.serviceId ?? '';
    return {
      eventId: event.id,
      serviceId,
      service: this.config.services.find((s) => s.id === serviceId)?.name ?? event.summary,
      name: event.owner?.name ?? '',
      phone: event.owner?.phone ?? '',
      date: start.toISODate() ?? '',
      time: start.toFormat('HH:mm'),
      when: formatSlot({ start, end: event.end }, this.config),
    };
  }

  // book() and reschedule() only call this after checkAvailability, which
  // rejects unknown services, so a miss here is a programming error.
  private service(id: string): Service {
    const service = this.config.services.find((s) => s.id === id);
    if (!service) {
      throw new Error(`Unknown service: ${id}`);
    }
    return service;
  }
}

function wroteFirst(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.updatedAt < b.updatedAt || (a.updatedAt.equals(b.updatedAt) && a.id < b.id);
}

// Whether a caller's name matches the name on a booking. First names are
// enough ("Sara" matches "Sara Lee"), and case and punctuation don't matter.
// A booking with no name on it (made by hand without one) can't be checked
// this way, so only its phone number is required.
function nameMatches(owner: BookingOwner | null, callerName: string): boolean {
  const words = (name: string) => name.toLowerCase().match(/[a-z]+/g) ?? [];
  const onBooking = words(owner?.name ?? '');
  if (onBooking.length === 0) {
    return true;
  }
  const given = words(callerName);
  return given.length > 0 && given[0] === onBooking[0];
}

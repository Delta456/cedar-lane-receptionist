// In-memory stores for tests, behaving like the Google ones.
import { DateTime } from 'luxon';
import type {
  CalendarEvent,
  CalendarEventChanges,
  CalendarStore,
  CallLogStore,
  CallRecord,
  Contact,
  NewCalendarEvent,
} from '../../src/services/ports.ts';

export class FakeCalendarStore implements CalendarStore {
  readonly events = new Map<string, CalendarEvent>();
  private nextId = 1;
  // Each write gets a later timestamp, like Calendar's `updated` field.
  private clock = 0;

  async listEvents(from: CalendarEvent['start'], to: CalendarEvent['end']): Promise<CalendarEvent[]> {
    return [...this.events.values()].filter((e) => e.start < to && e.end > from);
  }

  async listEventsByPhone(phone: string, from: CalendarEvent['start'], to: CalendarEvent['end']) {
    return (await this.listEvents(from, to)).filter((e) => e.owner?.phone === phone);
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    return this.events.get(id) ?? null;
  }

  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    return this.add({ ...event, busy: true });
  }

  // The next write timestamp, for tests that stage writes in a set order.
  tick(): DateTime {
    return DateTime.fromMillis(++this.clock, { zone: 'utc' });
  }

  async updateEvent(id: string, changes: CalendarEventChanges): Promise<CalendarEvent> {
    const existing = this.events.get(id);
    if (!existing) {
      throw new Error(`no event ${id}`);
    }
    const updated = { ...existing, ...changes, updatedAt: this.tick() };
    this.events.set(id, updated);
    return updated;
  }

  async deleteEvent(id: string): Promise<void> {
    this.events.delete(id);
  }

  // Adds an event directly, like a booking made in the Calendar UI.
  add(event: Omit<CalendarEvent, 'id' | 'updatedAt'> & { id?: string; updatedAt?: DateTime }): CalendarEvent {
    const stored = { ...event, id: event.id ?? `event-${this.nextId++}`, updatedAt: event.updatedAt ?? this.tick() };
    this.events.set(stored.id, stored);
    return stored;
  }
}

export class FakeCallLogStore implements CallLogStore {
  readonly calls: CallRecord[] = [];
  readonly contacts = new Map<string, Contact>();
  failSaveContact = false;

  async appendCall(call: CallRecord): Promise<void> {
    this.calls.push(call);
  }

  async findContact(phone: string): Promise<Contact | null> {
    return this.contacts.get(phone) ?? null;
  }

  async saveContact(contact: Contact): Promise<void> {
    if (this.failSaveContact) {
      throw new Error('sheet unavailable');
    }
    this.contacts.set(contact.phone, contact);
  }
}

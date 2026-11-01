// What the services need from storage. The Google implementations live in
// integrations/google; tests use in-memory fakes.
import type { DateTime } from 'luxon';

// Who a booking belongs to. Only set on events the receptionist created.
export type BookingOwner = { phone: string; name: string; serviceId: string };

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  start: DateTime;
  end: DateTime;
  // False for events marked "free" in the calendar, which don't take a bay.
  busy: boolean;
  owner: BookingOwner | null;
  // When the event was last written. Decides which of two conflicting writes
  // gives way (see BookingService).
  updatedAt: DateTime;
};

export type NewCalendarEvent = {
  summary: string;
  description: string;
  start: DateTime;
  end: DateTime;
  owner: BookingOwner;
};

export type CalendarEventChanges = Partial<NewCalendarEvent>;

export interface CalendarStore {
  // Events that overlap [from, to).
  listEvents(from: DateTime, to: DateTime): Promise<CalendarEvent[]>;
  // Events owned by this E.164 phone number that overlap [from, to).
  listEventsByPhone(phone: string, from: DateTime, to: DateTime): Promise<CalendarEvent[]>;
  // null if the event doesn't exist or was cancelled.
  getEvent(id: string): Promise<CalendarEvent | null>;
  createEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  updateEvent(id: string, changes: CalendarEventChanges): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

export type Contact = {
  phone: string;
  name: string;
  firstSeen: string;
  lastCall: string;
  totalCalls: number;
  notes: string;
};

export type CallRecord = {
  timestamp: string;
  phone: string;
  name: string;
  intent: string;
  summary: string;
  outcome: string;
  needsHuman: boolean;
  eventId: string;
};

export interface CallLogStore {
  appendCall(call: CallRecord): Promise<void>;
  findContact(phone: string): Promise<Contact | null>;
  // Inserts the contact, or replaces the existing one with the same phone.
  saveContact(contact: Contact): Promise<void>;
}

// CalendarStore backed by a Google Calendar. The booking owner is kept in the
// event's private extended properties, invisible in the Calendar UI. Bookings
// staff create by hand have no such properties; their owner is read from the
// event's title or description instead (see inferOwner).
import type { calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import type { ShopConfig } from '../../config/shop.ts';
import { inferOwner } from '../../domain/booking-text.ts';
import type {
  BookingOwner,
  CalendarEvent,
  CalendarEventChanges,
  CalendarStore,
  NewCalendarEvent,
} from '../../services/ports.ts';
import { isNotFound } from './client.ts';

export class GoogleCalendarStore implements CalendarStore {
  private readonly api: calendar_v3.Calendar;
  private readonly calendarId: string;
  private readonly timezone: string;
  private readonly config: ShopConfig;

  constructor(api: calendar_v3.Calendar, calendarId: string, config: ShopConfig) {
    this.api = api;
    this.calendarId = calendarId;
    this.timezone = config.timezone;
    this.config = config;
  }

  listEvents(from: DateTime, to: DateTime): Promise<CalendarEvent[]> {
    return this.list({ timeMin: iso(from), timeMax: iso(to) });
  }

  // Filtered here rather than by the API, because bookings made by hand only
  // have the number in their text (see inferOwner).
  async listEventsByPhone(phone: string, from: DateTime, to: DateTime): Promise<CalendarEvent[]> {
    return (await this.listEvents(from, to)).filter((e) => e.owner?.phone === phone);
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    try {
      const { data } = await this.api.events.get({ calendarId: this.calendarId, eventId: id });
      return data.status === 'cancelled' ? null : this.toEvent(data);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent> {
    const { data } = await this.api.events.insert({ calendarId: this.calendarId, requestBody: this.toBody(event) });
    return this.require(data);
  }

  async updateEvent(id: string, changes: CalendarEventChanges): Promise<CalendarEvent> {
    // Patch semantics: only the fields sent are changed.
    const { data } = await this.api.events.patch({
      calendarId: this.calendarId,
      eventId: id,
      requestBody: this.toBody(changes),
    });
    return this.require(data);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.api.events.delete({ calendarId: this.calendarId, eventId: id });
  }

  private async list(params: calendar_v3.Params$Resource$Events$List): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.api.events.list({
        ...params,
        calendarId: this.calendarId,
        singleEvents: true,
        maxResults: 2500,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of data.items ?? []) {
        const event = this.toEvent(item);
        if (event) {
          events.push(event);
        }
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return events;
  }

  private toBody(event: CalendarEventChanges): calendar_v3.Schema$Event {
    const body: calendar_v3.Schema$Event = {};
    if (event.summary !== undefined) body.summary = event.summary;
    if (event.description !== undefined) body.description = event.description;
    if (event.start) body.start = { dateTime: iso(event.start), timeZone: this.timezone };
    if (event.end) body.end = { dateTime: iso(event.end), timeZone: this.timezone };
    if (event.owner) body.extendedProperties = { private: { ...event.owner } };
    return body;
  }

  // null for events we can't place in time, which are skipped.
  private toEvent(data: calendar_v3.Schema$Event): CalendarEvent | null {
    const start = this.parseTime(data.start);
    const end = this.parseTime(data.end);
    if (!data.id || !start || !end) {
      return null;
    }
    return {
      id: data.id,
      summary: data.summary ?? '',
      description: data.description ?? '',
      start,
      end,
      busy: data.transparency !== 'transparent',
      owner:
        parseOwner(data.extendedProperties?.private) ??
        inferOwner(data.summary ?? '', data.description ?? '', this.config.services),
      updatedAt: DateTime.fromISO(data.updated ?? data.created ?? '1970-01-01T00:00:00Z', { zone: 'utc' }),
    };
  }

  private require(data: calendar_v3.Schema$Event): CalendarEvent {
    const event = this.toEvent(data);
    if (!event) {
      throw new Error(`Google Calendar returned an event without an id or times: ${data.id ?? '(no id)'}`);
    }
    return event;
  }

  // Timed events have `dateTime`. All-day events (like a holiday closure)
  // have `date`, and block the whole day.
  private parseTime(time: calendar_v3.Schema$EventDateTime | undefined): DateTime | null {
    const value = time?.dateTime ?? time?.date;
    if (!value) {
      return null;
    }
    const parsed = DateTime.fromISO(value, { zone: this.timezone });
    return parsed.isValid ? parsed : null;
  }
}

function parseOwner(props: Record<string, string> | null | undefined): BookingOwner | null {
  if (!props?.phone) {
    return null;
  }
  return { phone: props.phone, name: props.name ?? '', serviceId: props.serviceId ?? '' };
}

function iso(time: DateTime): string {
  const value = time.toISO();
  if (!value) {
    throw new Error('Invalid date');
  }
  return value;
}

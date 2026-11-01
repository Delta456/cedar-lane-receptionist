// Reads who a booking is for from a calendar event's text, for bookings that
// shop staff create by hand. The convention is the customer's name and number
// in the title, like "Interior detail & wash – John 415-555-1234". The number
// can also be in the description.
import type { Service } from '../config/shop.ts';
import { normalizePhone } from './phone.ts';

export type InferredOwner = { phone: string; name: string; serviceId: string };

// A North American number as people write it: 4155551234, 415-555-1234,
// (415) 555-1234, +1 415 555 1234.
const PHONE_TEXT = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
// The separator between the service and the customer: "–", "—", "-" or ":".
const SEPARATOR = /\s+[–—-]\s+|:\s+/;

export function inferOwner(summary: string, description: string, services: readonly Service[]): InferredOwner | null {
  const match = PHONE_TEXT.exec(summary) ?? PHONE_TEXT.exec(description);
  const phone = match ? normalizePhone(match[0]) : null;
  if (!phone) {
    return null;
  }
  return { phone, name: nameFrom(summary), serviceId: serviceFrom(summary, services) };
}

// Staff write short names, so match on the name without its bracketed part,
// with "/" separating alternatives: "Full detail (interior + exterior)"
// matches "full detail", "Paint correction / ceramic coating" matches either.
// The longest match wins, so "interior detail & wash" beats "detail".
function serviceFrom(summary: string, services: readonly Service[]): string {
  const lower = summary.toLowerCase();
  const matches = services.flatMap((service) =>
    service.name
      .replace(/\(.*?\)/g, '')
      .split('/')
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias && lower.includes(alias))
      .map((alias) => ({ id: service.id, length: alias.length })),
  );
  matches.sort((a, b) => b.length - a.length);
  return matches[0]?.id ?? '';
}

// The part after the separator, without the number: "John" from
// "Interior detail & wash – John 415-555-1234".
function nameFrom(summary: string): string {
  const parts = summary.split(SEPARATOR);
  const after = parts.length > 1 ? (parts.at(-1) ?? '') : '';
  return after.replace(PHONE_TEXT, '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
}

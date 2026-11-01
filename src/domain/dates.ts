// Turns the dates callers actually say into calendar dates, so the model can
// pass "friday" through instead of working out which Friday that is. Small
// models get that arithmetic wrong surprisingly often.
import type { DateTime } from 'luxon';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Accepts YYYY-MM-DD, "today", "tomorrow", or a weekday name ("friday"),
// which means the next day with that name, counting today. Returns
// YYYY-MM-DD in the zone of `today`, or null if the input isn't one of those.
export function resolveDate(input: string, today: DateTime): string | null {
  const text = input.trim().toLowerCase();
  const start = today.startOf('day');

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  if (text === 'today') {
    return start.toISODate();
  }
  if (text === 'tomorrow') {
    return start.plus({ days: 1 }).toISODate();
  }
  const weekday = WEEKDAYS.indexOf(text) + 1;
  if (weekday > 0) {
    // Luxon weekdays run 1 (Monday) to 7 (Sunday).
    const daysAhead = (weekday - start.weekday + 7) % 7;
    return start.plus({ days: daysAhead }).toISODate();
  }
  return null;
}

// What resolveDate accepts, for tool descriptions and validation.
export const DATE_INPUT_PATTERN = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${WEEKDAYS.join('|')})$`, 'i');

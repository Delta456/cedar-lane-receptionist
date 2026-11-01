// Times the way a receptionist says them. Callers read, and later hear, the
// replies, so "16:30" should come out as "4:30 PM".
import { DateTime } from 'luxon';

// "18:00" becomes "6 PM" and "09:30" becomes "9:30 AM".
export function spokenTime(hhmm: string): string {
  const time = DateTime.fromFormat(hhmm, 'HH:mm');
  return time.toFormat(time.minute === 0 ? 'h a' : 'h:mm a');
}

// A clock time not already followed by AM or PM.
const CLOCK_TIME = /\b(\d{1,2}):([0-5]\d)\b(?!\s*[ap]\.?m\b)/gi;

// Rewrites the 24-hour times in a reply. The tools take 24-hour times, and
// the model sometimes says them that way too ("Moved you to Friday at
// 16:30"), even when the tool result gave it "4:30 PM". Only times that are
// clearly 24-hour change: a leading zero ("09:00") or an hour from 13 to 23.
// "10:30" or "4:30" are already how people say them, so they stay.
// An afternoon hour written 24-hour style and then given AM or PM, as in
// "13:00 PM": the model mixed the two formats in the bug hunt.
const MIXED_TIME = /\b(1[3-9]|2[0-3]):([0-5]\d)\s*[ap]\.?m\b/gi;

export function speakTimes(text: string): string {
  const unmixed = text.replace(MIXED_TIME, (_match, hourText: string, minutes: string) =>
    spokenTime(`${hourText}:${minutes}`),
  );
  return unmixed.replace(CLOCK_TIME, (match, hourText: string, minutes: string) => {
    const hour = Number(hourText);
    const clearly24Hour = (hourText.length === 2 && hourText.startsWith('0')) || (hour >= 13 && hour <= 23);
    return clearly24Hour ? spokenTime(`${hourText.padStart(2, '0')}:${minutes}`) : match;
  });
}

// Clock times in a text, as minutes after midnight: spoken ones ("3:30 PM",
// "9 am") and clearly 24-hour ones ("09:00", "16:30", as tools write them).
// A bare "10:30" could be morning or evening, so it's skipped; tool results
// carry a spoken label ("10:30 AM") as well.
const SPOKEN_TIME = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\b/gi;
const TWENTY_FOUR_HOUR = /\b(0\d|1[3-9]|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m\b)/gi;

export function clockMinutes(text: string): number[] {
  const minutes: number[] = [];
  for (const [, hourText, minuteText, half] of text.matchAll(SPOKEN_TIME)) {
    const hour = (Number(hourText) % 12) + (half?.toLowerCase() === 'p' ? 12 : 0);
    if (Number(hourText) <= 12) minutes.push(hour * 60 + Number(minuteText ?? 0));
  }
  for (const [, hourText, minuteText] of text.matchAll(TWENTY_FOUR_HOUR)) {
    minutes.push(Number(hourText) * 60 + Number(minuteText));
  }
  return minutes;
}

// Rewrites ISO dates in a reply ("2026-11-05") the way people say them
// ("Thursday, Nov 5"), with the year only when it isn't this year. Tools
// take ISO dates, and the model sometimes repeated one to the caller.
export function speakDates(text: string, thisYear: number): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year: string, month: string, day: string) => {
    const date = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day) });
    if (!date.isValid) return match;
    return date.toFormat(date.year === thisYear ? 'cccc, MMM d' : 'cccc, MMM d, yyyy');
  });
}

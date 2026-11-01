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
export function speakTimes(text: string): string {
  return text.replace(CLOCK_TIME, (match, hourText: string, minutes: string) => {
    const hour = Number(hourText);
    const clearly24Hour = (hourText.length === 2 && hourText.startsWith('0')) || (hour >= 13 && hour <= 23);
    return clearly24Hour ? spokenTime(`${hourText.padStart(2, '0')}:${minutes}`) : match;
  });
}

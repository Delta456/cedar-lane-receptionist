// Whether the first name a caller gives matches the one on a booking.
// Speech-to-text spells names its own way: on a test call it wrote "Sarah"
// for a booking under "Sara", and the caller couldn't have found it. So a
// one-letter difference still matches. The phone number must match as well,
// so this only forgives spelling; it doesn't let a different name through.

// The shorter name needs this many letters before a one-letter difference is
// forgiven, so "Al" doesn't match "Ed" or "Ali".
const MIN_LENGTH_FOR_TYPO = 3;

export function firstNamesMatch(given: string, onBooking: string): boolean {
  const a = given.toLowerCase();
  const b = onBooking.toLowerCase();
  if (a === b) {
    return true;
  }
  return Math.min(a.length, b.length) >= MIN_LENGTH_FOR_TYPO && oneEditApart(a, b);
}

// True if one letter added, removed or changed turns a into b.
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  // Skip the one difference: a changed letter if the lengths are equal, an
  // extra letter in the longer name if not. The rest must then be identical.
  return shorter.length === longer.length
    ? shorter.slice(i + 1) === longer.slice(i + 1)
    : shorter.slice(i) === longer.slice(i + 1);
}

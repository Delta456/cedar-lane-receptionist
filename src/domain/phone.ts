// Turns a phone number as typed or spoken into E.164 (+14155550190), so the
// same caller always matches the same contact and bookings. The shop is in the
// US, so a number without a country code is read as North American. A number
// with one ("plus nine one ...", "+44 ...", or caller ID like "+919811416685")
// is checked for its own country by libphonenumber-js. A test caller in India
// had their mobile number refused on every try when only North American
// numbers were accepted.
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const ONES: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  o: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS: Readonly<Record<string, number>> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 2,
  thirty: 3,
  forty: 4,
  fifty: 5,
  sixty: 6,
  seventy: 7,
  eighty: 8,
  ninety: 9,
};
const REPEATS: Readonly<Record<string, number>> = { double: 2, triple: 3 };

export function normalizePhone(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ');
  let digits = '';
  // "double five" means 55.
  let repeat = 1;
  // A "+" or the word "plus" before any digit means a country code follows.
  const firstDigit = input.search(/\d/);
  let international = input.slice(0, firstDigit === -1 ? input.length : firstDigit).includes('+');

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const one = ONES[token];
    const teen = TEENS[token];
    const ten = TENS[token];
    const repeats = REPEATS[token];

    if (token === 'plus' && digits === '') {
      international = true;
    } else if (/^\d+$/.test(token)) {
      digits += token.length === 1 ? token.repeat(repeat) : token;
      repeat = 1;
    } else if (repeats !== undefined) {
      repeat = repeats;
    } else if (one === 0 && digits === '' && !/^\d+$/.test(token)) {
      // A spoken "oh" before any digit is an interjection ("Oh, it's plus
      // nine one..."): no phone number starts with 0, and a country code
      // comes after "plus".
    } else if (one !== undefined) {
      digits += String(one).repeat(repeat);
      repeat = 1;
    } else if (teen !== undefined) {
      digits += String(teen);
    } else if (ten !== undefined) {
      // "ninety" is 90, "ninety one" is 91.
      const next = ONES[tokens[i + 1] ?? ''];
      if (next !== undefined && next !== 0) {
        digits += `${ten}${next}`;
        i++;
      } else {
        digits += `${ten}0`;
      }
    } else if (token === 'hundred') {
      // "eight hundred" is 800.
      digits += '00';
    }
    // Anything else ("my", "number", "is", "plus") is filler.
  }

  if (international) {
    const number = parsePhoneNumberFromString(`+${digits}`);
    return number?.isValid() ? number.number : null;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  // Area codes and exchanges never start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) {
    return null;
  }
  return `+1${digits}`;
}

// "+14155550190" becomes "(415) 555-0190".
export function formatPhone(e164: string): string {
  if (!e164.startsWith('+1')) {
    return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
  }
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

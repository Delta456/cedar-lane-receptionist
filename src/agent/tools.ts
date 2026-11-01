// The tools the agent can call. Each one is a thin wrapper over a service:
// the model picks a tool and fills in the inputs, and our code makes every
// decision. One Zod schema per tool gives both the JSON Schema the model sees
// and the runtime validation of what it sends back.
import { z } from 'zod';
import { shop } from '../config/shop.ts';
import { toSlotOption, type UnavailableReason } from '../domain/availability.ts';
import { DATE_INPUT_PATTERN } from '../domain/dates.ts';
import { normalizePhone } from '../domain/phone.ts';
import { spokenTime } from '../domain/spoken-time.ts';
import type { BookingResult, BookingService } from '../services/booking-service.ts';
import type { CallLogService } from '../services/call-log-service.ts';

export type Services = { bookings: BookingService; callLog: CallLogService };

// What the code knows about the current call, independent of the model.
export type CallState = {
  // The caller's number from the phone system (caller ID), when there is one.
  // Bookings are then only found and changed for this number, whatever number
  // the caller says.
  callerPhone: string | null;
  // Learned from successful tool calls. The call log uses these as facts,
  // over whatever the summary says.
  lastEventId: string | null;
  phone: string | null;
  name: string | null;
  // The contact saved when the caller booked, so the Sheet shows them during
  // the call. Resolves to the phone it was saved for, or null if saving
  // failed. The call log waits for it, so the call is counted once.
  contactSaved: Promise<string | null> | null;
  // Set by the conversation at the start of each turn. A booking change this
  // turn means the caller hasn't heard it confirmed yet, so end_call waits.
  changedThisTurn: boolean;
  // Set by end_call: the call ends once this turn's reply (the goodbye) is out.
  endRequested: boolean;
  // Set by request_callback: someone from the shop must call back. The call
  // log treats it as a fact, so the call is flagged for a human with a number
  // the code has checked.
  callback: { name: string; phone: string; reason: string } | null;
  // What the caller said this turn, set by the conversation. A phone number
  // in it is read by the code rather than taken from the model (see
  // ownerPhone).
  callerMessage: string;
};

export function newCallState(callerPhone: string | null = null): CallState {
  return {
    callerPhone,
    lastEventId: null,
    phone: callerPhone,
    name: null,
    contactSaved: null,
    changedThisTurn: false,
    endRequested: false,
    callback: null,
    callerMessage: '',
  };
}

export type ToolContext = { services: Services; call: CallState };

export type Tool = {
  name: string;
  description: string;
  // JSON Schema for the input, in the shape LLM function-calling APIs expect.
  parameters: Record<string, unknown>;
  // Validates the raw input, then runs the tool. Expected outcomes ("slot is
  // full", "missing field") come back as results the model can act on; only
  // unexpected failures (network, bugs) throw.
  execute(input: unknown, context: ToolContext): Promise<unknown>;
};

function defineTool<S extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>, context: ToolContext): Promise<unknown>;
}): Tool {
  // `$schema` is metadata the model APIs don't need.
  const { $schema: _, ...parameters } = z.toJSONSchema(definition.input);
  return {
    name: definition.name,
    description: definition.description,
    parameters,
    async execute(raw, context) {
      const parsed = definition.input.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: 'invalid_input',
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`),
        };
      }
      return explainInvalidPhone(await definition.run(parsed.data, context));
    },
  };
}

// Whether the caller's message says they're finishing the call. A "yes" at
// the start, as in "Yes please" to "Anything else?", means they want more,
// unless they also say goodbye or that's all.
const FINISHING =
  /\b(bye|goodbye|that's (all|it)|that is (all|it)|nothing else|no,? thanks|no,? thank you|i'm (done|good|all set)|thanks|thank you)\b/i;
const CLEAR_END = /\b(bye|goodbye|that's (all|it)|that is (all|it)|nothing else)\b/i;

export function soundsFinished(message: string): boolean {
  if (/^\W*(yes|yeah|yep|sure|ok yes)\b/i.test(message) && !CLEAR_END.test(message)) {
    return false;
  }
  return FINISHING.test(message);
}

// What to tell a caller whose phone number was refused. A bare
// "invalid_phone" left the agent repeating "that number seems invalid" to a
// caller in India, who had no way of knowing it needed a country code. The
// country code comes first: the model kept the start of a longer note and
// dropped the rest.
const PHONE_HELP =
  'That number was refused. Ask whether it\'s a US number: if not, they need to say the country code first, like "plus nine one" for India. Then ask for the whole number again, digit by digit.';

function explainInvalidPhone(result: unknown): unknown {
  const { reason, tellCaller } = (result ?? {}) as { reason?: unknown; tellCaller?: unknown };
  return reason === 'invalid_phone' && tellCaller === undefined
    ? { ...(result as object), tellCaller: PHONE_HELP }
    : result;
}

// Why a time can't be booked, in the caller's terms. The other reasons
// (unknown service, needs a quote, a malformed time) have no alternatives and
// are handled by other rules.
const WHY_UNAVAILABLE: Partial<Record<UnavailableReason, string>> = {
  booked: "it's already booked",
  in_past: 'that time has passed',
  closed: "we're closed that day",
  outside_hours: "it's outside our opening hours",
  not_on_slot: `appointments start every ${shop.slotMinutes} minutes`,
};

function unavailableMessage(time: string, why: string, alternatives: { label: string }[]): string {
  const offer = alternatives
    .slice(0, 2)
    .map((a) => a.label)
    .join(' or ');
  return `First say ${time} isn't available (${why}).${offer ? ` Then offer ${offer}.` : ''}`;
}

// Remembers what a successful booking action tells us about the call.
function remember(call: CallState, result: BookingResult): BookingResult {
  if (result.ok) {
    call.changedThisTurn = true;
    call.lastEventId = result.booking.eventId;
    call.phone ??= result.booking.phone;
    call.name ??= result.booking.name || null;
  }
  return result;
}

// The caller's number, most trusted source first: caller ID; then a complete
// number in what the caller said this turn, read by the code; then whatever
// the model passed. The model converts spoken digits itself and got them
// wrong: given "six five oh, five five five, oh one four two" after an
// earlier fragment, it passed an 11-digit merge of the two.
function ownerPhone(given: string, call: CallState): string {
  return call.callerPhone ?? normalizePhone(call.callerMessage) ?? given;
}

// Without caller ID, a number alone doesn't prove who's calling, so finding
// or changing a booking also needs the name on it. Returns the name to check,
// undefined when caller ID makes it unnecessary, or null when it's missing.
function verifyingName(given: string | null, call: CallState): string | undefined | null {
  if (call.callerPhone) {
    return undefined;
  }
  return given?.trim() ? given.trim() : null;
}

const NAME_REQUIRED = {
  ok: false,
  reason: 'name_required',
  tellCaller: 'Ask for the name the booking is under.',
} as const;

// Inputs are strict objects (no unknown keys). Fields are required unless
// leaving them out has an obvious meaning, like reschedule's serviceId (keep
// the same service).
//
// Formats are checked here so a slip like "3:30" comes back to the model as
// a clear instruction. AM or PM is never guessed.
const date = z
  .string()
  .regex(DATE_INPUT_PATTERN, 'use YYYY-MM-DD, "today", "tomorrow", or a weekday name like "friday"')
  .describe(
    'Local date: YYYY-MM-DD, or "today", "tomorrow", or a weekday name like "friday" (the next one). ' +
      'Prefer the weekday name when the caller says one; the result has the exact date.',
  );
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:MM, e.g. 15:30 for 3:30 PM')
  .describe('Local time, 24-hour HH:MM, e.g. 15:30 for 3:30 PM.');
const phone = z.string().describe('Phone number as the caller gave it.');
// The model asked a caller for "the event ID": callers never know it.
const eventId = z
  .string()
  .describe("eventId from find_bookings. Callers don't know it: never ask them for it; call find_bookings first.");
const callerName = z.string().nullable().describe("The caller's name as they gave it, or null if they haven't.");
const serviceId = z.enum(shop.services.map((s) => s.id)).describe('Service id from the shop information.');

export const tools: readonly Tool[] = [
  defineTool({
    name: 'check_availability',
    description:
      'Check whether a service can be booked at a date and time. Returns available: true, or the reason it is not and the nearest open alternatives.',
    input: z.strictObject({ serviceId, date, time }),
    async run(input, { services }) {
      const result = await services.bookings.checkAvailability(input);
      if (result.available) {
        return { available: true, slot: toSlotOption(result.slot) };
      }
      const alternatives = result.alternatives.map((s) => toSlotOption(s));
      const why = WHY_UNAVAILABLE[result.reason];
      return {
        available: false,
        reason: result.reason,
        alternatives,
        // Given only the alternatives, the model often listed them without
        // saying the time asked for was taken, and the caller had to ask why.
        ...(why && { tellCaller: unavailableMessage(spokenTime(input.time), why, alternatives) }),
      };
    },
  }),

  defineTool({
    name: 'find_open_times',
    description:
      'List open times for a service on a day, for questions like "what\'s open Thursday?". If that day is closed or full, returns the next day with openings; `date` says which day the times are on.',
    input: z.strictObject({ serviceId, date }),
    async run(input, { services }) {
      const result = await services.bookings.findOpenTimes(input);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        date: result.date,
        movedToAnotherDay: result.date !== result.requestedDate,
        openTimes: result.slots.map((s) => toSlotOption(s)),
        // The list is a spread, not every open time; say so where the model
        // will see it when the caller picks a time.
        note: 'These are examples. Other times may be open too: if the caller asks for a time not listed, check that exact time with check_availability.',
      };
    },
  }),

  defineTool({
    name: 'book_appointment',
    description: 'Book a service. Re-checks availability first, so it can still fail with alternatives.',
    input: z.strictObject({ serviceId, date, time, name: z.string().describe("Caller's name."), phone }),
    async run(input, { services, call }) {
      // With caller ID the booking belongs to the calling number, like every
      // other booking action, or the caller couldn't find it next time.
      const result = remember(call, await services.bookings.book({ ...input, phone: ownerPhone(input.phone, call) }));
      if (!result.ok) {
        return result;
      }
      // Once per call, and in the background, so the reply doesn't wait on
      // the Sheet.
      if (!call.contactSaved) {
        call.contactSaved = services.callLog.saveContact(result.booking.phone, result.booking.name);
      }
      return result;
    },
  }),

  defineTool({
    name: 'find_bookings',
    description: "List the caller's upcoming bookings, by their phone number and the name the bookings are under.",
    input: z.strictObject({ phone, name: callerName }),
    async run(input, { services, call }) {
      const name = verifyingName(input.name, call);
      if (name === null) {
        return NAME_REQUIRED;
      }
      const result = await services.bookings.find(ownerPhone(input.phone, call), name);
      if (!result.ok || result.bookings.length === 0) {
        return result;
      }
      return {
        ok: true,
        // Only the spoken time: given a 24-hour "16:30" as well, the model read
        // it out to the caller.
        bookings: result.bookings.map(({ eventId, serviceId, service, when }) => ({
          eventId,
          serviceId,
          service,
          when,
        })),
        // When a caller asked to reschedule, the model asked "what day and
        // time?" instead of offering times, and "which service?" when they
        // asked what was open.
        note: "If the caller wants to move a booking but hasn't named a time, offer two or three open times rather than asking: call find_open_times with that booking's serviceId and the day they mention, or 'today' for the soonest. If they name a time, check that time with check_availability. Never ask which service.",
      };
    },
  }),

  defineTool({
    name: 'reschedule_appointment',
    description: 'Move an existing booking to a new date and time, optionally changing the service.',
    input: z.strictObject({
      eventId,
      phone,
      date,
      time,
      name: callerName,
      serviceId: serviceId.nullable().optional().describe('New service id. Leave out to keep the same service.'),
    }),
    async run(input, { services, call }) {
      const name = verifyingName(input.name, call);
      if (name === null) {
        return NAME_REQUIRED;
      }
      return remember(
        call,
        await services.bookings.reschedule({
          eventId: input.eventId,
          phone: ownerPhone(input.phone, call),
          date: input.date,
          time: input.time,
          serviceId: input.serviceId ?? undefined,
          callerName: name,
        }),
      );
    },
  }),

  defineTool({
    name: 'cancel_appointment',
    description: 'Cancel an existing booking.',
    input: z.strictObject({ eventId, phone, name: callerName }),
    async run(input, { services, call }) {
      const name = verifyingName(input.name, call);
      if (name === null) {
        return NAME_REQUIRED;
      }
      return remember(
        call,
        await services.bookings.cancel({
          eventId: input.eventId,
          phone: ownerPhone(input.phone, call),
          callerName: name,
        }),
      );
    },
  }),

  defineTool({
    name: 'mark_running_late',
    description:
      "Note on the caller's booking today that they're running late. Finds the booking from their phone number and name, so there's no need to call find_bookings first. Returns whether they are within the grace period.",
    input: z.strictObject({
      phone,
      name: callerName,
      minutesLate: z.number().int().min(0).describe('How many minutes late they expect to be.'),
    }),
    async run(input, { services, call }) {
      const name = verifyingName(input.name, call);
      if (name === null) {
        return NAME_REQUIRED;
      }
      const result = await services.bookings.markRunningLate({
        phone: ownerPhone(input.phone, call),
        callerName: name,
        minutesLate: input.minutesLate,
      });
      if (!result.ok) {
        return result.reason === 'no_booking_today'
          ? {
              ...result,
              tellCaller:
                "There's no booking today under that number and name. Ask if it's under a different number or name.",
            }
          : result;
      }
      remember(call, { ok: true, booking: result.booking });
      // Spelled out, because small models act on instructions more reliably
      // than on a bare flag.
      const minutes = result.gracePeriodMinutes;
      return {
        ...result,
        tellCaller: result.withinGracePeriod
          ? `No problem: we hold the slot for ${minutes} minutes, so they're fine.`
          : `We only hold the slot for ${minutes} minutes, so it may not be kept. Offer to reschedule.`,
      };
    },
  }),

  defineTool({
    name: 'request_callback',
    description:
      'Ask someone from the shop to call the caller back, for anything handed to a human (a charge complaint, refund, damage claim, custom quote, or wanting a person). Checks that the phone number is complete.',
    input: z.strictObject({
      name: z.string().describe("Caller's name."),
      phone,
      reason: z.string().describe('What the shop should call back about, in a few words.'),
    }),
    async run(input, { call }) {
      // On a call, the caller's number came in pieces once ("seven nine seven
      // seven five") and the agent promised a callback on it. A callback is
      // only useful on a number the shop can dial, so the code checks it.
      const callbackPhone = normalizePhone(ownerPhone(input.phone, call));
      if (!callbackPhone) {
        return { ok: false, reason: 'invalid_phone' };
      }
      const name = input.name.trim();
      if (!name) {
        return { ok: false, reason: 'missing_name', tellCaller: 'Ask for their name.' };
      }
      call.callback = { name, phone: callbackPhone, reason: input.reason.trim() };
      call.phone ??= callbackPhone;
      call.name ??= name;
      return {
        ok: true,
        tellCaller: `Tell them someone from the shop will call them back on the number ending in ${callbackPhone.slice(-4)}.`,
      };
    },
  }),

  defineTool({
    name: 'end_call',
    description:
      "Hang up, once the caller has said they're done and has nothing else. Then say a short goodbye: the call ends after your reply.",
    input: z.strictObject({}),
    async run(_input, { call }) {
      // A change made this turn hasn't been confirmed to the caller yet, and
      // they may want something else; hanging up now would cut them off.
      if (call.changedThisTurn) {
        return {
          ok: false,
          reason: 'too_soon',
          tellCaller: "Tell the caller what was just done and ask if there's anything else. Don't hang up yet.",
        };
      }
      // Only hang up when the caller's own words say they're finishing. Asked
      // "Anything else?", a caller said "Yes please." and the agent hung up.
      if (!soundsFinished(call.callerMessage)) {
        return {
          ok: false,
          reason: 'caller_not_done',
          tellCaller: "The caller hasn't said they're done. Ask what else you can help with; don't hang up.",
        };
      }
      call.endRequested = true;
      return { ok: true, note: 'Now say a short, friendly goodbye. The call ends after your reply.' };
    },
  }),

  defineTool({
    name: 'lookup_caller',
    description:
      'Look up a returning caller, to greet them by name. Only works when the phone system shows their number.',
    input: z.strictObject({}),
    async run(_input, { services, call }) {
      // Only the number the phone system reports. Looking up a number the
      // caller typed would tell anyone whose number it is, and hand them the
      // name that the booking checks rely on.
      if (!call.callerPhone) {
        return { found: false, reason: 'no_caller_id' };
      }
      const contact = await services.callLog.lookupContact(call.callerPhone);
      return contact ? { found: true, name: contact.name, totalCalls: contact.totalCalls } : { found: false };
    },
  }),
];

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

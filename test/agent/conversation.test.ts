import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DateTime } from 'luxon';
import type OpenAI from 'openai';
import { Conversation } from '../../src/agent/conversation.ts';
import { shop } from '../../src/config/shop.ts';
import { BookingService } from '../../src/services/booking-service.ts';
import { CallLogService } from '../../src/services/call-log-service.ts';
import { FakeCalendarStore, FakeCallLogStore } from '../support/fake-stores.ts';

// `args` is sent as JSON; `rawArgs` is sent as-is, to simulate broken output.
type ScriptedCall = { name: string; args?: unknown; rawArgs?: string };
type Reply = { content?: string; toolCalls?: ScriptedCall[] } | Error;

// A model that gives scripted replies, one per request, and records requests.
function scriptedModel(replies: Reply[]) {
  const requests: OpenAI.Chat.Completions.ChatCompletionCreateParams[] = [];
  let id = 0;
  const llm = {
    chat: {
      completions: {
        async create(params: OpenAI.Chat.Completions.ChatCompletionCreateParams) {
          requests.push(structuredClone(params));
          const reply = replies.shift() ?? { content: 'OK.' };
          if (reply instanceof Error) {
            throw reply;
          }
          const tool_calls = reply.toolCalls?.map((c) => ({
            id: `call-${++id}`,
            type: 'function' as const,
            function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) },
          }));
          return { choices: [{ message: { role: 'assistant', content: reply.content ?? null, tool_calls } }] };
        },
      },
    },
  };
  return { llm: llm as unknown as OpenAI, requests };
}

let callStore: FakeCallLogStore;
let calendar: FakeCalendarStore;

function conversation(replies: Reply[], callerPhone: string | null = null) {
  const channel = callerPhone ? 'voice' : 'chat';
  const now = () => DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  const model = scriptedModel(replies);
  const services = {
    bookings: new BookingService({ calendar, now }),
    callLog: new CallLogService({ store: callStore, now }),
  };
  return {
    ...model,
    conversation: new Conversation({ llm: model.llm, model: 'test', services, now, channel, callerPhone }),
  };
}

beforeEach(() => {
  callStore = new FakeCallLogStore();
  calendar = new FakeCalendarStore();
});

test('runs a tool, sends the result back, and returns the reply', async () => {
  const { conversation: c, requests } = conversation([
    {
      toolCalls: [
        { name: 'check_availability', args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00' } },
      ],
    },
    { content: 'Yes, 10 is open.' },
  ]);
  const turn = await c.send('Is Thursday at 10 open for a wash?');

  assert.equal(turn.reply, 'Yes, 10 is open.');
  assert.equal(turn.toolCalls[0]?.name, 'check_availability');
  // The second request carries the tool result, matched to the call by id.
  const last = requests[1]?.messages.at(-1);
  assert.equal(last?.role, 'tool');
  assert.match(String(last?.content), /"available":true/);
});

test('tool arguments that are not JSON go back to the model as an error', async () => {
  const { conversation: c, requests } = conversation([
    { toolCalls: [{ name: 'find_bookings', rawArgs: '{oops' }] },
    { content: 'Sorry, what was your number?' },
  ]);
  const turn = await c.send('Find my booking please.');

  const result = turn.toolCalls[0]?.result as { reason?: string } | undefined;
  assert.equal(result?.reason, 'invalid_input');
  // The model is told, and gets to try again.
  assert.match(String(requests[1]?.messages.at(-1)?.content), /not valid JSON/);
  assert.equal(turn.reply, 'Sorry, what was your number?');
});

const summaryOf = (args: Record<string, unknown>) => ({ toolCalls: [{ name: 'record_call', args }] });
const goodSummary = {
  intent: 'question',
  summary: 'Asked about prices.',
  outcome: 'Answered.',
  needsHuman: false,
  name: null,
  phone: null,
};

test('end() summarises the call from the transcript and logs it once', async () => {
  const { conversation: c, requests } = conversation([{ content: 'A full detail is $250.' }, summaryOf(goodSummary)]);
  await c.send('How much is a full detail?');
  const end = await c.end();

  assert.equal(callStore.calls.length, 1);
  assert.equal(callStore.calls[0]?.summary, 'Asked about prices.');
  assert.equal(end.toolCalls[0]?.name, 'log_call');
  // The summary request is separate, and reads the transcript.
  const summaryRequest = JSON.stringify(requests[1]?.messages);
  assert.match(summaryRequest, /Caller: How much is a full detail\?/);
  assert.match(summaryRequest, /Receptionist: A full detail is \$250\./);
});

test('a contact saved at booking is in the Sheet before the call ends, and counted once', async () => {
  const { conversation: c } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    { content: 'Booked you in for Thursday at 10. Anything else?' },
    summaryOf(goodSummary),
  ]);
  await c.send('Book a wash Thursday at 10, Sara, 415-555-0190');
  // Let the background save finish.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callStore.contacts.get('+14155550190')?.totalCalls, 1);
  assert.equal(callStore.calls.length, 0);

  await c.end();
  assert.equal(callStore.calls.length, 1);
  assert.equal(callStore.contacts.get('+14155550190')?.totalCalls, 1);
});

test("the booking's phone number wins over a different one in the summary", async () => {
  const { conversation: c } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    { content: 'Booked you in. Anything else?' },
    summaryOf({ ...goodSummary, intent: 'booking', phone: '415-555-0910', name: 'Sara' }),
  ]);
  await c.send('Wash Thursday at 10, Sara, 415-555-0190.');
  await c.end();

  assert.equal(callStore.calls[0]?.phone, '+14155550190');
  assert.equal(callStore.contacts.size, 1);
  assert.equal(callStore.contacts.get('+14155550190')?.totalCalls, 1);
});

test('a requested callback flags the call for a human, even if the summary says otherwise', async () => {
  const { conversation: c } = conversation([
    { toolCalls: [{ name: 'request_callback', args: { name: 'Mike', phone: '650-555-0142', reason: 'refund' } }] },
    { content: 'Someone will call you back on the number ending in 0142.' },
    summaryOf({ ...goodSummary, needsHuman: false }),
  ]);
  await c.send("I want a refund. It's Mike, 650-555-0142.");
  await c.end();
  assert.equal(callStore.calls[0]?.needsHuman, true);
  assert.equal(callStore.calls[0]?.phone, '+16505550142');
  // Staff see what to call back about, from the tool call.
  assert.match(callStore.calls[0]?.outcome ?? '', /Callback requested: refund\./);
});

test('what the code saw wins over the summary', async () => {
  const { conversation: c } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: {
            serviceId: 'exterior-wash',
            date: '2026-11-05',
            time: '10:00',
            name: 'Sara',
            phone: '415-555-0190',
          },
        },
      ],
    },
    { content: 'Booked you in. Anything else?' },
    summaryOf({ ...goodSummary, intent: 'booking', phone: null, name: null }),
  ]);
  await c.send('Wash Thursday at 10, Sara, 415-555-0190.');
  await c.end();

  const call = callStore.calls[0];
  const [event] = calendar.events.values();
  assert.equal(call?.eventId, event?.id);
  assert.equal(call?.phone, '+14155550190');
  assert.equal(call?.name, 'Sara');
});

test('if the summary is invalid, the call is still logged and flagged for a human', async () => {
  const { conversation: c } = conversation([
    { content: 'Sure, what day?' },
    summaryOf({ intent: 'nonsense' }),
    summaryOf({ summary: '' }),
  ]);
  await c.send("I'd like to book a wash.");
  await c.end();

  const call = callStore.calls[0];
  assert.equal(callStore.calls.length, 1);
  assert.equal(call?.needsHuman, true);
  assert.match(call?.summary ?? '', /I'd like to book a wash/);
});

test('if the model is down at the end, the call is still logged', async () => {
  const { conversation: c } = conversation([{ content: 'Hello!' }, new Error('model unavailable')]);
  await c.send('Hi');
  await c.end();
  assert.equal(callStore.calls.length, 1);
  assert.equal(callStore.calls[0]?.needsHuman, true);
});

test('end() logs only once, and not at all for a call where nothing was said', async () => {
  const { conversation: c, requests } = conversation([{ content: 'Hi.' }, summaryOf(goodSummary)]);
  await c.send('Hello');
  await Promise.all([c.end(), c.end()]);
  assert.equal(callStore.calls.length, 1);
  assert.equal(requests.length, 2);

  const silent = conversation([]);
  await silent.conversation.end();
  assert.equal(callStore.calls.length, 1);
  assert.equal(silent.requests.length, 0);
});

test('a 24-hour time in a reply reaches the caller, and the history, as spoken time', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'We have Friday at 16:30 open.' },
    { content: 'Sure.' },
  ]);
  const turn = await c.send('Anything Friday afternoon?');
  assert.equal(turn.reply, 'We have Friday at 4:30 PM open.');
  await c.send('Great.');
  assert.match(JSON.stringify(requests[1]?.messages), /Friday at 4:30 PM open/);
});

test('the agent can hang up after its goodbye, and the turn says the call ended', async () => {
  const { conversation: c } = conversation([
    { toolCalls: [{ name: 'end_call', args: {} }] },
    { content: 'Thanks for calling, bye!' },
  ]);
  const turn = await c.send("That's all, bye.");
  assert.equal(turn.reply, 'Thanks for calling, bye!');
  assert.equal(turn.ended, true);
});

test('hanging up without a goodbye still says one', async () => {
  const { conversation: c } = conversation([
    { toolCalls: [{ name: 'end_call', args: {} }] },
    { content: '' },
    { content: '' },
    { content: '' },
  ]);
  const turn = await c.send('Bye.');
  assert.match(turn.reply, /Goodbye/);
  assert.equal(turn.ended, true);
});

test("the agent can't hang up in the turn it changed a booking", async () => {
  const { conversation: c } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
        { name: 'end_call', args: {} },
      ],
    },
    { content: 'Booked you in for Thursday at 10. Anything else?' },
  ]);
  const turn = await c.send('Book a wash Thursday at 10, Sara, 415-555-0190, then bye.');
  assert.equal(turn.ended, false);
});

test("hanging up first and then booking in the same response still doesn't end the call", async () => {
  const { conversation: c } = conversation([
    {
      toolCalls: [
        { name: 'end_call', args: {} },
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    { content: 'Booked you in for Thursday at 10. Anything else?' },
  ]);
  const turn = await c.send('Book a wash Thursday at 10, Sara, 415-555-0190.');
  assert.equal(turn.ended, false);
});

test('onToolStart is told the tool names once, before the tools run, and not on a plain reply', async () => {
  const { conversation: c } = conversation([
    { toolCalls: [{ name: 'find_open_times', args: { serviceId: 'exterior-wash', date: 'thursday' } }] },
    { content: 'We have 9 AM or 10:30.' },
    { content: 'We close at 6.' },
  ]);
  const seen: string[][] = [];
  const onToolStart = (names: string[]) => {
    // Nothing has been booked or looked up yet when the hook runs.
    assert.equal(calendar.events.size, 0);
    seen.push(names);
  };
  await c.send("What's open Thursday?", { onToolStart });
  await c.send('When do you close?', { onToolStart });
  assert.deepEqual(seen, [['find_open_times']]);
});

test("on a call with caller ID, the agent is told the caller's number", async () => {
  const { conversation: c, requests } = conversation([{ content: 'Sure, what name?' }], '+14155550190');
  await c.send('Can I book a wash?');
  assert.match(JSON.stringify(requests[0]?.messages[0]), /ending in 0190/);
});

test('saying the caller is noted as late, with no running-late note made, is sent back once', async () => {
  calendar.add({
    summary: 'Exterior wash – Sara',
    description: '',
    start: DateTime.fromISO('2026-10-31T13:00', { zone: shop.timezone }),
    end: DateTime.fromISO('2026-10-31T13:30', { zone: shop.timezone }),
    busy: true,
    owner: { phone: '+14155550190', name: 'Sara', serviceId: 'exterior-wash' },
  });
  const { conversation: c, requests } = conversation([
    { content: 'I will mark you as running late for today.' },
    { toolCalls: [{ name: 'mark_running_late', args: { phone: '415-555-0190', name: 'Sara', minutesLate: 10 } }] },
    { content: "Done, we hold the slot for 15 minutes, so you're fine." },
  ]);
  const turn = await c.send("It's Sara, 415-555-0190, I'm 10 minutes late.");
  assert.equal(turn.reply, "Done, we hold the slot for 15 minutes, so you're fine.");
  assert.match(JSON.stringify(requests[1]?.messages), /mark_running_late hasn't succeeded/);
  const [event] = calendar.events.values();
  assert.match(event?.description ?? '', /Running late: about 10 min/);
});

test("once the running-late note is made, saying so later isn't questioned", async () => {
  calendar.add({
    summary: 'Exterior wash – Sara',
    description: '',
    start: DateTime.fromISO('2026-10-31T13:00', { zone: shop.timezone }),
    end: DateTime.fromISO('2026-10-31T13:30', { zone: shop.timezone }),
    busy: true,
    owner: { phone: '+14155550190', name: 'Sara', serviceId: 'exterior-wash' },
  });
  const { conversation: c, requests } = conversation([
    { toolCalls: [{ name: 'mark_running_late', args: { phone: '415-555-0190', name: 'Sara', minutesLate: 10 } }] },
    { content: "You're fine, we hold the slot for 15 minutes." },
    { content: "Yes, I've noted that you're running late. Anything else?" },
  ]);
  await c.send("It's Sara, 415-555-0190, I'm 10 minutes late.");
  const turn = await c.send('Did you note it?');
  assert.equal(turn.reply, "Yes, I've noted that you're running late. Anything else?");
  assert.equal(requests.length, 3);
});

test('an ordinary turn does not end the call', async () => {
  const { conversation: c } = conversation([{ content: 'We close at 6.' }]);
  assert.equal((await c.send('When do you close?')).ended, false);
});

test('an empty model response is retried once', async () => {
  const { conversation: c, requests } = conversation([{ content: '' }, { content: 'Hi, how can I help?' }]);
  const turn = await c.send('Hello?');
  assert.equal(turn.reply, 'Hi, how can I help?');
  assert.equal(requests.length, 2);
});

test('a tool call written as text is never shown to the caller, and is retried', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'book_appointment(serviceId="exterior-wash", date="monday", time="09:00")' },
    { content: 'What name should I put the booking under?' },
  ]);
  const turn = await c.send('Monday at 9 please.');
  assert.equal(turn.reply, 'What name should I put the booking under?');
  assert.equal(requests.length, 2);
  // The bad response isn't kept in the history either.
  assert.doesNotMatch(JSON.stringify(requests[1]?.messages), /book_appointment\(/);
});

test('if every attempt writes a tool call as text, the caller gets the safe fallback', async () => {
  const textCall = { content: 'check_availability(serviceId="exterior-wash")' };
  const { conversation: c } = conversation([textCall, textCall, textCall]);
  const turn = await c.send('Is Thursday open?');
  assert.match(turn.reply, /trouble with our system/);
  assert.doesNotMatch(turn.reply, /check_availability/);
});

test('ordinary replies that mention a tool-like word are not mistaken for calls', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'Sure, I can check availability for you (it only takes a second).' },
  ]);
  const turn = await c.send('Can you check?');
  assert.match(turn.reply, /check availability/);
  assert.equal(requests.length, 1);
});

test('a call written in template syntax is recovered and run', async () => {
  const { conversation: c } = conversation([
    {
      content: 'check_availability{serviceId:<|"|>exterior-wash<|"|>,date:<|"|>2026-11-05<|"|>,time:<|"|>10:00<|"|>}',
    },
    { content: 'Yes, 10 is open.' },
  ]);
  const turn = await c.send('Is Thursday at 10 open for a wash?');
  assert.equal(turn.toolCalls[0]?.name, 'check_availability');
  const result = turn.toolCalls[0]?.result as { available?: boolean } | undefined;
  assert.equal(result?.available, true);
  assert.equal(turn.reply, 'Yes, 10 is open.');
});

test('a claimed booking change with no tool behind it is sent back for correction', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'Moved you to Friday at 11. Anything else?' },
    { content: 'Sorry, should I move it to Friday at 11?' },
  ]);
  const turn = await c.send('Can we do Friday at 11 instead?');
  assert.equal(turn.reply, 'Sorry, should I move it to Friday at 11?');
  assert.match(String(requests[1]?.messages.at(-1)?.content), /no booking tool succeeded/);
});

test('a claim backed by a successful booking goes straight through', async () => {
  const { conversation: c, requests } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    { content: 'Booked you in for Thursday at 10. Anything else?' },
  ]);
  const turn = await c.send('Sara, 415-555-0190.');
  assert.match(turn.reply, /Booked you in/);
  assert.equal(requests.length, 2);
});

test('confirming an existing booking is not treated as a false claim', async () => {
  calendar.add({
    summary: 'Exterior wash – Sara',
    description: '',
    start: DateTime.fromISO('2026-11-05T10:00', { zone: shop.timezone }),
    end: DateTime.fromISO('2026-11-05T10:30', { zone: shop.timezone }),
    busy: true,
    owner: { phone: '+14155550190', name: 'Sara', serviceId: 'exterior-wash' },
  });
  const { conversation: c, requests } = conversation([
    { toolCalls: [{ name: 'find_bookings', args: { phone: '415-555-0190', name: 'Sara' } }] },
    { content: "Yes, you're booked for Thursday at 10." },
  ]);
  const turn = await c.send('Am I booked for Thursday? 415-555-0190.');
  assert.match(turn.reply, /you're booked/);
  assert.equal(requests.length, 2);
});

test('the correction is asked for at most once per turn', async () => {
  const claim = { content: "That's cancelled. Anything else?" };
  const { conversation: c, requests } = conversation([claim, claim]);
  const turn = await c.send('Cancel it.');
  assert.equal(requests.length, 2);
  assert.match(turn.reply, /cancelled/);
});

test('the call log never claims a booking when no booking tool made one', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'Thursday at 9 is open. Want it?' },
    summaryOf({ ...goodSummary, intent: 'booking', outcome: 'Booked Thursday at 9 AM' }),
  ]);
  await c.send("What's open Thursday?");
  await c.end();

  assert.equal(callStore.calls[0]?.outcome, 'No booking was made or changed.');
  // The summary model was also told so.
  assert.match(JSON.stringify(requests[1]?.messages), /No booking was created, moved or cancelled/);
});

test('if the model fails after a booking, the caller gets a confirmation, not an error', async () => {
  const { conversation: c, requests } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    new Error('model unavailable'),
    { content: 'Sure, what else can I help with?' },
  ]);
  const turn = await c.send('Wash Thursday at 10, Sara, 415-555-0190.');
  assert.match(turn.reply, /You're booked for exterior wash on Thursday, Nov 5 at 10:00 AM\./);
  assert.equal(calendar.events.size, 1);

  // The next turn continues from a valid history that includes what was said.
  const next = await c.send('Thanks.');
  assert.equal(next.reply, 'Sure, what else can I help with?');
  const history = requests.at(-1)?.messages ?? [];
  assert.equal(history.at(-2)?.role, 'assistant');
  assert.match(String(history.at(-2)?.content), /You're booked/);
});

test('if the model fails before anything happened, the caller gets the polite fallback', async () => {
  const { conversation: c } = conversation([new Error('model unavailable')]);
  const turn = await c.send('Hello?');
  assert.match(turn.reply, /trouble with our system/);
});

test('an unusual claim wording is checked by the model and sent back for correction', async () => {
  const { conversation: c, requests } = conversation([
    { content: "We've got you down for Friday at 11." },
    { toolCalls: [{ name: 'verdict', args: { claimsChange: true } }] },
    { content: 'Sorry, shall I move your booking to Friday at 11?' },
  ]);
  const turn = await c.send('Can we do Friday at 11?');
  assert.equal(turn.reply, 'Sorry, shall I move your booking to Friday at 11?');
  // The second request is the claim check; the third carries the correction.
  assert.match(JSON.stringify(requests[1]?.messages), /got you down for Friday/);
  assert.match(String(requests[2]?.messages.at(-1)?.content), /no booking tool succeeded/);
});

test('an offer that only sounds like a claim goes through once the model says so', async () => {
  const { conversation: c, requests } = conversation([
    { content: 'Thursday at 10 is open. Should I get that booked for you?' },
    { toolCalls: [{ name: 'verdict', args: { claimsChange: false } }] },
  ]);
  const turn = await c.send('Is Thursday at 10 open?');
  assert.match(turn.reply, /Should I get that booked/);
  assert.equal(requests.length, 2);
});

test('a false claim later in a call is still caught after an earlier booking', async () => {
  const { conversation: c, requests } = conversation([
    {
      toolCalls: [
        {
          name: 'book_appointment',
          args: { serviceId: 'exterior-wash', date: '2026-11-05', time: '10:00', name: 'Sara', phone: '415-555-0190' },
        },
      ],
    },
    { content: 'Booked you in for Thursday at 10. Anything else?' },
    // Next turn: claims a move that never happened.
    { content: 'Moved you to Friday at 11. Anything else?' },
    { content: 'Shall I move your Thursday booking to Friday at 11?' },
  ]);
  await c.send('Wash Thursday at 10, Sara, 415-555-0190.');
  const turn = await c.send('Can we make it Friday at 11 instead?');

  assert.equal(turn.reply, 'Shall I move your Thursday booking to Friday at 11?');
  // The correction lists what was really done earlier, so a repeat can stand.
  const note = String(requests.at(-1)?.messages.at(-1)?.content);
  assert.match(note, /no booking tool succeeded/);
  assert.match(note, /Done earlier in this call: You're booked for exterior wash on Thursday, Nov 5 at 10:00 AM\./);
});

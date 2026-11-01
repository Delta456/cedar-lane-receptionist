import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { buildSystemPrompt } from '../../src/agent/prompt.ts';
import { shop } from '../../src/config/shop.ts';

const prompt = buildSystemPrompt(DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone }));

test('opening hours are written the way a receptionist says them', () => {
  assert.match(prompt, /- Saturday: 9 AM-6 PM/);
  assert.match(prompt, /- Sunday: closed/);
  assert.doesNotMatch(prompt, /18:00/);
});

test('every price and the quote-only service come from the config', () => {
  for (const service of shop.services) {
    assert.ok(prompt.includes(service.id), service.id);
    if (service.priceUsd !== null) assert.ok(prompt.includes(`$${service.priceUsd}`), service.name);
  }
  assert.match(prompt, /paint correction \/ ceramic coating is quoted individually/);
});

test('the date table maps weekday names to the right dates', () => {
  assert.match(prompt, /Saturday, Oct 31 \(today\): 2026-10-31/);
  assert.match(prompt, /Thursday, Nov 5: 2026-11-05/);
});

test('every FAQ answer is in the prompt, and an empty FAQ adds no heading', () => {
  for (const { question, answer } of shop.faq) {
    assert.ok(prompt.includes(question), question);
    assert.ok(prompt.includes(answer), answer);
  }
  const withoutFaq = buildSystemPrompt(DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone }), {
    ...shop,
    faq: [],
  });
  assert.doesNotMatch(withoutFaq, /Other questions:/);
});

test('with caller ID, the agent confirms the number it has instead of asking for it', () => {
  const at = DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  const withCallerId = buildSystemPrompt(at, shop, { channel: 'voice', callerPhone: '+14155550190' });
  assert.match(withCallerId, /calling from \(415\) 555-0190: never ask for their phone number/);
  assert.match(withCallerId, /ending in 0190/);
  assert.doesNotMatch(withCallerId, /the caller's name and a phone number/);
  assert.match(withCallerId, /Booked you in for Thursday at 4:30, under the number ending in 0190/);
  // No other rule asks for the number either: changing, running late, handoffs.
  assert.doesNotMatch(withCallerId, /caller's phone number|with their phone number|their name and number/);
  assert.match(withCallerId, /mark_running_late with the number they're calling from/);
  // Without caller ID, or with one that isn't a usable number, it asks for the number.
  assert.match(prompt, /the caller's name and a phone number/);
  assert.match(prompt, /you need the caller's phone number and the name the booking is under/);
  assert.match(
    buildSystemPrompt(at, shop, { channel: 'voice', callerPhone: 'anonymous' }),
    /the caller's name and a phone number/,
  );
});

test('the chat prompt has no phone-call rules; a call adds them', () => {
  const at = DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  assert.doesNotMatch(prompt, /# On the phone|speech-to-text|spoken aloud/);
  const call = buildSystemPrompt(at, shop, { channel: 'voice' });
  assert.match(call, /# On the phone/);
  assert.match(call, /speech-to-text/);
  // Everything else is shared: the call prompt is the chat prompt plus that section.
  assert.equal(call.replace(/\n# On the phone\n[\s\S]*?\n(?=\n# Shop information)/, ''), prompt);
});

test('caller ID only counts on a phone call', () => {
  const at = DateTime.fromISO('2026-10-31T12:00', { zone: shop.timezone });
  assert.equal(buildSystemPrompt(at, shop, { channel: 'chat', callerPhone: '+14155550190' }), prompt);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import {
  asksVagueQuestionNeedlessly,
  checkBookingClaim,
  claimsLateNote,
  mentionsCountryCode,
  offersTime,
  saysGoodbye,
  saysUnavailable,
} from '../../src/agent/claim-check.ts';

// A model that answers the verdict question with a fixed answer, or fails.
function judge(answer: boolean | Error | string) {
  const requests: unknown[] = [];
  const llm = {
    chat: {
      completions: {
        async create(params: unknown) {
          requests.push(params);
          if (answer instanceof Error) throw answer;
          const args = typeof answer === 'string' ? answer : JSON.stringify({ claimsChange: answer });
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'v', type: 'function', function: { name: 'verdict', arguments: args } }],
                },
              },
            ],
          };
        },
      },
    },
  };
  return { llm: llm as unknown as OpenAI, requests };
}

test('unmistakable claims are caught without asking the model', async () => {
  const { llm, requests } = judge(false);
  for (const reply of ['Booked you in for Thursday. Anything else?', "That's cancelled. Anything else?"]) {
    assert.deepEqual(await checkBookingClaim(llm, 'm', reply), { claimsChange: true, via: 'phrase' });
  }
  assert.equal(requests.length, 0);
});

test('replies with nothing claim-like pass without asking the model', async () => {
  const { llm, requests } = judge(true);
  for (const reply of ['What time would you like to book?', 'A full detail is $250.', 'Should I move it to 11?']) {
    assert.deepEqual(await checkBookingClaim(llm, 'm', reply), { claimsChange: false, via: 'no_match' });
  }
  assert.equal(requests.length, 0);
});

test('other wordings that sound finished are decided by the model', async () => {
  const yes = judge(true);
  assert.deepEqual(await checkBookingClaim(yes.llm, 'm', "We've got you down for Friday at 11."), {
    claimsChange: true,
    via: 'model',
  });
  assert.equal(yes.requests.length, 1);

  const no = judge(false);
  assert.deepEqual(await checkBookingClaim(no.llm, 'm', 'Should I get that booked for you?'), {
    claimsChange: false,
    via: 'model',
  });
});

test('if the model check fails, it fails safe and treats the reply as a claim', async () => {
  for (const answer of [new Error('down'), '{not json', JSON.stringify({ claimsChange: 'yes' })]) {
    const { llm } = judge(answer);
    assert.deepEqual(await checkBookingClaim(llm, 'm', "You're all set for Friday."), {
      claimsChange: true,
      via: 'model_failed',
    });
  }
});

test('a reply saying the caller is noted as late is recognised; questions and policy are not', () => {
  for (const reply of [
    'I will mark you as running late for today. Anything else?',
    "I've noted that you're running late.",
    "No problem, I'll make a note that you're running late.",
    "I've let the shop know you're running late.",
    // From the eval: said without calling mark_running_late.
    'I am marking you as running late for today. Anything else?',
    "I'm noting that you'll be 40 minutes late.",
  ]) {
    assert.equal(claimsLateNote(reply), true, reply);
  }
  for (const reply of [
    'Should I mark you as running late?',
    "I can't mark you as late without a booking for today.",
    "I couldn't note that you're running late; there's no booking under that number.",
    "Please note that if you're late, we hold the slot for 15 minutes.",
    'Thanks for letting me know. What name is the booking under?',
    'We close at 6 PM.',
  ]) {
    assert.equal(claimsLateNote(reply), false, reply);
  }
});

test('a reply saying a time is taken is recognised; offers and service names are not', () => {
  for (const reply of [
    'I am sorry, 3:30 PM on November 5th is booked. Would 3 PM work?',
    "3:30 PM isn't available it's already booked.",
    "That time's taken. How about 4:30 PM?",
    "We're closed on Sundays.",
  ]) {
    assert.equal(saysUnavailable(reply), true, reply);
  }
  for (const reply of [
    'What is your name and phone number?',
    'Do you want Thursday, Nov 5 at 4:30 PM or 2:30 PM?',
    'I can get you booked for a full detail at 4:30 PM.',
  ]) {
    assert.equal(saysUnavailable(reply), false, reply);
  }
});

test('a reply offering to book a time is recognised; opening hours are not', () => {
  for (const reply of [
    'I can book an interior detail & wash for you on Wednesday, Nov 5, 2025 at 3:30 PM.',
    '4:30 PM is available. Want it?',
    'We have an opening at 2:30 PM.',
  ]) {
    assert.equal(offersTime(reply), true, reply);
  }
  for (const reply of ["We're open 8 AM to 6 PM, Monday to Saturday.", 'What time would you like?']) {
    assert.equal(offersTime(reply), false, reply);
  }
});

test('the vague-message question counts as needless only when the message names something', () => {
  const question = 'Do you mean an appointment you already have, or what times are open?';
  for (const message of ['do u guys have anything open tomorrow', 'Thursday at 3pm?', 'how about an exterior wash']) {
    assert.equal(asksVagueQuestionNeedlessly(question, message), true, message);
  }
  for (const message of ['Is there anything scheduled?', 'hi']) {
    assert.equal(asksVagueQuestionNeedlessly(question, message), false, message);
  }
});

test('a goodbye is a goodbye in so many words; thanks alone is not', () => {
  assert.equal(saysGoodbye('thanks, bye'), true);
  assert.equal(saysGoodbye('Goodbye!'), true);
  assert.equal(saysGoodbye('ok thanks, 4:30 then'), false);
});

test('a reply mentioning the country code is recognised', () => {
  assert.equal(mentionsCountryCode('Is that a US number? If not, say the country code.'), true);
  assert.equal(mentionsCountryCode('That number seems invalid. Can you repeat it?'), false);
});

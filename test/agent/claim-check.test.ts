import assert from 'node:assert/strict';
import { test } from 'node:test';
import type OpenAI from 'openai';
import { checkBookingClaim, claimsLateNote } from '../../src/agent/claim-check.ts';

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

// Decides whether a reply tells the caller a booking was made, moved or
// cancelled, as already done. The conversation uses it to catch replies that
// claim a change no booking tool made.
//
// Matching phrases alone can't keep up with how many ways there are to say
// "you're all set", so there are three tiers, cheapest first:
//   1. Unmistakable claims ("booked you", "that's cancelled"): yes.
//   2. Wording that sounds like something finished ("got you down",
//      "reserved", "confirmed"): ask the model, in a short separate request.
//   3. Everything else ("what time would you like to book?"): no.
import type OpenAI from 'openai';

const DEFINITE_CLAIM =
  /\b(booked you|you're booked|you are booked|moved (you|your|it)|rescheduled|(that's|it's|has been|is) cancell?ed|cancell?ed (it|your))\b/i;

const POSSIBLE_CLAIM =
  /\b(booked|moved|rescheduled|cancell?ed|reserved|scheduled|confirmed|all set|set you up|got you (down|in)|put you (down|in)|you're in|see you)\b/i;

const VERDICT = 'verdict';

const INSTRUCTIONS = `A receptionist at an auto detailing shop said the message below to a caller. Does it tell the caller, as already done, that an appointment was booked, moved to a new time, or cancelled? Offers, questions and plans ("I can book that", "Should I move it?", "Want me to cancel?") do not count. Talking about an appointment the caller already had before this call does not count. Answer by calling ${VERDICT}.`;

const verdictTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: VERDICT,
    description: 'Record the answer.',
    parameters: {
      type: 'object',
      properties: { claimsChange: { type: 'boolean' } },
      required: ['claimsChange'],
      additionalProperties: false,
    },
  },
};

export type ClaimCheck = { claimsChange: boolean; via: 'phrase' | 'model' | 'no_match' | 'model_failed' };

export async function checkBookingClaim(llm: OpenAI, model: string, reply: string): Promise<ClaimCheck> {
  if (DEFINITE_CLAIM.test(reply)) {
    return { claimsChange: true, via: 'phrase' };
  }
  if (!POSSIBLE_CLAIM.test(reply)) {
    return { claimsChange: false, via: 'no_match' };
  }
  try {
    const response = await llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: reply },
      ],
      tools: [verdictTool],
      tool_choice: { type: 'function', function: { name: VERDICT } },
    });
    const call = response.choices[0]?.message?.tool_calls?.find((c) => c.type === 'function');
    const args = JSON.parse(call?.type === 'function' ? call.function.arguments : '{}') as { claimsChange?: unknown };
    if (typeof args.claimsChange === 'boolean') {
      return { claimsChange: args.claimsChange, via: 'model' };
    }
  } catch {
    // Falls through to failing safe.
  }
  // Fail safe: treat the reply as a claim. If it wasn't one, the correction
  // only costs the agent a rephrase; letting a false claim through could
  // send a caller away believing they're booked.
  return { claimsChange: true, via: 'model_failed' };
}

// The agent saying it has noted, or will note, that the caller is running
// late: "I'll mark you as running late", "I've noted that you're late",
// "I've let the shop know". Only a successful mark_running_late does that.
// The model said it and then didn't call the tool, about one run in ten in
// the eval. Anchored on "I"/"we" so policy wording ("please note that if
// you're late...") doesn't count, and questions ("Should I mark you as
// late?") and refusals ("I can't mark you as late without a booking") are
// skipped.
const LATE_NOTE =
  /\b(i|i've|i'll|i have|i will|we|we've|we'll)\b[^.!?]{0,20}\b(mark(ed|ing)?|not(e|ed|ing)|let (the shop|the team|them) know)\b[^.!?]*\blate\b/i;

const REFUSAL = /\b(can't|cannot|couldn't|could not|unable|not able|won't|wasn't able)\b/i;

export function claimsLateNote(reply: string): boolean {
  const sentences = reply.match(/[^.!?]+[.!?]*/g) ?? [];
  return sentences.some(
    (sentence) => !sentence.trim().endsWith('?') && !REFUSAL.test(sentence) && LATE_NOTE.test(sentence),
  );
}

// A reply telling the caller a time can't be booked. No bare "full" or
// "booked": "full detail" is a service, and "get you booked" is an offer.
const SAYS_UNAVAILABLE =
  /\b(not available|isn't available|unavailable|not free|isn't free|not open|isn't open|already booked|is booked|been booked|fully booked|booked up|taken|closed|has passed|already passed|outside)\b/i;

export function saysUnavailable(reply: string): boolean {
  return SAYS_UNAVAILABLE.test(reply);
}

// A reply offering to book a particular time: "I can book that for 3:30 PM",
// "4:30 PM is available". Opening hours ("we're open 8 AM to 6 PM") aren't an
// offer. The conversation pairs this with the times tools have returned, so
// only an offer of a time no tool has seen is questioned.
const OFFER =
  /\b(i|we) (can|could|'ll|will) (book|schedule|fit|get|put)\b|\b(is|are|'s) (available|free)\b|\b(an? )?(opening|slot|spot) (at|for)\b/i;

export function offersTime(reply: string): boolean {
  return OFFER.test(reply);
}

// Turns a finished call into a call-log entry. This is a separate, focused
// request made once the call has ended, so the receptionist never has to
// remember a bookkeeping step mid-conversation, and every call is logged
// exactly once by construction.
import type OpenAI from 'openai';
import { z } from 'zod';

const callSummarySchema = z.strictObject({
  intent: z.enum(['booking', 'reschedule', 'cancellation', 'running_late', 'question', 'complaint', 'other']),
  summary: z.string().min(1).describe('One or two sentences on what the caller wanted.'),
  outcome: z.string().min(1).describe('What happened, e.g. "Booked Thursday 4:30 PM".'),
  needsHuman: z.boolean().describe('True if someone from the shop must follow up.'),
  name: z.string().nullable().describe("The caller's name, or null if they didn't give one."),
  phone: z.string().nullable().describe("The caller's phone number, or null if they didn't give one."),
});

export type CallSummary = z.infer<typeof callSummarySchema>;

const RECORD_CALL = 'record_call';
const MAX_ATTEMPTS = 2;

const INSTRUCTIONS = `You keep the call log for an auto detailing shop. You'll get the transcript of one phone call between a caller and the shop's receptionist, including what the receptionist's booking tools did. Record the call by calling ${RECORD_CALL}.

- intent: what the caller mainly wanted.
- summary: one or two plain sentences.
- outcome: what actually happened, based on the tool results and the booking system's note at the end, not on what was said. Checking availability is not a booking. If a booking tool failed, say so.
- needsHuman: true if the receptionist promised a callback, or the call is about a charge, refund, damage, a custom quote, or anything left unresolved. Otherwise false.
- name and phone: as the caller gave them, or null.`;

export async function summarizeCall(llm: OpenAI, model: string, transcript: string): Promise<CallSummary | null> {
  const { $schema: _, ...parameters } = z.toJSONSchema(callSummarySchema);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: transcript },
      ],
      tools: [{ type: 'function', function: { name: RECORD_CALL, description: 'Record the call.', parameters } }],
      tool_choice: { type: 'function', function: { name: RECORD_CALL } },
    });
    const call = response.choices[0]?.message?.tool_calls?.find((c) => c.type === 'function');
    const parsed = callSummarySchema.safeParse(parseJson(call?.type === 'function' ? call.function.arguments : ''));
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

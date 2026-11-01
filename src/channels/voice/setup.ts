// Creates the Vapi assistant, or updates it if VAPI_ASSISTANT_ID is set:
// `npm run vapi:setup`. Run it again whenever PUBLIC_URL changes (a quick
// tunnel gets a new URL every time it starts).
import { assistantConfig } from './assistant.ts';

const apiKey = required('VAPI_API_KEY');
const publicUrl = required('PUBLIC_URL');
const secret = required('VAPI_SECRET');
const assistantId = process.env.VAPI_ASSISTANT_ID?.trim();

const response = await fetch(`https://api.vapi.ai/assistant${assistantId ? `/${assistantId}` : ''}`, {
  method: assistantId ? 'PATCH' : 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify(assistantConfig({ publicUrl, secret })),
});
const body = (await response.json()) as { id?: string; message?: unknown };
if (!response.ok) {
  console.error(`Vapi returned ${response.status}:`, body.message ?? body);
  process.exit(1);
}
console.log(`${assistantId ? 'Updated' : 'Created'} assistant ${body.id}.`);
if (!assistantId) {
  console.log(`Add VAPI_ASSISTANT_ID=${body.id} to .env, so the next run updates it instead of making another.`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name} in .env (see .env.example).`);
    process.exit(1);
  }
  return value;
}

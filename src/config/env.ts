// Reads and validates environment variables once, at startup, so a missing
// value fails immediately with a clear message instead of deep inside a call.

export type LlmEnv = { baseURL: string; apiKey: string; model: string };

export type Env = {
  calendarId: string;
  sheetId: string;
  llm: LlmEnv;
  port: number;
  // Optional: turns on the Vapi routes (Phase 2), behind this secret.
  vapiSecret: string | undefined;
};

const DEFAULT_LLM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_LLM_MODEL = 'nvidia/nemotron-3.5-bolt-e4b';
const DEFAULT_PORT = 3000;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // GoogleAuth reads the key file path itself; check it here so a missing
  // value is reported with the others.
  required(source, 'GOOGLE_APPLICATION_CREDENTIALS');
  return {
    calendarId: required(source, 'CALENDAR_ID'),
    sheetId: required(source, 'SHEET_ID'),
    llm: loadLlmEnv(source),
    port: parsePort(optional(source, 'PORT')),
    vapiSecret: parseVapiSecret(optional(source, 'VAPI_SECRET')),
  };
}

// Just the model settings, for tools like the eval that don't touch Google.
export function loadLlmEnv(source: NodeJS.ProcessEnv = process.env): LlmEnv {
  return {
    baseURL: optional(source, 'LLM_BASE_URL') ?? DEFAULT_LLM_BASE_URL,
    apiKey: required(source, 'NVIDIA_API_KEY'),
    model: optional(source, 'LLM_MODEL') ?? DEFAULT_LLM_MODEL,
  };
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = optional(source, name);
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return source[name]?.trim() || undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got "${value}".`);
  }
  return port;
}

// The secret is all that stands between a public URL and the booking tools,
// so a short one is refused.
function parseVapiSecret(value: string | undefined): string | undefined {
  if (value !== undefined && !/^[A-Za-z0-9_-]{16,}$/.test(value)) {
    throw new Error('VAPI_SECRET must be at least 16 letters, digits, "-" or "_" (it goes in a URL).');
  }
  return value;
}

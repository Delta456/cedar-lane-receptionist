// Small HTTP helpers shared by the server and the channels' routes.
import type { IncomingMessage, ServerResponse } from 'node:http';

// A route handles a request if it's one of its own, and says whether it did.
export type Route = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;

// An error the caller should see, with its status. Anything else is a 500
// with no details.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) {
      throw new HttpError(413, 'request body too large');
    }
  }
  try {
    const parsed: unknown = JSON.parse(body || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${key} is required`);
  }
  return value;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

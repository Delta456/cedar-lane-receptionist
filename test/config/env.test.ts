import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEnv } from '../../src/config/env.ts';

const base = { GOOGLE_APPLICATION_CREDENTIALS: 'key.json', CALENDAR_ID: 'c', SHEET_ID: 's', NVIDIA_API_KEY: 'k' };

test('the voice routes are off without VAPI_SECRET, and a short secret is refused', () => {
  assert.equal(loadEnv(base).vapiSecret, undefined);
  assert.equal(loadEnv({ ...base, VAPI_SECRET: 'abcdefghij-0123456789' }).vapiSecret, 'abcdefghij-0123456789');
  assert.throws(() => loadEnv({ ...base, VAPI_SECRET: 'short' }), /at least 16/);
});

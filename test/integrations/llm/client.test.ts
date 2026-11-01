import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryNotFound } from '../../../src/integrations/llm/client.ts';

function fakeFetch(statuses: number[]) {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    const status = statuses[calls.length] ?? 200;
    calls.push(status);
    return new Response(status === 200 ? '{}' : null, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('a 404 is retried until it succeeds', async () => {
  const { fetchImpl, calls } = fakeFetch([404, 404, 200]);
  const response = await retryNotFound(fetchImpl, { baseDelayMs: 1 })('https://example.test');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [404, 404, 200]);
});

test('gives up after the retries and returns the 404', async () => {
  const { fetchImpl, calls } = fakeFetch([404, 404, 404, 404, 404]);
  const response = await retryNotFound(fetchImpl, { retries: 2, baseDelayMs: 1 })('https://example.test');
  assert.equal(response.status, 404);
  assert.equal(calls.length, 3);
});

test('other statuses are returned straight away for the SDK to handle', async () => {
  const { fetchImpl, calls } = fakeFetch([429]);
  const response = await retryNotFound(fetchImpl, { baseDelayMs: 1 })('https://example.test');
  assert.equal(response.status, 429);
  assert.equal(calls.length, 1);
});

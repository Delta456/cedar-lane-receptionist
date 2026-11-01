import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialQueue } from '../../src/lib/serial-queue.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('tasks run one at a time, in order', async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  const task = (name: string, ms: number) => async () => {
    events.push(`start ${name}`);
    await delay(ms);
    events.push(`end ${name}`);
    return name;
  };

  const results = await Promise.all([queue.run(task('a', 20)), queue.run(task('b', 1))]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b']);
});

test('a failed task does not block the next one', async () => {
  const queue = new SerialQueue();
  const failed = queue.run(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failed, /boom/);
  assert.equal(await queue.run(async () => 'next'), 'next');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../../src/lib/logger.ts';

function capture(level: string) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)), level: () => level });
  return { logger, lines };
}

test('writes one JSON object per line, with the event and fields', () => {
  const { logger, lines } = capture('info');
  logger.info('turn', { latencyMs: 812 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.event, 'turn');
  assert.equal(lines[0]?.level, 'info');
  assert.equal(lines[0]?.latencyMs, 812);
  assert.ok(typeof lines[0]?.time === 'string');
});

test('drops lines below the level, and silent drops everything', () => {
  const { logger, lines } = capture('warn');
  logger.debug('a');
  logger.info('b');
  logger.warn('c');
  logger.error('d');
  assert.deepEqual(
    lines.map((l) => l.event),
    ['c', 'd'],
  );

  const silent = capture('silent');
  silent.logger.error('e');
  assert.equal(silent.lines.length, 0);
});

test('child loggers add their fields to every line', () => {
  const { logger, lines } = capture('info');
  logger.child({ callId: 'abc' }).child({ step: 2 }).info('tool');
  assert.equal(lines[0]?.callId, 'abc');
  assert.equal(lines[0]?.step, 2);
});

test('errors are serialised with their message', () => {
  const { logger, lines } = capture('info');
  logger.error('failed', { err: new Error('boom') });
  const err = lines[0]?.err as { message?: string } | undefined;
  assert.equal(err?.message, 'boom');
});

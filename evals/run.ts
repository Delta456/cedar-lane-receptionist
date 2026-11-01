// Plays every scenario through the real model against in-memory stores, and
// reports which ones end in the right calendar and call-log state.
//
//   npm run eval                       all scenarios, once each
//   npm run eval -- --runs 3           each scenario 3 times (models vary)
//   npm run eval -- --only reschedule  scenarios whose name contains "reschedule"
//
// Needs only NVIDIA_API_KEY: nothing touches the real Calendar or Sheet.
import { parseArgs } from 'node:util';
import { Conversation, type ToolCall } from '../src/agent/conversation.ts';
import { loadLlmEnv } from '../src/config/env.ts';
import { createLlmClient } from '../src/integrations/llm/client.ts';
import { BookingService } from '../src/services/booking-service.ts';
import { CallLogService } from '../src/services/call-log-service.ts';
import { FakeCalendarStore, FakeCallLogStore } from '../test/support/fake-stores.ts';
import { EVAL_NOW, type Scenario, scenarios } from './scenarios.ts';

// The eval prints its own report; only show the app's errors alongside it.
process.env.LOG_LEVEL ??= 'error';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
  },
});
const runs = Math.max(1, Number(values.runs) || 1);
const concurrency = Math.max(1, Number(values.concurrency) || 3);
const selected = scenarios.filter((s) => !values.only || s.name.includes(values.only));

const env = loadLlmEnv();
const llm = createLlmClient(env);

type Outcome = {
  scenario: Scenario;
  run: number;
  problems: string[];
  transcript: string[];
  // How long the caller waited for each reply, in ms.
  latencies: number[];
};

async function play(scenario: Scenario, run: number): Promise<Outcome> {
  const calendar = new FakeCalendarStore();
  const callLog = new FakeCallLogStore();
  scenario.setup?.(calendar);
  const now = () => EVAL_NOW;
  const conversation = new Conversation({
    llm,
    model: env.model,
    services: {
      bookings: new BookingService({ calendar, now }),
      callLog: new CallLogService({ store: callLog, now }),
    },
    channel: scenario.channel ?? (scenario.callerPhone ? 'voice' : 'chat'),
    callerPhone: scenario.callerPhone ?? null,
    now,
  });

  const transcript: string[] = [];
  const replies: string[] = [];
  const latencies: number[] = [];
  const record = (toolCalls: ToolCall[], reply: string) => {
    for (const call of toolCalls) {
      transcript.push(`    [${call.name}] ${JSON.stringify(call.input)} -> ${JSON.stringify(call.result)}`);
    }
    if (reply) {
      transcript.push(`  Agent:  ${reply}`);
      replies.push(reply);
    }
  };

  // Hanging up before the caller's last line cuts them off: a failure in any
  // scenario.
  const problems: string[] = [];
  let endedByAgent = false;
  try {
    for (const [index, line] of scenario.caller.entries()) {
      transcript.push(`  Caller: ${line}`);
      const started = performance.now();
      const turn = await conversation.send(line);
      latencies.push(performance.now() - started);
      record(turn.toolCalls, turn.reply);
      if (turn.ended) {
        endedByAgent = true;
        if (index < scenario.caller.length - 1) {
          problems.push(`the agent hung up after "${line}", before the caller was done`);
        }
        break;
      }
    }
    transcript.push(endedByAgent ? '  (agent hangs up)' : '  (caller hangs up)');
    const final = await conversation.end();
    record(final.toolCalls, final.reply);
  } catch (err) {
    const problems = [`crashed: ${err instanceof Error ? err.message : String(err)}`];
    return { scenario, run, problems, transcript, latencies };
  }
  problems.push(...scenario.check({ calendar, callLog, replies, endedByAgent }));
  return { scenario, run, problems, transcript, latencies };
}

// Runs the jobs with at most `limit` in flight, to stay inside rate limits.
async function runLimited<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

const jobs = selected.flatMap((scenario) => Array.from({ length: runs }, (_, run) => () => play(scenario, run + 1)));
console.log(`Running ${jobs.length} conversations on ${env.model}...\n`);
const outcomes = await runLimited(jobs, concurrency);

for (const scenario of selected) {
  const mine = outcomes.filter((o) => o.scenario === scenario);
  const passed = mine.filter((o) => o.problems.length === 0).length;
  console.log(`${passed === mine.length ? 'PASS' : 'FAIL'}  ${passed}/${mine.length}  ${scenario.name}`);
  for (const outcome of mine.filter((o) => o.problems.length > 0)) {
    console.log(`  run ${outcome.run}:`);
    for (const problem of outcome.problems) console.log(`    - ${problem}`);
    console.log(outcome.transcript.join('\n'));
  }
}

// Reply latency matters for voice: past about 1.2 s the agent sounds like a
// bot. Turns that run tools take longer, so the spread is reported too.
const latencies = outcomes.flatMap((o) => o.latencies).sort((a, b) => a - b);
const percentile = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
console.log(
  `\nReply latency over ${latencies.length} turns: p50 ${seconds(percentile(50))}, ` +
    `p90 ${seconds(percentile(90))}, max ${seconds(latencies.at(-1) ?? 0)} (with ${concurrency} conversations in parallel)`,
);

const total = outcomes.filter((o) => o.problems.length === 0).length;
console.log(`${total}/${outcomes.length} conversations passed.`);
process.exitCode = total === outcomes.length ? 0 : 1;

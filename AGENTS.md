# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## What this is

An AI phone receptionist for a small auto detailing shop, Cedar Lane Auto Detailing. Callers book, reschedule and cancel appointments, ask questions, or call with a problem. The agent checks and changes bookings on a **Google Calendar**, and logs every call to a **Google Sheet** (a `Calls` tab plus one `Contacts` row per caller). Phase 1 is a text chat (`channels/chat/`). Phase 2 puts the same agent on phone calls through Vapi (`channels/voice/`); it's had five test calls (from the Vapi dashboard) so far.

The model is NVIDIA's **Nemotron 3.5 Bolt E4B**, a small model (4B effective parameters), called through NVIDIA's OpenAI-compatible API with the `openai` SDK. Any OpenAI-compatible endpoint works through `LLM_BASE_URL` and `LLM_MODEL`.

## Commands

| Command                              | What it does                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                      | Typecheck, lint and unit tests. **Run before you finish any change**, and update the docs (see Keeping the docs current).                                                                                                       |
| `npm test`                           | Unit tests only (`node:test`). No network; logs are silenced.                                                                                                                                                                   |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / `biome check .`                                                                                                                                                                                                |
| `npm run fix`                        | Biome formatting, import sorting and safe lint fixes.                                                                                                                                                                           |
| `npm run eval`                       | Plays caller scenarios through the **real model** against in-memory stores, and checks the resulting calendar and call-log state. Needs `NVIDIA_API_KEY`. Options: `-- --runs 3`, `-- --only reschedule`, `-- --concurrency 2`. |
| `npm run vapi:setup`                 | Creates the Vapi assistant from `channels/voice/assistant.ts`, or updates it when `VAPI_ASSISTANT_ID` is set. Needs `VAPI_API_KEY`, `PUBLIC_URL`, `VAPI_SECRET`.                                                                |
| `npm run smoke`                      | Read-only check that the Google Calendar and Sheet are reachable.                                                                                                                                                               |
| `npm start` / `npm run dev`          | The server on `http://localhost:3000`: the chat page, plus the voice routes when `VAPI_SECRET` is set (`dev` restarts on file changes).                                                                                         |

Requires Node 24 (`.nvmrc`). Node runs the `.ts` files directly by stripping types, so there's no build step. Config comes from `.env` (see `.env.example`).

## Architecture

Dependencies point one way: `server and channels → agent → services → domain`. Within the first layer, `http-server.ts` routes each request to a channel, and the channels use the server's `http.ts` helpers and `Sessions` (the calls in progress); no other module imports a channel. Only `integrations/` talks to external APIs. `app.ts` wires everything together; everything else receives its dependencies as arguments.

```
src/
  main.ts              entry point: starts the HTTP server
  app.ts               composition root: builds the real dependencies
  config/              env.ts (validated env vars), shop.ts (services, hours, policies)
  domain/              pure logic, no I/O: availability, dates, phone numbers, spoken times, hand-made booking text
  services/            business rules behind interfaces (ports.ts): bookings, call log
  integrations/        google/ (Calendar and Sheets stores), llm/ (OpenAI-compatible client)
  agent/               conversation loop, tools, prompt, end-of-call summary, claim check, text tool-call recovery
  channels/
    chat/              Phase 1: routes.ts (/api/chat, /api/end, /api/hangup) and page.html
    voice/             Phase 2: routes.ts (Vapi's endpoints), vapi.ts (request and stream helpers),
                       assistant.ts (Vapi assistant settings), setup.ts (`npm run vapi:setup`)
  server/              http-server.ts (routing, request log), sessions.ts (calls in progress: ending,
                       retries, idle sweep), http.ts (JSON helpers, HttpError)
  lib/                 logger, serial queue
  scripts/             smoke test
test/                  unit tests, mirroring src/ (test/domain/dates.test.ts tests src/domain/dates.ts)
  support/             in-memory fake stores, a test HTTP server with stub conversations, test setup
evals/                 caller scenarios and the eval runner (real model, fake stores)
```

`src/` holds only code that runs in production. Nothing in `src/` imports from `test/` or `evals/`.

### The central design rule: the code decides, the model talks

The model is small and makes mistakes. Anything that must be correct is enforced in code, not in the prompt.

- **Availability, conflicts, alternatives and opening hours** are computed in `domain/availability.ts`. The model passes a service, date and time; it never decides whether a slot is free. For "what's open?", `find_open_times` returns a spread of open times, not every one, and its result says so: without that note, the model treated the list as complete and booked 10:30 when a caller asked for 10:00.
- **Dates:** tools accept `"friday"`, `"today"` and `"tomorrow"`, resolved by `domain/dates.ts`, because the model got weekday arithmetic wrong in evals.
- **No double booking, at two levels.** Within one server, writes run one at a time in a `SerialQueue` and re-check availability first. Across servers, every write is verified after it lands (`lostRace` in `services/booking-service.ts`): if an overlapping booking was written earlier (by the calendar's `updatedAt`, then id), this write gives way and undoes itself, so exactly one of two simultaneous writes survives.
- **Ownership:** a booking stores its owner's phone number and name. With caller ID (`callerPhone`), the calling number is used whatever number the model passes, for new bookings as well as finding and changing them. Without caller ID, `find_bookings`, `reschedule_appointment`, `cancel_appointment` and `mark_running_late` also need the name on the booking (first names match; `nameMatches` in `services/booking-service.ts`). Bookings staff create by hand get their owner from the event text (`domain/booking-text.ts`), e.g. "Exterior wash – John 415-555-1234". Never let a tool reveal whose number is whose without caller ID: `lookup_caller` only uses `callerPhone`, because a looked-up name would let anyone pass the name check.
- **Phone number formats:** `normalizePhone` reads a number without a country code as North American (the shop is in the US) and a number after "+" or "plus" with `libphonenumber-js` for its country. A spoken "oh" before any digit is ignored ("Oh, it's plus nine one..."). Every tool result with `reason: 'invalid_phone'` gets `PHONE_HELP` as its `tellCaller` (added in `defineTool`), which asks about the country code first, because the model drops the end of a long note.
- **Phone numbers:** every tool gets the caller's number from `ownerPhone` in `agent/tools.ts`: caller ID first, then a complete number the code parses from what the caller said this turn (`CallState.callerMessage`, set by `runTurn`), and only then the model's copy. The model converts spoken digits itself and once merged a fragment and a full number into 11 digits. `normalizePhone` refuses anything incomplete or ambiguous, so it never guesses.
- **Handoffs go through `request_callback`,** which refuses an incomplete number (`tellCaller` asks for the whole number again) and records `CallState.callback`. The call log treats a recorded callback as a fact: `needsHuman` is true whatever the summary says, and the outcome ends with "Callback requested: <reason>" (`withCallback`). On a real call the agent had promised a callback on five digits.
- **Tool inputs are validated with Zod.** One schema per tool produces both the JSON Schema the model sees and the runtime check. Invalid input goes back to the model as `invalid_input` with readable issues, so it can fix and retry.
- **Call logging is not a tool.** When a call ends, `Conversation.end()` makes one separate request that turns the transcript into a log entry (`agent/call-summary.ts`). Facts the code saw (caller ID, the booking made and the phone number it used, event ID) override the summary, and the summary is told whether any booking changed. If none did, an outcome claiming one is replaced: the summary once logged "Booked Thursday 9 AM" after a caller only asked what was open. If the summary fails, the code still logs the call, flagged for a human. Every call is logged exactly once by design, including abandoned ones: the agent hangs up with `end_call` (the turn comes back with `ended: true`, and the chat or voice route ends the call there and then), the server ends idle calls (30 minutes), the page sends `/api/hangup` when its tab closes, and `endOpenCalls` runs on shutdown. The server forgets a session only after `end()` succeeds; if it throws, the session is kept in `endFailed` and the sweeper retries it every minute (`end()` logs at most once, so retries are safe). The one exception to end-of-call writing: a successful `book_appointment` saves the caller's `Contacts` row straight away, in the background (`CallLogService.saveContact`, held in `CallState.contactSaved`). `end()` awaits that promise and passes the phone to `logCall` as `contactSaved`, so Total Calls counts the call once.
- **Guards in `agent/conversation.ts`** against known small-model failures, each found by the eval:
  - Empty responses, and tool calls written as text, never reach the caller. They are retried, and calls in Gemma template syntax (`tool{key:<|"|>value<|"|>}`), or a reply that is only a tool name (the model once replied "end_call"), are converted into real calls (`agent/text-tool-calls.ts`). Any tool name in a reply counts as a leak: tool names have underscores, so they never appear in ordinary speech.
  - A reply claiming a booking was made, moved or cancelled, with no successful booking tool behind it in that turn, is sent back once for correction. Changes from earlier turns don't count as backing (or a false "moved you" after an earlier booking would pass); the correction note lists them instead, so a reply that only repeats one can stand. `agent/claim-check.ts` decides in tiers: unmistakable phrases directly, wordings that only sound finished by a short yes/no model request, everything else passes. If the model request fails, it fails safe and treats the reply as a claim. Keep the cheap tiers in front of the model request: most replies mention bookings without claiming one.
  - **Running-late notes are checked the same way.** `claimsLateNote` (`agent/claim-check.ts`) spots the agent saying it has noted, or will note, that the caller is late ("I'll mark you as running late", "I've let the shop know"). Anchored on "I"/"we"; questions and refusals are skipped, so "please note that if you're late...", "Should I mark you as late?" and "I can't mark you as late without a booking" pass. If no `mark_running_late` has succeeded in the call, the reply is sent back once (`UNBACKED_LATE_NOTE`). The model said it and didn't call the tool about one run in ten; after the guard, the two running-late scenarios passed 20/20.
  - If the model fails mid-turn, `recoverFromFailure` confirms whatever the tools already did, from their results, and adds the reply to the history so the next turn is valid. The caller never sees an error after an action happened.
  - **Hanging up:** `end_call` only sets `CallState.endRequested`; the call ends after that turn's goodbye. It refuses (`too_soon`) in a turn that changed a booking (`changedThisTurn`, reset each turn), and `runTurn` checks again at the end of the turn in case the change came after `end_call` in the same response, so the caller hears the change confirmed and can ask for something else. It also refuses (`caller_not_done`) unless the caller's message this turn sounds like they're finishing (`soundsFinished`: "bye", "that's all", "nothing else", "thanks"; a message starting with "yes" doesn't count unless it also says goodbye or that's all). Asked "Anything else?", a caller said "Yes please." and the agent hung up; a wrong refusal only keeps the call open. An error reply never ends the call; a hang-up with no usable goodbye gets a fixed one. The eval fails any scenario where the agent hangs up before the caller's last line.
  - **Running late** finds today's booking from the phone number and name (`markRunningLate`), with no `eventId`: the model asked callers for "the event ID" instead of calling `find_bookings` first.
  - Clearly 24-hour times in a reply (a leading zero, or hours 13–23) are rewritten as spoken times by `speakTimes` (`domain/spoken-time.ts`), in the reply and in the history. The model turned "4:30 PM" from a tool result into "16:30", probably because tools take 24-hour times. Bare times like "10:30" are left alone.

### Voice calls (Phase 2)

Vapi calls `POST /vapi/<VAPI_SECRET>/v1/chat/completions` (`channels/voice/routes.ts`) as a custom LLM and streams the answer back as OpenAI `chat.completion.chunk` events. The routes only exist when `VAPI_SECRET` is set, and the request log shows their paths as `/vapi/…` so the secret never reaches the logs.

- Vapi sends the whole history each time. Each call gets a normal `Conversation` (key `vapi:<call.id>`, in the same `Sessions` as chat calls, so idle timeouts, retries and shutdown logging apply). Only what's new is sent to it (`newCallerText`): caller messages beyond those already answered, plus the last answered message again, whole, if Vapi has extended it since (it keeps transcribing while waiting for a reply; on the first real call, comparing only the message count dropped the rest of a phone number). A repeated request gets the last reply again.
- `call.customer.number` becomes `callerPhone`, so ownership uses caller ID. Only a number `normalizePhone` accepts counts; a withheld or junk caller ID is treated as none, or every booking tool would fail with `invalid_phone`. With caller ID, `Conversation` passes the number to `buildSystemPrompt`, which swaps in a booking rule that never asks for a number (`bookingRule`), a confirmation example that names its last four digits (`bookedExample`), and the same number in every other rule that would ask for one (`theirNumber`, `nameAndNumber`: changing, running late, handoffs). Both had to be in the rule and the example themselves: an extra prompt section at the end, and a `tellCaller` note in the booking result, were both ignored in the eval.
- The filler ("One moment, let me check.") is streamed from `Conversation.send`'s `onToolStart` hook, before the first tools run. It's spoken only and never added to the history. No filler for `end_call` alone.
- Hanging up: Vapi doesn't document how a custom LLM ends a call, so the agent's hang-up reply is replaced by `CLOSING`, and the assistant's `endCallPhrases` contains `END_CALL_PHRASE`. `spokenReply` removes that phrase from every other reply, and the greeting must never contain it. The end-of-call event (`POST /vapi/<secret>/events`) logs calls the caller hangs up on.
- Assistant settings live in `channels/voice/assistant.ts`, not the dashboard. `npm run vapi:setup` sends them. Speech-to-text has two setups in `SPEECH_OPTIONS`, and `SPEECH` picks one: Deepgram Nova-3 with Indian English (`en-IN`) and LiveKit turn detection (current), or Deepgram Flux (general English only; it detects turn ends itself, so no `smartEndpointingPlan` with it). Flux misheard the test caller's Indian English accent on every call. Compare turn latency in Vapi's `performanceMetrics` when switching. Flux's `eotThreshold` stays at its default, 0.7. Raising it to 0.8 (after Flux once ended a turn mid-phone-number) added about 1.1 s to every turn on the next call, so it was reverted; don't raise it without measuring. Vapi's call API (`GET https://api.vapi.ai/call/<id>`, with `VAPI_API_KEY`) returns `artifact.performanceMetrics.turnLatencies` per turn: transcriber, endpointing, model and voice latency. `keyterm` (from `keyterms()`: weekdays, service names, shop name) is there because "Thursday" was misheard as "seven o'clock" and "Tuesday"; Vapi accepts it, but whether it reaches Deepgram for Flux is unconfirmed until a call's transcript shows it.
- What each test call found, and how it was fixed, is in the README's "What the test calls found". Add to it when a call finds something.
- Vapi's own call logs (exported from the dashboard as CSV) show per-stage timings: end of turn, `Custom LLM HTTP request`/`response` (this server, through the tunnel), first audio. They also contain the full custom LLM URL, so `VAPI_SECRET`: don't commit or share them.

When you fix a model mistake, prefer a code-level fix (validation, a guard, a clearer tool result) over prompt wording. Prompt changes should be small and specific.

## Conventions

- **TypeScript is run by Node's type stripping**, so only erasable syntax is allowed (`erasableSyntaxOnly`): no `enum`, no `namespace`, **no constructor parameter properties** (`constructor(private x: T)`). Declare fields and assign them in the constructor.
- **Imports use the `.ts` extension** (`import { x } from './x.ts'`), and type-only imports use `import type`.
- The tsconfig is strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Optional properties that may hold `undefined` are typed `?: T | undefined`.
- **TypeScript 7** (the native compiler) has no JS API, so typescript-eslint can't run. Biome does linting and formatting: single quotes, semicolons, 2 spaces, 120 columns.
- **Dates and times use Luxon**, always in the shop's timezone (`shop.timezone`). Never use the server's local time.
- Comments explain _why_, in plain sentences, and match the density of the surrounding code. Name things in full words.
- Services and integrations are classes with injected dependencies, including `now` (and `logger` where they log), so tests can control time and logs.

## Testing

- Every behaviour change needs a unit test. Tests live in `test/`, at the same path as the code they test (`src/agent/tools.ts` → `test/agent/tools.test.ts`), and use `node:test` with `assert/strict`.
- Use `FakeCalendarStore` and `FakeCallLogStore` from `test/support/fake-stores.ts`. Unit tests must never call Google or the model.
- Pin time with a fixed `now`. Tests use Saturday 31 Oct 2026, noon, shop time, so "Thursday" is 5 Nov.
- For the conversation loop, use the scripted model in `test/agent/conversation.test.ts`. It returns canned replies and records requests.
- For the HTTP server and the channels' routes, use `startTestServer()` from `test/support/test-server.ts`: a real server on port 0 with stub conversations (and captured log lines), started in `beforeEach` and closed in `afterEach` (it closes keep-alive sockets, which otherwise keep the test process running).
- For races between servers, see `RacingCalendar` in `test/services/booking-service.test.ts`: it lands a competing write just before or after the one under test.
- For model behaviour, add a scenario to `evals/scenarios.ts`. Checks look at **state** (calendar events, logged call fields), not reply wording, except where the wording is the point (e.g. a price was mentioned). Run it several times (`--runs 3`): the model isn't deterministic, and a single pass proves little.

## Adding things

- **A tool:** add a `defineTool({ name, description, input: z.strictObject({...}), run })` entry in `agent/tools.ts` and keep `run` a thin call into a service. Make fields required unless leaving one out has an obvious meaning, and add it to `OPTIONAL_FIELDS` in `test/agent/tools.test.ts` if so. Booking actions should call `remember(call, result)` so the call log can link them. When the model must act on a result, spell it out in the result (`tellCaller`, `note`) rather than leaving a bare flag: the model ignored `withinGracePeriod: false` until the result said what to tell the caller.
- **A shop fact** (service, price, hours, policy, or an answer to any other common question via `faq`): change `config/shop.ts`. The prompt is generated from it, so don't hard-code shop facts in the prompt.
- **A booking rule:** put it in `domain/` if it's pure, or in `services/booking-service.ts` if it needs the calendar, with unit tests either way.

## Keeping the docs current

`README.md` is what reviewers read first, and this file is what the next agent reads first. A change isn't finished until both describe the code as it now is. Before you finish, check each item below that your change affects:

- **Behaviour or design:** what the agent handles or hands off, a guard, a booking rule, or a decision explained here or in the README's "How it works".
- **Structure:** new, moved or removed files and folders. Update the folder maps in both files, and any file paths mentioned.
- **Commands and setup:** npm scripts, environment variables (also `.env.example`), and the Google Calendar and Sheet setup steps.
- **Numbers:** the unit test count (from `npm test`), the scenario count and the latest eval result and latency (from `npm run eval`). Only quote numbers from a run you actually did, never estimates.
- **Known limitations:** remove ones you fixed, add ones you introduced or found. Be honest about what's partial.
- **Quirks and conventions:** anything the next person would otherwise trip over.

Quick checks: search both files for the names of anything you renamed or removed, and confirm every file path they mention still exists.

## Safety and data

- **Never commit `.env`, `key.json` or other credentials.** They are gitignored. Never print secrets or paste them into logs, code or output.
- **Logs must not contain personal data:** no caller messages, names or phone numbers. Log events, tool names, outcomes and timings. The Sheet is the record of who called.
- `npm run smoke` is read-only. Anything that writes to the real Calendar or Sheet must clean up after itself. Prefer `npm run eval`, which uses in-memory stores.
- Sheet writes use `valueInputOption: 'RAW'`, so caller text is never run as a formula. Keep it that way.

## Known quirks

- **NVIDIA's hosted endpoint sometimes returns a bodiless 404** for a valid model under load. `integrations/llm/client.ts` retries 404s with backoff. Don't remove that without checking.
- NVIDIA recommends `temperature: 1.0, top_p: 0.95` for this model. Retries rely on that sampling to produce a different response.
- Plain synchronous `tool` result messages work. NVIDIA's docs only describe an asynchronous pattern, which isn't used here.
- **Voice latency:** with Flux (call 2), replies started 1.6–1.75 s after the caller stopped speaking: end-of-turn detection about 0 s, this server 0.9–1.4 s through the tunnel (it waits for the model's whole reply), voice 0.2–0.4 s. With Nova-3 (call 5), turns averaged about 4 s, mostly Vapi's LiveKit turn detector (1.4 s on average). Streaming the model's reply as it's generated is the next lever for this server's share; the guards that read the full reply (claim check, tool-text detection, spoken times) would need rethinking for that.
- **Reply latency** (from `npm run eval`): the median has ranged from 0.55 s to 1.3 s between runs (NVIDIA's endpoint varies), and turns that use tools take 2–3 round trips (p90 2.1–5.4 s). Keep this in mind for voice, where replies should start within about 1.2 s.
- **Without caller ID** (the text chat), identity is the phone number plus the name on the booking, both checked in code. Someone who knows both can still pass; only caller ID or a one-time code fully proves who's calling.
- **The prompt has a chat and a voice version** (`buildSystemPrompt`'s `channel`, passed from the routes through `Conversation`). Both share every rule; a call adds the `PHONE_SECTION` (replies are spoken; speech-to-text mishears, so ask to repeat rather than answer literally), and caller ID only counts on a call. Put anything about speech or phones in that section, not in the shared rules. A unit test checks the call prompt is exactly the chat prompt plus that section. Eval scenarios run with the voice prompt when they have a `callerPhone` or set `channel: 'voice'`.
- **Misheard words:** on calls, speech-to-text can turn a day into something else. The prompt tells the agent to ask which day when the words don't clearly name one, never to guess, and to treat "I said Thursday" as a correction, not a vague message. The vague-message rule had no "don't ask when" condition, and the model asked its question in reply to a correction.
- **The model copies example sentences from the prompt word for word.** It said "Booked you in" after a cancellation, and asked a clarifying question on clear requests. Give one example per case, and attach the condition for using it ("if the message names no service, day or time"). Then re-run the affected eval scenarios, since a prompt change can fix one case and break another.
- `claim-check.ts` and `call-summary.ts` force a specific tool with `tool_choice`. That works on NVIDIA's endpoint; check it if you switch providers.

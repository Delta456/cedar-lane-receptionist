// The Vapi assistant's settings, kept in code so they're versioned and tested
// rather than clicked together in the dashboard. `npm run vapi:setup` sends
// them to Vapi (setup.ts).
import { shop } from '../../config/shop.ts';
import { END_CALL_PHRASE } from './vapi.ts';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Words speech-to-text should expect. On a test call, "Thursday" was heard
// as "seven o'clock" and as "Tuesday". Deepgram's keyterm prompting takes
// plain phrases, so service names lose their brackets and symbols:
// "Paint correction / ceramic coating" becomes two terms.
export function keyterms(): string[] {
  const services = shop.services.flatMap((service) =>
    service.name
      .replace(/\(.*?\)/g, '')
      .replace(/&/g, 'and')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return [...WEEKDAYS, ...services, 'Cedar Lane'];
}

// Two speech-to-text setups, so switching between them is one word in SPEECH.
// Both start replying soon after the caller stops (Vapi's default wait is
// 0.4 s), and both are told to expect weekday and service names.
export const SPEECH_OPTIONS = {
  // Deepgram Flux decides itself when the caller has finished, quickly, but
  // only does general English. On four test calls from a caller with an
  // Indian English accent it misheard "Thursday" ("seven o'clock",
  // "Tuesday"), "plus" ("less"), "detail" ("Victor"), and dropped digits.
  // eotThreshold stays at the default 0.7: 0.8 added about 1.1 s to every
  // turn. No smartEndpointingPlan with Flux, or it bypasses Flux's own
  // end-of-turn detection. Vapi's docs don't confirm keyterm reaches Flux.
  flux: {
    transcriber: {
      provider: 'deepgram',
      model: 'flux-general-en',
      language: 'en',
      eotThreshold: 0.7,
      keyterm: keyterms(),
    },
    startSpeakingPlan: { waitSeconds: 0.2 },
  },
  // Deepgram Nova-3 with Indian English (en-IN), which Flux doesn't offer,
  // and where Deepgram documents keyterm support. Nova-3 doesn't detect the
  // end of a turn itself, so Vapi's LiveKit model does that.
  nova3IndianEnglish: {
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en-IN', keyterm: keyterms() },
    startSpeakingPlan: { waitSeconds: 0.2, smartEndpointingPlan: { provider: 'livekit' } },
  },
};

// Nova-3 is being tried after Flux kept mishearing the test caller. If calls
// get slower or turns get cut off, switch back to SPEECH_OPTIONS.flux.
const SPEECH = SPEECH_OPTIONS.nova3IndianEnglish;

export function assistantConfig({ publicUrl, secret }: { publicUrl: string; secret: string }) {
  const base = `${publicUrl.replace(/\/+$/, '')}/vapi/${secret}`;
  return {
    name: 'Cedar Lane Receptionist',
    // Must not contain the end-call phrase, or Vapi would hang up on hello.
    firstMessage: `${shop.name}, how can I help you?`,
    // Vapi appends /chat/completions to this URL. The agent runs here, tools
    // and all; Vapi only handles the phone line and speech.
    model: { provider: 'custom-llm', url: `${base}/v1`, model: 'cedar-lane-receptionist' },
    voice: { provider: 'vapi', voiceId: 'Elliot' },
    // Speech-to-text and when to reply: see SPEECH below.
    ...SPEECH,
    // The agent says CLOSING when it hangs up (see vapi.ts); this makes Vapi
    // end the call once it's said.
    endCallPhrases: [END_CALL_PHRASE],
    // Call events go here, so a call is logged when the caller hangs up.
    server: { url: `${base}/events` },
    serverMessages: ['end-of-call-report', 'status-update'],
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 600,
  };
}

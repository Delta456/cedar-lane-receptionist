import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantConfig, keyterms, SPEECH_OPTIONS } from '../../../src/channels/voice/assistant.ts';
import { END_CALL_PHRASE } from '../../../src/channels/voice/vapi.ts';

const config = assistantConfig({ publicUrl: 'https://example.trycloudflare.com/', secret: 'secret-1234567890' });

test('Vapi calls this server, behind the secret', () => {
  assert.equal(config.model.url, 'https://example.trycloudflare.com/vapi/secret-1234567890/v1');
  assert.equal(config.server.url, 'https://example.trycloudflare.com/vapi/secret-1234567890/events');
});

test('speech-to-text is Nova-3 with Indian English, with turn ends detected by LiveKit', () => {
  assert.deepEqual(config.transcriber, SPEECH_OPTIONS.nova3IndianEnglish.transcriber);
  assert.equal(config.transcriber.language, 'en-IN');
  assert.deepEqual(config.startSpeakingPlan, { waitSeconds: 0.2, smartEndpointingPlan: { provider: 'livekit' } });
});

test('the Flux setup to switch back to keeps its default threshold: 0.8 made every turn a second slower', () => {
  assert.equal(SPEECH_OPTIONS.flux.transcriber.eotThreshold, 0.7);
  assert.deepEqual(SPEECH_OPTIONS.flux.startSpeakingPlan, { waitSeconds: 0.2 });
});

test('the closing line ends the call, and the greeting does not', () => {
  assert.deepEqual(config.endCallPhrases, [END_CALL_PHRASE]);
  assert.ok(!config.firstMessage.toLowerCase().includes(END_CALL_PHRASE));
});

test('speech-to-text is told to expect weekdays and the service names, as plain phrases', () => {
  const terms = keyterms();
  assert.ok(terms.includes('Thursday'));
  assert.ok(terms.includes('Interior detail and wash'));
  assert.ok(terms.includes('Full detail'));
  assert.ok(terms.includes('Paint correction') && terms.includes('ceramic coating'));
  // Deepgram's keyterms take no punctuation like brackets, slashes or "&".
  assert.ok(
    terms.every((term) => /^[A-Za-z ]+$/.test(term)),
    terms.join(', '),
  );
  assert.deepEqual(config.transcriber.keyterm, terms);
});

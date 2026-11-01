// Client for any OpenAI-compatible chat completions API. Defaults to NVIDIA's
// hosted endpoint; pointing LLM_BASE_URL at Ollama or llama.cpp runs the same
// model locally with no other change.
import OpenAI from 'openai';

const NOT_FOUND_RETRIES = 3;

export function createLlmClient(options: { baseURL: string; apiKey: string }): OpenAI {
  return new OpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    // Applies to each attempt, so one hung request can't stall a call.
    timeout: 30_000,
    // Retries connection errors, 408, 409, 429 and 5xx with backoff.
    maxRetries: 4,
    fetch: retryNotFound(globalThis.fetch),
  });
}

// NVIDIA's hosted endpoint sometimes answers a valid model request with a
// bodiless 404 under load (17 of about 250 requests in one eval run). The
// model name never changes at runtime, so a 404 here is transient: retry it
// with backoff, which the SDK won't do since 404 normally means "not there".
export function retryNotFound(
  fetchImpl: typeof fetch,
  { retries = NOT_FOUND_RETRIES, baseDelayMs = 500 } = {},
): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(input, init);
      if (response.status !== 404 || attempt >= retries) {
        return response;
      }
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  };
}

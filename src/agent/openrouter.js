import { AsyncLocalStorage } from 'node:async_hooks';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The `provider` field for a request. A provider pins the model to it (no
// fallback to others); absent, empty or whitespace means OpenRouter's own
// routing, so no field is sent at all.
export function providerPreference(provider) {
  const slug = typeof provider === 'string' ? provider.trim() : '';
  return slug ? { provider: { order: [slug], allow_fallbacks: false } } : {};
}

// The provider saved for one model id (config.modelProviders, set by
// /set_model), or '' for OpenRouter's default. Each model resolves on its own.
export function providerFor(config, model) {
  const provider = config?.modelProviders?.[model];
  return typeof provider === 'string' ? provider.trim() : '';
}

// The running turn's stop signal (messageHandler sets it, a "@Panda stop"
// fires it). Every model call made inside the turn, tools included (research,
// set_rule), picks it up without threading it through each call site.
export const turnSignal = new AsyncLocalStorage();

// One chat-completions call. Returns the assistant message object
// ({ content, tool_calls? }), throws only on real API errors (bad key, unknown
// model, ...) since those never succeed on a retry.
//
// Everything transient (network, 429, 5xx, and a provider that goes silent) is
// retried with no limit: turns run one at a time per server, so a call left
// hanging froze the bot for everyone there. A silent attempt is dropped after
// `attemptMs` and sent again, and each retry waits `attemptMs` longer, so a model
// that is merely slow still gets through. A stopped turn is never retried.
//
// `onUsage` gets the call's token counts and cost ({ prompt_tokens,
// completion_tokens, cost }) whenever OpenRouter reports them.
export async function chatCompletion({ apiKey, model, provider, messages, tools, toolChoice = 'auto', attemptMs = 60_000, backoffMs = 1500, onUsage, signal = turnSignal.getStore() }) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let res;
    let text;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        // Covers reading the body too, so a reply that stalls halfway is caught.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(attemptMs * (attempt + 1))]) : AbortSignal.timeout(attemptMs * (attempt + 1)),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/oskip0906/panda-bot',
          'X-Title': 'panda-bot',
        },
        body: JSON.stringify({
          model,
          ...providerPreference(provider),
          messages,
          usage: { include: true },
          ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      const why = err.name === 'TimeoutError' ? `no answer in ${(attemptMs * (attempt + 1)) / 1000}s` : err.message;
      console.warn(`[openrouter] ${model} attempt ${attempt + 1} failed (${why}) — retrying`);
      await sleep(Math.min(backoffMs * (attempt + 1), 30_000));
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`OpenRouter returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error).slice(0, 300)}`);
    }
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('OpenRouter response had no choices');
    if (data.usage) onUsage?.(data.usage);
    return message;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Served by many providers, so a rate-limited primary model still gets an answer.
export const FALLBACK_MODEL = 'deepseek/deepseek-v4.1-flash';
const MAX_ATTEMPTS = 3;
// Models that refused to run with reasoning off ("Reasoning is mandatory"): they get low effort from then on.
const needsReasoning = new Set();

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
// ({ content, tool_calls? }), throws on real API errors (bad key, unknown
// model, ...) since those never succeed on a retry.
//
// Made to be quick, because turns run one at a time per server and a slow call
// holds everyone up. Reasoning is off unless the caller passes `reasoning`; a
// model that insists on it is remembered and sent low effort. OpenRouter is told
// to use `fallback` when the model's providers are rate-limited or down, except
// with a pinned provider (it would bind the fallback too) or images and files
// (the fallback may not read them). Anything transient (network, 429, 5xx, a
// provider silent for `attemptMs`) gets at most MAX_ATTEMPTS tries, and tries 2
// and 3 go straight to the fallback: a model that timed out or kept answering
// 429 gets no more chances. After the last try the call throws. A stopped turn
// is never retried.
//
// `onUsage` gets the call's token counts and cost ({ prompt_tokens,
// completion_tokens, cost }) whenever OpenRouter reports them.
export async function chatCompletion({ apiKey, model, provider, messages, tools, toolChoice = 'auto', reasoning = { enabled: false }, fallback = FALLBACK_MODEL, attemptMs = 60_000, backoffMs = 1500, onUsage, signal = turnSignal.getStore() }) {
  const pin = providerPreference(provider);
  const failover = fallback && fallback !== model && !messages.some((m) => Array.isArray(m.content)) ? fallback : null;
  let why;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    // Tries 2 and 3 go to the fallback alone. The first lists it for OpenRouter to try by itself, unless a pinned provider would bind it too.
    const target = attempt > 0 && failover ? failover : model;
    const route = target !== model ? { model: target } : { model, ...pin, ...(failover && !pin.provider ? { models: [model, failover] } : {}) };
    const think = reasoning?.enabled === false && needsReasoning.has(target) ? { effort: 'low' } : reasoning;
    let res;
    let text;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        // Covers reading the body too, so a reply that stalls halfway is caught.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]) : AbortSignal.timeout(attemptMs),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/oskip0906/panda-bot',
          'X-Title': 'panda-bot',
        },
        body: JSON.stringify({
          ...route,
          messages,
          usage: { include: true },
          reasoning: think,
          ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      why = err.name === 'TimeoutError' ? `no answer in ${attemptMs / 1000}s` : err.message;
      console.warn(`[openrouter] ${target} attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${why})`);
      if (attempt < MAX_ATTEMPTS - 1) await sleep(Math.min(backoffMs * (attempt + 1), 30_000));
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`OpenRouter returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    // Resent at once on the same model, and not counted as a try.
    if (res.status === 400 && think?.enabled === false && /reasoning is mandatory/i.test(data.error?.message)) {
      console.warn(`[openrouter] ${target} requires reasoning — using low effort from now on`);
      needsReasoning.add(target);
      attempt--;
      continue;
    }
    if (data.error) {
      throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error).slice(0, 300)}`);
    }
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('OpenRouter response had no choices');
    if (data.usage) onUsage?.(data.usage);
    return message;
  }
  throw new Error(`${model} did not answer after ${MAX_ATTEMPTS} tries (${why})`);
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One chat-completions call. Retries transient failures (network, 429, 5xx),
// throws on real API errors. Returns the assistant message object
// ({ content, tool_calls? }).
export async function chatCompletion({ apiKey, model, messages, tools, maxRetries = 3 }) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/oskip0906/panda-bot',
          'X-Title': 'panda-bot',
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        }),
      });
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`OpenRouter HTTP ${res.status}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
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
    return message;
  }
  throw lastErr ?? new Error('OpenRouter request failed after retries');
}

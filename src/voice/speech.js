import { redactSecrets } from '../config.js';

// PMS's speech API (OpenAI-compatible), paid with config.pmsAiKey: squall turns
// speech into text, thunder turns text into speech.
const BASE_URL = 'https://api.pmservers.org/ai/v1';
const TIMEOUT_MS = 30_000;
// Sent with every sentence: thunder has no memory between calls, so this is
// what keeps Panda in one voice from the first sentence to the last.
const VOICE_STYLE = 'A relaxed, friendly young adult with a warm, medium-pitched voice and a casual, unhurried pace.';

async function post(config, path, { body, headers }, fetchImpl) {
  const res = await fetchImpl(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pmsAiKey}`, ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`PMS ${path} answered ${res.status}: ${redactSecrets(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

// A WAV file of someone speaking, as text. '' when nothing was made out.
export async function transcribe(config, wavBuffer, { fetchImpl = fetch } = {}) {
  const form = new FormData();
  form.append('model', 'squall');
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
  const res = await post(config, '/audio/transcriptions', { body: form }, fetchImpl);
  return String((await res.json()).text ?? '').trim();
}

// Text as a WAV file (24 kHz, mono, 16-bit).
export async function synthesize(config, text, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify({ model: 'thunder', input: text, voice: 'alloy', instructions: VOICE_STYLE, response_format: 'wav' });
  const res = await post(config, '/audio/speech', { body, headers: { 'Content-Type': 'application/json' } }, fetchImpl);
  return Buffer.from(await res.arrayBuffer());
}

// Text as speech, streamed: resolves as soon as thunder starts answering, to
// the WAV's bytes as they arrive, so playback can start before the file is
// whole. The body is read ahead of playback, so a long sentence played at
// speaking pace never runs into the request's timeout.
export async function synthesizeStream(config, text, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify({ model: 'thunder', input: text, voice: 'alloy', instructions: VOICE_STYLE, response_format: 'wav' });
  const res = await post(config, '/audio/speech', { body, headers: { 'Content-Type': 'application/json' } }, fetchImpl);
  return readAhead(res.body);
}

// An async iterable of byte chunks, read as fast as it arrives and handed out
// as fast as they are asked for. A read failure is thrown after what came before it.
function readAhead(source) {
  const chunks = [];
  let done = false;
  let failure = null;
  let wake = null;
  (async () => {
    try {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk));
        wake?.();
      }
    } catch (err) {
      failure = err;
    } finally {
      done = true;
      wake?.();
    }
  })();
  return (async function* () {
    for (;;) {
      if (chunks.length) yield chunks.shift();
      else if (failure) throw failure;
      else if (done) return;
      else {
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    }
  })();
}

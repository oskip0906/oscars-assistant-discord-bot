import { redactSecrets } from '../config.js';

// PMS's speech API (OpenAI-compatible), paid with config.pmsAiKey: squall turns
// speech into text, thunder turns text into speech.
const BASE_URL = 'https://api.pmservers.org/ai/v1';
const TIMEOUT_MS = 30_000;
const SPEECH_TIMEOUT_MS = 90_000; // covers PMS's queue, the render and reading the clip
// Thunder ignores `voice` (the API still requires one) and makes up a speaker
// for each text from `instructions`. A description without a gender and age
// gave a man for one sentence and a woman for the next, so this one pins both.
// session.js sends each sentence as its own request, so it must stay word for word.
const VOICE_STYLE = 'A calm young man in his twenties with a low, warm, relaxed voice, an even conversational pace, steady volume and a neutral North American accent.';
const SPEECH = { model: 'thunder', voice: 'alloy', instructions: VOICE_STYLE, response_format: 'wav' };

async function post(config, path, { body, headers, signal, timeoutMs = TIMEOUT_MS }, fetchImpl) {
  const res = await fetchImpl(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pmsAiKey}`, ...headers },
    body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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

// Text as speech: resolves when thunder starts answering, to the WAV's bytes
// as they arrive. Thunder answers only once the whole clip is made (about as
// long as the clip itself), so session.js asks for one sentence at a time. The
// body is read ahead of playback, so a clip played at speaking pace never runs
// into the request's timeout. `signal` cuts the request (and the download) short.
export async function synthesizeStream(config, text, { fetchImpl = fetch, signal } = {}) {
  const body = JSON.stringify({ ...SPEECH, input: text });
  const res = await post(config, '/audio/speech', { body, headers: { 'Content-Type': 'application/json' }, signal, timeoutMs: SPEECH_TIMEOUT_MS }, fetchImpl);
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

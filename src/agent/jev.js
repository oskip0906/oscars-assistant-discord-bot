const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
// Pinned rather than ~typesafe/jev-latest: the thresholds callers use were
// picked against this version's probabilities.
const JEV_MODEL = 'typesafe/jev-1.13';

// One Jev decision call: a state plus typed questions (noul / choice / score),
// answered with probabilities instead of text. Returns the answers map keyed by
// question name, or null when Jev is off or the call fails — every caller then
// falls back to what Panda did before Jev, so an outage never breaks a turn.
export async function decide(config, state, questions, { fetchImpl = fetch } = {}) {
  if (!config?.jevEnabled || !config.openrouterApiKey) return null;
  try {
    const res = await fetchImpl(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openrouterApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      // Jev answers in ~0.2s; anything this slow is better skipped than waited on.
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (!res.ok || !data?.answers) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data.answers;
  } catch (err) {
    console.error('[jev] decision failed:', String(err.message || err).slice(0, 200));
    return null;
  }
}

// Jev answers with probabilities and ignores a `temperature` field (checked:
// 0 and 2 return the same numbers), so the randomness is applied here. Social
// calls (whether to chime in, react or talk) sample from Jev's probabilities so
// Panda isn't the same every time; tool picks keep their fixed thresholds.
// A temperature above 1 flattens the odds, below 1 sharpens them.
export const SOCIAL_TEMPERATURE = 1.5;

const tempered = (p, temperature) => Math.max(0, Number(p) || 0) ** (1 / temperature);

// One choice drawn from a Jev choice answer, or null when it has no probabilities.
export function sampleChoice(answer, { temperature = SOCIAL_TEMPERATURE, random = Math.random } = {}) {
  const weights = Object.entries(answer?.probabilities ?? {}).map(([name, p]) => [name, tempered(p, temperature)]);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  if (!total) return answer?.choice ?? null;
  let r = random() * total;
  for (const [name, w] of weights) if ((r -= w) < 0) return name;
  return weights.at(-1)[0];
}

// A yes drawn from a Jev noul probability; a missing answer is no.
export function sampleYes(p, { temperature = SOCIAL_TEMPERATURE, random = Math.random } = {}) {
  if (!Number.isFinite(p)) return false;
  const yes = tempered(p, temperature);
  const no = tempered(1 - p, temperature);
  return yes + no > 0 && random() < yes / (yes + no);
}

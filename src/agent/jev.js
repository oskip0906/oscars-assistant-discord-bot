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

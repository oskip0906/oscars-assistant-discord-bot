// model_info and /model <model>: what OpenRouter says about one model — price,
// context, max output, architecture and the providers that serve it. Purely a
// lookup: it never touches the model Panda runs on (that is /set_model).
// OpenRouter's model endpoints are public, so no API key is sent here.

const API = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 10_000;

export const defs = [
  {
    type: 'function',
    function: {
      name: 'model_info',
      description:
        'Look up any OpenRouter model (the same as /model <model>): its id, name, description, input and output price (per token and per 1M tokens), context length, max output, architecture and supported parameters, and the providers that serve it with their own context and prices. Takes a name or an id ("gpt-6-luna" or "openai/gpt-6-luna") and finds the closest match. Use it whenever someone asks what a model costs, how big its context is, or who serves it — never answer those from memory. Purely informational; it does not switch models.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model name or OpenRouter id, e.g. "gpt-6-luna" or "openai/gpt-6-luna".' },
        },
        required: ['model'],
      },
    },
  },
];

async function getJson(path, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`OpenRouter HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// The full catalog changes rarely and autocomplete asks on every keystroke, so
// it is fetched once and reused for a while.
const CATALOG_TTL_MS = 10 * 60 * 1000;
const catalogCache = {};

export async function fetchModelCatalog({ fetchImpl = fetch, cache = catalogCache, now = Date.now } = {}) {
  if (!cache.models || now() - cache.at > CATALOG_TTL_MS) {
    const body = await getJson('/models', fetchImpl);
    cache.models = Array.isArray(body?.data) ? body.data.filter((m) => m?.id) : [];
    cache.at = now();
  }
  return cache.models;
}

// The model's own page, then its endpoints (the providers). Either may be
// missing or down; the catalog entry is enough to answer, so neither throws.
async function fetchDetails(id, fetchImpl) {
  const path = id.split('/').map(encodeURIComponent).join('/');
  const detail = await getJson(`/models/${path}`, fetchImpl).then((b) => b?.data ?? null).catch(() => null);
  if (Array.isArray(detail?.endpoints)) return { detail, endpoints: detail.endpoints };
  const endpoints = await getJson(`/models/${path}/endpoints`, fetchImpl).then((b) => b?.data?.endpoints ?? null).catch(() => null);
  return { detail, endpoints: Array.isArray(endpoints) ? endpoints : null };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slugOf = (id) => String(id).split('/').pop();

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// 0–1: how well the query names this model, by its id, its id without the
// vendor, or its display name. Containing the whole query scores high, more so
// the less else there is; otherwise it is edit distance.
function score(query, model) {
  let best = 0;
  for (const raw of [model.id, slugOf(model.id), model.name]) {
    const text = norm(raw);
    if (!text) continue;
    const s = text.includes(query)
      ? 0.8 + 0.2 * (query.length / text.length)
      : 1 - levenshtein(query, text) / Math.max(query.length, text.length);
    best = Math.max(best, s);
  }
  return best;
}

const PICK_SCORE = 0.8;
const CLEAR_LEAD = 0.05;

// An exact id (any case), an exact id without its vendor, or an exact name wins
// outright. Otherwise the best fuzzy match is taken only when it is good and
// clearly ahead; if not, the closest few come back as suggestions.
export function resolveModel(query, models) {
  const raw = String(query ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return { match: null, candidates: [] };
  const exact = models.find((m) => m.id.toLowerCase() === lower);
  if (exact) return { match: exact, candidates: [] };
  // "gpt-6-luna" for "openai/gpt-6-luna" — unless two vendors share the name.
  const sameSlug = lower.includes('/') ? [] : models.filter((m) => slugOf(m.id).toLowerCase() === lower);
  if (sameSlug.length === 1) return { match: sameSlug[0], candidates: [] };
  if (sameSlug.length > 1) return { match: null, candidates: sameSlug.slice(0, 5) };
  const named = models.find((m) => String(m.name ?? '').toLowerCase() === lower);
  if (named) return { match: named, candidates: [] };

  const q = norm(raw);
  if (!q) return { match: null, candidates: [] };
  const ranked = models.map((m) => ({ m, s: score(q, m) })).sort((a, b) => b.s - a.s);
  const [first, second] = ranked;
  if (first && first.s >= PICK_SCORE && (!second || first.s - second.s >= CLEAR_LEAD)) return { match: first.m, candidates: [] };
  return { match: null, candidates: ranked.filter((r) => r.s >= 0.3).slice(0, 5).map((r) => r.m) };
}

// Prices come as USD per token, in strings; "-1" means it varies (routers).
function price(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return { varies: true };
  return { perToken: n, perMillion: n * 1e6 };
}

// 1.5e-7 reads as 0.00000015: three significant digits, never exponent form.
const plain = (n) => n.toFixed(Math.min(20, Math.max(0, 2 - Math.floor(Math.log10(n))))).replace(/\.?0+$/, '');

const usd = (n) => (n === 0 ? '$0' : n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toPrecision(3))}`);

export function formatPrice(value) {
  const p = price(value);
  if (!p) return 'unknown';
  if (p.varies) return 'varies by routed model';
  if (p.perToken === 0) return 'free';
  return `${usd(p.perMillion)} / 1M tokens (${plain(Number(p.perToken.toPrecision(3)))} per token)`;
}

const perMillion = (value) => {
  const p = price(value);
  if (!p) return '?';
  if (p.varies) return 'varies';
  return p.perToken === 0 ? 'free' : usd(p.perMillion);
};

export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e6) return `${Number((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `${Number((v / 1e3).toFixed(1))}K`;
  return String(v);
}

const withCount = (n) => (formatTokens(n) ? `${formatTokens(n)} tokens (${Number(n).toLocaleString('en-US')})` : 'unknown');

// Everything the card and the text answer show, gathered from the catalog
// entry, the model's own page and its endpoints.
export function summarizeModel(model, { detail = null, endpoints = null } = {}) {
  const m = { ...model, ...(detail || {}) };
  const arch = m.architecture || {};
  const providers = (endpoints || []).map((e) => ({
    name: e.provider_name || e.name || e.tag || 'unknown',
    tag: e.tag || '',
    quantization: e.quantization && e.quantization !== 'unknown' ? e.quantization : '',
    contextLength: e.context_length ?? null,
    maxOutput: e.max_completion_tokens ?? null,
    input: e.pricing?.prompt ?? null,
    output: e.pricing?.completion ?? null,
  }));
  // Two endpoints from one provider (say, two Azure regions) are told apart by their tag.
  const seen = providers.reduce((n, p) => n.set(p.name, (n.get(p.name) || 0) + 1), new Map());
  for (const p of providers) if (seen.get(p.name) > 1 && p.tag) p.name = `${p.name} (${p.tag})`;
  return {
    id: m.id,
    name: m.name || m.id,
    description: String(m.description || '').trim(),
    input: m.pricing?.prompt ?? null,
    output: m.pricing?.completion ?? null,
    contextLength: m.context_length ?? m.top_provider?.context_length ?? null,
    maxOutput: m.top_provider?.max_completion_tokens ?? null,
    architecture: {
      modality: arch.modality || '',
      inputs: Array.isArray(arch.input_modalities) ? arch.input_modalities : [],
      outputs: Array.isArray(arch.output_modalities) ? arch.output_modalities : [],
      tokenizer: arch.tokenizer || '',
      instructType: arch.instruct_type || '',
    },
    parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    providers,
    providersKnown: Array.isArray(endpoints),
  };
}

function architectureLines(info) {
  const a = info.architecture;
  const lines = [];
  if (a.inputs.length || a.outputs.length) lines.push(`Modality: ${a.inputs.join(', ') || '?'} → ${a.outputs.join(', ') || '?'}`);
  else if (a.modality) lines.push(`Modality: ${a.modality}`);
  if (a.tokenizer) lines.push(`Tokenizer: ${a.tokenizer}`);
  if (a.instructType) lines.push(`Instruct type: ${a.instructType}`);
  if (info.parameters.length) lines.push(`Parameters: ${info.parameters.join(', ')}`);
  return lines;
}

// One line per provider; context, max output and price are shown only where
// they differ from the model's headline numbers, so the list stays short.
function providerLine(p, info) {
  const bits = [];
  if (p.quantization) bits.push(p.quantization);
  if (p.contextLength && p.contextLength !== info.contextLength) bits.push(`${formatTokens(p.contextLength)} ctx`);
  if (p.maxOutput && p.maxOutput !== info.maxOutput) bits.push(`max out ${formatTokens(p.maxOutput)}`);
  if ((p.input != null && Number(p.input) !== Number(info.input)) || (p.output != null && Number(p.output) !== Number(info.output))) {
    bits.push(`${perMillion(p.input)} in / ${perMillion(p.output)} out per 1M`);
  }
  return `${p.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// Lines joined under a cap, ending with how many did not fit.
function fitLines(lines, max) {
  const out = [];
  let used = 0;
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i;
    const more = rest > 1 ? `\n…and ${rest - 1} more` : '';
    if (used + line.length + 1 + more.length > max && out.length) {
      out.push(`…and ${rest} more`);
      break;
    }
    out.push(clip(line, max));
    used += line.length + 1;
  }
  return out.join('\n');
}

// Discord embed limits: title 256, description 4096, field name 256, field
// value 1024, all text 6000. Kept well under so it reads as a chat-sized card.
export function modelCard(info) {
  const fields = [
    { name: '🆔 Name / ID', value: clip(`**${info.name}**\n\`${info.id}\``, 1024), inline: false },
    { name: '📝 Description', value: clip(info.description || 'No description.', 700), inline: false },
    { name: '📥 Input price', value: clip(formatPrice(info.input), 1024), inline: true },
    { name: '📤 Output price', value: clip(formatPrice(info.output), 1024), inline: true },
    { name: '​', value: '​', inline: true },
    { name: '📏 Context length', value: withCount(info.contextLength), inline: true },
    { name: '✍️ Max output', value: withCount(info.maxOutput), inline: true },
    { name: '​', value: '​', inline: true },
    { name: '🏗️ Architecture / parameters', value: clip(architectureLines(info).join('\n') || 'Not listed.', 600), inline: false },
    {
      name: `🛰️ Providers${info.providers.length ? ` (${info.providers.length})` : ''}`,
      value: info.providers.length
        ? fitLines(info.providers.map((p) => providerLine(p, info)), 800)
        : info.providersKnown
          ? 'None listed right now.'
          : 'Couldn’t load the provider list.',
      inline: false,
    },
  ];
  return {
    title: clip(`🧠 ${info.name}`, 256),
    url: `https://openrouter.ai/${info.id}`,
    fields,
    footer: 'OpenRouter · prices in USD · provider lines show only what differs',
  };
}

// The same facts as plain text, for the conversation model.
export function modelText(info) {
  return [
    `[OPENROUTER MODEL — ${info.id}]`,
    `Name: ${info.name}`,
    `Description: ${clip(info.description || 'none', 1500)}`,
    `Input price: ${formatPrice(info.input)}`,
    `Output price: ${formatPrice(info.output)}`,
    `Context length: ${withCount(info.contextLength)}`,
    `Max output: ${withCount(info.maxOutput)}`,
    ...architectureLines(info),
    info.providers.length
      ? `Providers (${info.providers.length}):\n${info.providers.map((p) => `- ${providerLine(p, info)}`).join('\n')}`
      : `Providers: ${info.providersKnown ? 'none listed right now' : 'could not load the list'}`,
    `Page: https://openrouter.ai/${info.id}`,
  ].join('\n');
}

const suggest = (query, candidates) =>
  `🔎 No model found for \`${clip(String(query).trim(), 80)}\`.${
    candidates.length ? ` Did you mean ${candidates.map((m) => `\`${m.id}\``).join(', ')}?` : ' Check the spelling, or try its OpenRouter id (vendor/model).'
  }`;

// Never throws. { ok: true, info } with the summary, or { ok: false, message }
// for an unknown model (with suggestions) or an unreachable OpenRouter.
export async function lookupModel(query, { fetchImpl = fetch, catalog = fetchModelCatalog } = {}) {
  const wanted = String(query ?? '').trim();
  if (!wanted) return { ok: false, message: 'Give me a model name or id, e.g. `openai/gpt-6-luna`.' };
  let models;
  try {
    models = await catalog({ fetchImpl });
  } catch (err) {
    console.error('[model_info] could not list OpenRouter models:', err.message);
    return { ok: false, message: `⚠️ Couldn’t reach OpenRouter to look that up (${clip(String(err.message || err), 120)}). Try again in a bit.` };
  }
  const { match, candidates } = resolveModel(wanted, models);
  if (!match) return { ok: false, message: suggest(wanted, candidates) };
  const details = await fetchDetails(match.id, fetchImpl);
  return { ok: true, info: summarizeModel(match, details) };
}

export async function modelInfo({ model } = {}, _invocation, { lookup = lookupModel } = {}) {
  const found = await lookup(model);
  if (!found.ok) return `${found.message}\n(Say so; do not make up details about the model.)`;
  return `${modelText(found.info)}\n(To show it as a card, send_card with these facts works well.)`;
}

// Autocomplete for /model: ids matching what has been typed, from the cached catalog.
export async function modelInfoChoices(focused, { catalog = fetchModelCatalog } = {}) {
  let models;
  try {
    models = await catalog();
  } catch (err) {
    console.error('[model_info] could not list OpenRouter models:', err.message);
    return [];
  }
  const q = String(focused ?? '').toLowerCase();
  return models
    .filter((m) => m.id.toLowerCase().includes(q) || String(m.name ?? '').toLowerCase().includes(q))
    .slice(0, 25)
    .map((m) => ({ name: clip(`${m.id}${m.name ? ` — ${m.name}` : ''}`, 100), value: m.id.slice(0, 100) }));
}

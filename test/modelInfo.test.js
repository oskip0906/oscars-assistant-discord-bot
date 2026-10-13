import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, lookupModel, modelCard, modelInfo, formatPrice, summarizeModel, modelInfoChoices } from '../src/agent/tools/modelInfo.js';
import { pandaCommands } from '../src/agent/tools/commands.js';
import { commandDefs } from '../src/discord/commandDefs.js';
import { sendCard } from '../src/agent/tools/ui.js';

const LUNA = {
  id: 'openai/gpt-6-luna',
  name: 'OpenAI: GPT-6 Luna',
  description: 'A fast model. '.repeat(200),
  context_length: 400000,
  pricing: { prompt: '0.0000025', completion: '0.00001' },
  top_provider: { max_completion_tokens: 128000, context_length: 400000 },
  architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'GPT' },
  supported_parameters: ['tools', 'temperature', 'max_tokens'],
};
const CATALOG = [
  LUNA,
  { id: 'openai/gpt-6-luna-mini', name: 'OpenAI: GPT-6 Luna Mini', pricing: { prompt: '0', completion: '0' } },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', pricing: { prompt: '0.000003', completion: '0.000015' } },
  { id: 'meta/llama-9-8b', name: 'Meta: Llama 9 8B' },
  { id: 'other/llama-9-8b', name: 'Other: Llama 9 8B' },
];
const ENDPOINTS = [
  { provider_name: 'OpenAI', tag: 'openai', context_length: 400000, max_completion_tokens: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
  { provider_name: 'Azure', tag: 'azure', context_length: 200000, max_completion_tokens: 64000, pricing: { prompt: '0.000003', completion: '0.000012' } },
];

// A fake OpenRouter that records what was asked and how.
function fakeFetch({ detailStatus = 404 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/models')) return json({ data: CATALOG });
    if (url.endsWith('/endpoints')) return json({ data: { id: LUNA.id, endpoints: ENDPOINTS } });
    return json({ error: 'nope' }, detailStatus);
  };
  fn.calls = calls;
  return fn;
}
const fresh = (fetchImpl) => ({ fetchImpl, catalog: async () => CATALOG });

test('an exact id, a bare model name or a display name resolves straight away', () => {
  assert.equal(resolveModel('openai/gpt-6-luna', CATALOG).match.id, LUNA.id);
  assert.equal(resolveModel('OpenAI/GPT-6-Luna', CATALOG).match.id, LUNA.id);
  assert.equal(resolveModel('gpt-6-luna', CATALOG).match.id, LUNA.id);
  assert.equal(resolveModel('Anthropic: Claude Sonnet 5.5', CATALOG).match.id, 'anthropic/claude-sonnet-5.5');
});

test('a close fuzzy match is picked; a vague or shared name lists candidates instead', () => {
  assert.equal(resolveModel('claude sonnet', CATALOG).match.id, 'anthropic/claude-sonnet-5.5');
  assert.equal(resolveModel('gpt-6-lunna', CATALOG).match.id, LUNA.id);
  const vague = resolveModel('luna', CATALOG);
  assert.equal(vague.match, null);
  assert.deepEqual(vague.candidates.slice(0, 2).map((m) => m.id).sort(), [LUNA.id, 'openai/gpt-6-luna-mini']);
  const shared = resolveModel('llama-9-8b', CATALOG);
  assert.equal(shared.match, null);
  assert.equal(shared.candidates.length, 2);
});

test('prices are shown per 1M tokens and per token, free and variable ones in words', () => {
  assert.equal(formatPrice('0.0000025'), '$2.50 / 1M tokens (0.0000025 per token)');
  assert.equal(formatPrice('0'), 'free');
  assert.equal(formatPrice('-1'), 'varies by routed model');
  assert.equal(formatPrice(undefined), 'unknown');
});

test('a lookup reads the public endpoints with no API key and gathers the providers', async () => {
  const fetchImpl = fakeFetch();
  const found = await lookupModel('gpt-6-luna', fresh(fetchImpl));
  assert.equal(found.ok, true);
  assert.equal(found.info.id, LUNA.id);
  assert.equal(found.info.maxOutput, 128000);
  assert.deepEqual(found.info.providers.map((p) => p.name), ['OpenAI', 'Azure']);
  assert.ok(fetchImpl.calls.some((c) => c.url === 'https://openrouter.ai/api/v1/models/openai/gpt-6-luna'));
  for (const { opts } of fetchImpl.calls) assert.equal(opts?.headers?.Authorization, undefined, 'no key is sent');
});

test('the card fits Discord limits and shows only what each provider does differently', () => {
  const card = modelCard(summarizeModel(LUNA, { endpoints: ENDPOINTS }));
  const names = card.fields.map((f) => f.name);
  for (const want of ['Name / ID', 'Description', 'Input price', 'Output price', 'Context length', 'Max output', 'Architecture / parameters', 'Providers']) {
    assert.ok(names.some((n) => n.includes(want)), want);
  }
  assert.ok(card.title.length <= 256);
  for (const f of card.fields) assert.ok(f.value.length <= 1024 && f.name.length <= 256, f.name);
  const total = card.title.length + card.footer.length + card.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total < 6000);
  const providers = card.fields.find((f) => f.name.includes('Providers')).value;
  assert.match(providers, /^OpenAI$/m, 'same as the headline numbers: just the name');
  assert.match(providers, /Azure — 200K ctx · max out 64K · \$3\.00 in \/ \$12\.00 out per 1M/);
  assert.match(card.fields.find((f) => f.name.includes('Architecture')).value, /text, image → text[\s\S]*tools, temperature/);
});

test('the card goes out through send_card', async () => {
  const sent = [];
  const result = await sendCard(modelCard(summarizeModel(LUNA, { endpoints: ENDPOINTS })), { message: { channel: { send: async (p) => sent.push(p) } } });
  assert.match(result, /^Card posted/);
  assert.equal(sent[0].embeds[0].fields.length, 10);
});

test('an unknown model says so with suggestions, and an unreachable OpenRouter is a plain message', async () => {
  const unknown = await lookupModel('gpt-7-sol', fresh(fakeFetch()));
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /No model found for `gpt-7-sol`\. Did you mean `openai\/gpt-6-luna/);

  const down = await lookupModel('gpt-6-luna', {
    catalog: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(down.ok, false);
  assert.match(down.message, /Couldn’t reach OpenRouter.*fetch failed/);
  assert.doesNotMatch(down.message, /\n\s+at /, 'no stack trace');
});

test('the model_info tool answers in text and never makes things up on a miss', async () => {
  const text = await modelInfo({ model: 'gpt-6-luna' }, {}, { lookup: (q) => lookupModel(q, fresh(fakeFetch())) });
  assert.match(text, /\[OPENROUTER MODEL — openai\/gpt-6-luna\]/);
  assert.match(text, /Context length: 400K tokens/);
  const miss = await modelInfo({ model: 'zzz' }, {}, { lookup: async () => ({ ok: false, message: 'No model found' }) });
  assert.match(miss, /do not make up/);
});

test('/model keeps working with no option and documents the lookup option', () => {
  const cmd = commandDefs.find((c) => c.name === 'model');
  assert.equal(cmd.options.length, 1);
  assert.equal(cmd.options[0].required ?? false, false, 'plain /model still shows the running model');
  assert.match(cmd.options[0].description, /OpenRouter info for a specific model/);
  assert.match(pandaCommands({ command: 'model' }), /current_model[\s\S]*model_info/);
});

test('autocomplete suggests ids from the catalog, and nothing when it is down', async () => {
  const choices = await modelInfoChoices('luna', { catalog: async () => CATALOG });
  assert.deepEqual(choices.map((c) => c.value), [LUNA.id, 'openai/gpt-6-luna-mini']);
  assert.deepEqual(await modelInfoChoices('x', { catalog: async () => Promise.reject(new Error('down')) }), []);
});

test('nothing close at all still answers with a friendly miss', async () => {
  const miss = await lookupModel('zzzzqqq', fresh(fakeFetch()));
  assert.equal(miss.ok, false);
  assert.match(miss.message, /No model found for `zzzzqqq`\. Check the spelling/);
});

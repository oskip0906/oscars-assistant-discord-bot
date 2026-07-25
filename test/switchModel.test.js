import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEnvModel, switchModel, modelChoices } from '../src/discord/model.js';

const ENV = [
  '# Panda config',
  'DISCORD_TOKEN=super-secret',
  'OPENROUTER_MODEL=google/gemini-2.5-flash',
  '',
  'BOT_NAME=Panda   # trailing comment',
].join('\n');

function scaffoldEnv(contents = ENV) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-model-'));
  fs.writeFileSync(path.join(projectRoot, '.env'), contents);
  return { projectRoot };
}

const envLines = (config) => fs.readFileSync(path.join(config.projectRoot, '.env'), 'utf8').split('\n');

test('switching the model rewrites only the model line', () => {
  const config = scaffoldEnv();

  const result = writeEnvModel(config, 'openai/gpt-5.4');

  assert.equal(result.ok, true);
  assert.deepEqual(envLines(config), [
    '# Panda config',
    'DISCORD_TOKEN=super-secret',
    'OPENROUTER_MODEL=openai/gpt-5.4',
    '',
    'BOT_NAME=Panda   # trailing comment',
  ]);
});

test('a .env with no model line gets one appended', () => {
  const config = scaffoldEnv('DISCORD_TOKEN=super-secret\n');

  writeEnvModel(config, 'openai/gpt-5');

  const lines = envLines(config).filter(Boolean);
  assert.deepEqual(lines, ['DISCORD_TOKEN=super-secret', 'OPENROUTER_MODEL=openai/gpt-5']);
});

test('a model id that could smuggle extra env lines is refused', () => {
  const config = scaffoldEnv();

  const result = writeEnvModel(config, 'evil\nDISCORD_TOKEN=stolen');

  assert.equal(result.ok, false);
  assert.deepEqual(envLines(config), ENV.split('\n'), '.env must be untouched');
});

test('an empty model id is refused', () => {
  const config = scaffoldEnv();
  assert.equal(writeEnvModel(config, '   ').ok, false);
  assert.deepEqual(envLines(config), ENV.split('\n'));
});

// --- the command-level flow ---------------------------------------------

const CATALOG = ['google/gemini-2.5-flash', 'openai/gpt-5.4', 'openai/gpt-5'];

test('picking a real OpenRouter model writes it and asks for a restart', async () => {
  const config = { ...scaffoldEnv(), model: 'google/gemini-2.5-flash' };

  const result = await switchModel(
    { model: 'openai/gpt-5.4', config },
    { listModels: async () => CATALOG },
  );

  assert.equal(result.ok, true);
  assert.equal(result.restart, true);
  assert.match(result.summary, /openai\/gpt-5\.4/);
  assert.match(envLines(config).join('\n'), /OPENROUTER_MODEL=openai\/gpt-5\.4/);
});

test('a model OpenRouter does not serve is refused before the bot restarts into it', async () => {
  const config = { ...scaffoldEnv(), model: 'google/gemini-2.5-flash' };

  const result = await switchModel({ model: 'totally/made-up', config }, { listModels: async () => CATALOG });

  assert.equal(result.ok, false);
  assert.equal(result.restart, false);
  assert.match(envLines(config).join('\n'), /OPENROUTER_MODEL=google\/gemini-2\.5-flash/, 'must keep the working model');
});

test('switching to the model already running changes nothing', async () => {
  const config = { ...scaffoldEnv(), model: 'google/gemini-2.5-flash' };

  const result = await switchModel(
    { model: 'google/gemini-2.5-flash', config },
    { listModels: async () => CATALOG },
  );

  assert.equal(result.restart, false);
  assert.match(result.summary, /already/i);
});

test('an unreachable model catalog does not block a switch', async () => {
  const config = { ...scaffoldEnv(), model: 'google/gemini-2.5-flash' };

  const result = await switchModel(
    { model: 'openai/gpt-5.4', config },
    { listModels: async () => { throw new Error('offline'); } },
  );

  assert.equal(result.ok, true, 'OpenRouter being down should not strand Oscar on the old model');
  assert.match(result.summary, /couldn’t verify|could not verify/i);
});

// --- autocomplete ---------------------------------------------------------

test('autocomplete narrows the catalog to what Oscar is typing', async () => {
  const config = { openrouterApiKey: 'k', model: 'google/gemini-2.5-flash' };
  const catalog = ['google/gemini-2.5-flash', 'openai/gpt-5.4', 'openai/gpt-5'];

  const choices = await modelChoices(config, 'GPT', { listModels: async () => catalog, cache: {} });

  assert.deepEqual(
    choices.map((c) => c.value),
    ['openai/gpt-5.4', 'openai/gpt-5'],
  );
  assert.ok(choices.every((c) => c.name.length <= 100 && c.value.length <= 100));
});

test('autocomplete never exceeds Discord’s 25-choice cap', async () => {
  const config = { openrouterApiKey: 'k' };
  const catalog = Array.from({ length: 400 }, (_, i) => `vendor/model-${i}`);

  const choices = await modelChoices(config, '', { listModels: async () => catalog, cache: {} });

  assert.equal(choices.length, 25);
});

test('the catalog is fetched once and reused across keystrokes', async () => {
  const config = { openrouterApiKey: 'k' };
  const cache = {};
  let fetches = 0;
  const listModels = async () => {
    fetches++;
    return ['a/b', 'a/c'];
  };

  await modelChoices(config, 'a', { listModels, cache });
  await modelChoices(config, 'ab', { listModels, cache });

  assert.equal(fetches, 1, 'autocomplete fires on every keystroke — one fetch has to serve them all');
});

test('an OpenRouter outage makes autocomplete empty, not broken', async () => {
  const choices = await modelChoices({}, 'x', {
    listModels: async () => {
      throw new Error('offline');
    },
    cache: {},
  });
  assert.deepEqual(choices, []);
});

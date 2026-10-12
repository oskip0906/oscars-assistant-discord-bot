import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRules, parseRules, addRule as addToFile, DEFAULT_RULES_FILE } from '../src/agent/rulesFile.js';
import { addRule, removeRule } from '../src/agent/tools/rules.js';
import { executeTool } from '../src/agent/tools/index.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { runAgent } from '../src/agent/agent.js';

const tmpConfig = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-rules-'));
  return { botName: 'Panda', ownerId: '111111111111111111', model: 'm', openrouterApiKey: 'k', rulesFile: path.join(dir, 'RULES.md') };
};
const message = { channel: { name: 'general' }, author: { id: '2', username: 'someone' } };

test("the repo's RULES.md parses, and only lines under ## Rules are rules", () => {
  assert.ok(fs.existsSync(DEFAULT_RULES_FILE));
  assert.ok(Array.isArray(parseRules(fs.readFileSync(DEFAULT_RULES_FILE, 'utf8'))));
  assert.deepEqual(parseRules('# x\n- not a rule\n## Rules\n- one\ntext\n* two\n'), ['one', 'two']);
});

test('add_rule saves to the file, skips duplicates, and the rule reaches the next system prompt', async () => {
  const config = tmpConfig();
  assert.deepEqual(await readRules(config), [], 'a missing file is no rules');
  assert.match(await addRule({ rule: 'Always answer with a question.' }, { config }), /Rule saved[\s\S]*1\. Always answer with a question\./);
  assert.match(await addRule({ rule: 'always answer with a question' }, { config }), /already in RULES\.md/);
  await addRule({ rule: 'Never respond to Rice (id:123).' }, { config });
  assert.deepEqual(await readRules(config), ['Always answer with a question.', 'Never respond to Rice (id:123).']);
  assert.match(fs.readFileSync(config.rulesFile, 'utf8'), /## Rules\n- Always answer with a question\.\n- Never respond to Rice/);

  const prompt = await buildSystemPrompt({ config, guild: null, message });
  assert.match(prompt, /## Oscar's rules \(RULES\.md\)[\s\S]*1\. Always answer with a question\.\n2\. Never respond to Rice \(id:123\)\./);
  assert.match(prompt, /\[NO REPLY\]/);
});

test('rules added at once all land', async () => {
  const config = tmpConfig();
  await Promise.all(['a', 'b', 'c', 'd'].map((r) => addToFile(config, `rule ${r}`)));
  assert.deepEqual((await readRules(config)).sort(), ['rule a', 'rule b', 'rule c', 'rule d']);
});

test('remove_rule deletes by number or text and leaves the rest of the file alone', async () => {
  const config = tmpConfig();
  fs.writeFileSync(config.rulesFile, '# Panda\n\n- intro bullet\n\n## Rules\n- Be more mean.\n- Always tell a joke.\n- Never respond to Rice.\n');
  assert.match(await removeRule({ number: 2 }, { config }), /Removed[\s\S]*- Always tell a joke\./);
  assert.match(await removeRule({ match: 'MEAN' }, { config }), /Removed[\s\S]*- Be more mean\./);
  assert.match(await removeRule({ match: 'nothing like it' }, { config }), /nothing changed/);
  assert.match(await removeRule({}, { config }), /rule number or text/);
  assert.equal(fs.readFileSync(config.rulesFile, 'utf8'), '# Panda\n\n- intro bullet\n\n## Rules\n- Never respond to Rice.\n');
});

test('rule tools are Oscar only', async () => {
  const config = tmpConfig();
  const guest = { config, isOwner: false, message };
  assert.match(await executeTool('add_rule', { rule: 'be rude' }, guest), /restricted to Oscar/);
  assert.match(await executeTool('remove_rule', { number: 1 }, guest), /restricted to Oscar/);
  assert.deepEqual(await readRules(config), []);
});

test('[NO REPLY] sends nothing, not even a wave', async () => {
  const reactions = [];
  const invocation = { contextKey: 'g', config: tmpConfig(), message: { ...message, react: async (e) => reactions.push(e) } };
  const text = await runAgent(invocation, 'q', 'hi', { chat: async () => ({ content: '[NO REPLY]' }), decideImpl: async () => null });
  assert.equal(text, '');
  assert.equal(invocation.silent, true);
  assert.deepEqual(reactions, []);
});

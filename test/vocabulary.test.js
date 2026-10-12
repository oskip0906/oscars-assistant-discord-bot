import test from 'node:test';
import assert from 'node:assert/strict';
import { SLANG, vocabularyNote } from '../src/agent/vocabulary.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { commandDefs } from '../src/discord/commands.js';
import { isSignOff, addressee, pandaAliases } from '../src/discord/messageHandler.js';

const config = { botName: 'Panda', ownerId: '111111111111111111' };

test('the vocabulary loads into the system prompt', async () => {
  assert.ok(Object.keys(SLANG).length >= 40);
  for (const [word, meaning] of Object.entries(SLANG)) {
    assert.match(word, /^[a-z][a-z ]*$/, `${word} is plain lowercase words`);
    assert.ok(typeof meaning === 'string' && meaning.trim(), `${word} has a meaning`);
  }
  const prompt = await buildSystemPrompt({
    config,
    guild: null,
    message: { channel: {}, author: { id: '2', username: 'someone' } },
  });
  assert.ok(prompt.includes(vocabularyNote()));
  assert.match(prompt, /no cap \(honestly, no lie\)/);
});

test('no slang word collides with a command, a sign-off or one of Panda\'s names', () => {
  const commands = new Set(commandDefs.map((c) => c.name));
  const names = new RegExp(`^(?:${pandaAliases(config, { username: 'Panda' }, true).join('|')})$`, 'i');
  for (const word of Object.keys(SLANG)) {
    assert.ok(!/^[/!@#<:]/.test(word), `${word} looks like a command or mention`);
    assert.ok(!commands.has(word), `${word} is a slash command`);
    assert.ok(!commands.has(word.replace(/ /g, '_')), `${word} is a slash command`);
    assert.equal(isSignOff(word), false, `${word} would end a conversation`);
    assert.ok(!names.test(word), `${word} is one of Panda's names`);
    assert.equal(addressee({ content: word, author: { id: '2' } }, config, { id: 'bot', username: 'Panda' }), null, `${word} reads as addressing someone`);
  }
});

test('slang in a message leaves commands and sign-offs parsing as before', () => {
  assert.equal(new Set(commandDefs.map((c) => c.name)).size, commandDefs.length);
  assert.ok(commandDefs.some((c) => c.name === 'set_rule'));
  assert.equal(isSignOff('ngl that was fun, cya!'), true);
  assert.equal(isSignOff('gn all'), true);
  assert.equal(isSignOff('lowkey mid tbh'), false);
  assert.equal(isSignOff('bet, but can you check X first?'), false);
});

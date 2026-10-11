import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDefs } from '../src/discord/commands.js';

// Building the definitions runs discord.js's validation (names, 100-character
// descriptions), which would otherwise only fail when the bot boots.
test('every slash command builds, with /set_rule in and the memory commands gone', () => {
  const names = commandDefs.map((c) => c.name);
  assert.ok(names.includes('set_rule'));
  assert.ok(names.includes('index_chat'));
  assert.ok(names.includes('create_poll'));
  assert.ok(names.includes('create_card'));
  assert.ok(!names.includes('clear') && !names.includes('clearall'));
  assert.equal(new Set(names).size, names.length);
});

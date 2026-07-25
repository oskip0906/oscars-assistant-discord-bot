import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandDefs } from '../src/discord/commands.js';

test('run_dev is registered with an instruction and optional target repository', () => {
  const command = commandDefs.find((definition) => definition.name === 'run_dev');
  assert.ok(command);
  assert.equal(command.options[0].name, 'instruction');
  assert.equal(command.options[0].required, true);
  assert.equal(command.options[1].name, 'repo');
  assert.equal(command.options[1].required, false);
});

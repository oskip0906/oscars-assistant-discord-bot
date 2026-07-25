import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writableRepoChoices } from '../src/agent/tools/github.js';

test('repository autocomplete offers only writable repositories and filters the query', async () => {
  const choices = await writableRepoChoices(
    { githubPat: 'token' },
    'pan',
    {
      cache: {},
      listRepos: async () => ['oskip0906/notes', 'oskip0906/panda-bot', 'team/panda-tools'],
    },
  );
  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['oskip0906/panda-bot', 'team/panda-tools'],
  );
});

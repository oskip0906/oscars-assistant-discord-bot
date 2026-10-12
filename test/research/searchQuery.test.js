import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery } from '../../src/agent/research/searchQuery.js';

test('uses the model-written query', async () => {
  const ask = async () => ({ query: ' best pizza Naples ' });
  assert.equal(await buildSearchQuery({ request: 'hey can you find me the best pizza in naples', config: {}, ask }), 'best pizza Naples');
});

test('falls back to the request when the model fails', async () => {
  const ask = async () => null;
  assert.equal(await buildSearchQuery({ request: 'oscars 2026 winners', config: {}, ask }), 'oscars 2026 winners');
});

test('empty request is returned untouched without asking', async () => {
  const ask = async () => assert.fail('should not ask');
  assert.equal(await buildSearchQuery({ request: '  ', config: {}, ask }), '');
});

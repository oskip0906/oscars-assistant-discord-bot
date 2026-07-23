import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDdgMarkdown } from '../src/agent/tools/search.js';

const SAMPLE = `[](https://html.duckduckgo.com/html/?q=x)

## [discord.js - npm](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fdiscord.js&rut=abc)

[![Image](https://external-content.duckduckgo.com/ip3/npmjs.com.ico)](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fdiscord.js&rut=abc)[www.npmjs.com/package/discord.js](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fdiscord.js&rut=abc)

[**discord.js** is a powerful **Node**.js module that lets you interact with the Discord API very easily.](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Fdiscord.js&rut=abc)

## [GitHub - discordjs/discord.js](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fdiscordjs%2Fdiscord.js&rut=def)

[**discord.js** A powerful JavaScript library for interacting with the Discord API here is a long snippet.](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fdiscordjs%2Fdiscord.js&rut=def)`;

test('parses titles and decodes the DDG redirect to the real URL', () => {
  const results = parseDdgMarkdown(SAMPLE);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'discord.js - npm');
  assert.equal(results[0].url, 'https://www.npmjs.com/package/discord.js');
  assert.equal(results[1].url, 'https://github.com/discordjs/discord.js');
});

test('extracts a clean snippet with markdown emphasis stripped', () => {
  const results = parseDdgMarkdown(SAMPLE);
  assert.match(results[0].snippet, /discord\.js is a powerful Node\.js module/);
  assert.doesNotMatch(results[0].snippet, /\*\*/);
});

test('dedupes repeated URLs and returns [] for junk', () => {
  assert.deepEqual(parseDdgMarkdown('no results here'), []);
  assert.deepEqual(parseDdgMarkdown(''), []);
  const dup = SAMPLE + '\n\n' + SAMPLE;
  assert.equal(parseDdgMarkdown(dup).length, 2);
});

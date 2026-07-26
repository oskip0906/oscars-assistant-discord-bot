import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUserId } from '../src/agent/tools/discord.js';

const member = (id, username, { bot = false, displayName = username } = {}) => ({
  id,
  displayName,
  user: { id, username, bot },
});

function guildWith(members, { searchThrows = false } = {}) {
  const cache = new Map(members.map((m) => [m.id, m]));
  return {
    members: {
      cache,
      search: async ({ query }) => {
        if (searchThrows) throw new Error('Missing Access');
        return new Map(members.filter((m) => m.user.username.toLowerCase().includes(query.toLowerCase())).map((m) => [m.id, m]));
      },
      fetch: async (id) => cache.get(id) || null,
    },
  };
}

const invocation = (guild) => ({ guild });

test('a bot is found and reported as pingable like anyone else', async () => {
  const guild = guildWith([member('42', 'MusicBot', { bot: true })]);

  const result = await getUserId({ name: 'MusicBot' }, invocation(guild));

  assert.match(result, /id:42/);
  assert.match(result, /\[BOT\]/);
  assert.match(result, /<@42>/);
  assert.match(result, /bots included/i);
});

test('an @-prefixed name still resolves', async () => {
  const guild = guildWith([member('42', 'MusicBot', { bot: true })]);

  // The model passes back what it saw on screen, and searching for "@MusicBot"
  // literally matches nothing — which it then reports as "I can't ping bots".
  assert.match(await getUserId({ name: '@MusicBot' }, invocation(guild)), /id:42/);
});

test('a raw mention or id resolves without a name search', async () => {
  const guild = guildWith([member('42', 'MusicBot', { bot: true })]);

  const fromMention = await getUserId({ name: '<@42>' }, invocation(guild));
  assert.match(fromMention, /MusicBot/);
  assert.match(fromMention, /<@42>/);

  const fromId = await getUserId({ name: '123456789012345678' }, invocation(guild));
  assert.match(fromId, /<@123456789012345678>/);
});

test('a miss is reported as a spelling problem, never as a restriction', async () => {
  const guild = guildWith([member('42', 'MusicBot', { bot: true })]);

  const result = await getUserId({ name: 'Nobody' }, invocation(guild));

  assert.match(result, /spelled differently/);
  assert.match(result, /not a restriction/i);
});

test('the cache still answers when the member search API is unavailable', async () => {
  const guild = guildWith([member('42', 'MusicBot', { bot: true })], { searchThrows: true });

  assert.match(await getUserId({ name: 'music' }, invocation(guild)), /id:42/);
});

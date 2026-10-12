import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { parseClearAmount, missingClearPermissions, clearChannel } from '../src/discord/clear.js';
import { createInteractionHandler } from '../src/discord/commands.js';
import { commandDefs, OWNER_ONLY_COMMANDS } from '../src/discord/commandDefs.js';
import { buildMenuEmbeds } from '../src/discord/menu.js';

const OWNER = '111111111111111111';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// A channel of `count` messages, newest first, each `ageOf(i)` old. Records what
// was deleted and how.
function channel(count, { ageOf = () => 0, perms = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'], undeletable = new Set(), bulkError } = {}) {
  let messages = Array.from({ length: count }, (_, i) => ({ id: String(count - i), createdTimestamp: NOW - ageOf(i) }));
  const deleted = { bulk: [], single: [] };
  const drop = (id) => (messages = messages.filter((m) => m.id !== id));
  for (const m of messages) {
    m.delete = async () => {
      if (undeletable.has(m.id)) throw Object.assign(new Error('Cannot execute action on a system message'), { code: 50021 });
      deleted.single.push(m.id);
      drop(m.id);
    };
  }
  return {
    id: 'c1',
    name: 'general',
    deleted,
    guild: { members: { me: { id: 'bot' } } },
    permissionsFor: () => ({ has: (bit) => perms.some((p) => PermissionFlagsBits[p] === bit) }),
    messages: {
      fetch: async ({ limit, before }) => {
        const from = before ? messages.findIndex((m) => BigInt(m.id) < BigInt(before)) : 0;
        const page = from < 0 ? [] : messages.slice(from, from + limit);
        return new Map(page.map((m) => [m.id, m]));
      },
    },
    bulkDelete: async (ids) => {
      if (bulkError) throw bulkError;
      deleted.bulk.push(ids);
      for (const id of ids) drop(id);
    },
    left: () => messages.length,
  };
}

test('parseClearAmount takes a whole number or all', () => {
  assert.deepEqual(parseClearAmount('all'), { all: true });
  assert.deepEqual(parseClearAmount(' ALL '), { all: true });
  assert.deepEqual(parseClearAmount('25'), { count: 25 });
  for (const bad of ['0', '-3', '2.5', 'some', '']) assert.ok(parseClearAmount(bad).error, bad);
});

test('missingClearPermissions names what the bot lacks, and null outside a server', () => {
  assert.deepEqual(missingClearPermissions(channel(1)), []);
  assert.deepEqual(missingClearPermissions(channel(1, { perms: ['ViewChannel'] })), ['ReadMessageHistory', 'ManageMessages']);
  assert.equal(missingClearPermissions({ messages: {} }), null);
});

test('clears a number of the newest messages', async () => {
  const ch = channel(250);
  const done = await clearChannel(ch, { limit: 150, now: () => NOW });
  assert.deepEqual(done, { deleted: 150, failed: 0 });
  assert.equal(ch.left(), 100);
  assert.deepEqual(ch.deleted.bulk.map((ids) => ids.length), [100, 50]);
  assert.equal(ch.deleted.bulk[0][0], '250', 'newest first');
});

test('all clears the whole channel, deleting messages over 14 days old one by one', async () => {
  const ch = channel(230, { ageOf: (i) => (i < 120 ? DAY : 20 * DAY), undeletable: new Set(['1']) });
  const done = await clearChannel(ch, { now: () => NOW });
  assert.deepEqual(done, { deleted: 229, failed: 1 });
  assert.equal(ch.left(), 1);
  assert.equal(ch.deleted.bulk.flat().length, 120);
  assert.equal(ch.deleted.single.length, 109);
});

test('a failed bulk delete falls back to one by one, but missing permission stops it', async () => {
  const ch = channel(5, { bulkError: Object.assign(new Error('bad'), { code: 50034 }) });
  assert.deepEqual(await clearChannel(ch, { now: () => NOW }), { deleted: 5, failed: 0 });
  const denied = channel(5, { bulkError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
  await assert.rejects(clearChannel(denied, { now: () => NOW }), /Missing Permissions/);
});

function slash(userId, ch, amount) {
  const calls = [];
  return {
    calls,
    commandName: 'clear',
    user: { id: userId },
    channel: ch,
    createdTimestamp: Date.now(),
    options: { getString: () => amount },
    isButton: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    reply: async (p) => calls.push(['reply', p]),
    deferReply: async (p) => calls.push(['deferReply', p]),
    editReply: async (p) => calls.push(['editReply', p]),
  };
}

const handler = () => createInteractionHandler({ client: {}, config: { ownerId: OWNER }, privateMode: { isOn: () => false } });

test('/clear is registered, owner only, and on the menu', () => {
  const cmd = commandDefs.find((c) => c.name === 'clear');
  assert.ok(cmd);
  assert.equal(cmd.options[0].name, 'amount');
  assert.ok(OWNER_ONLY_COMMANDS.has('clear'));
  const menu = buildMenuEmbeds({ user: { id: 'bot', displayAvatarURL: () => 'https://cdn.example/a.png' } }, { botName: 'Panda' });
  const power = menu.find((e) => e.data.title.includes('Power Tools'));
  assert.match(power.data.description, /`\/clear <number\|all>`/);
});

test('/clear turns away anyone but Oscar', async () => {
  const ch = channel(5);
  const intruder = slash('999', ch, 'all');
  await handler()(intruder);
  assert.equal(intruder.calls.length, 1);
  assert.match(intruder.calls[0][1].content, /Only Oscar/);
  assert.equal(ch.left(), 5);
});

test('/clear says it can’t without the permissions, and deletes nothing', async () => {
  const ch = channel(5, { perms: ['ViewChannel', 'ReadMessageHistory'] });
  const run = slash(OWNER, ch, '3');
  await handler()(run);
  assert.match(run.calls[0][1].content, /can’t clear messages here.*ManageMessages/);
  assert.equal(ch.left(), 5);

  const dm = slash(OWNER, { messages: {} }, '3');
  await handler()(dm);
  assert.match(dm.calls[0][1].content, /can’t clear messages here/);
});

test('/clear deletes the messages when it can', async () => {
  const ch = channel(5);
  const some = slash(OWNER, ch, '3');
  await handler()(some);
  assert.equal(ch.left(), 2);
  assert.match(some.calls.at(-1)[1], /Deleted \*\*3\*\* messages/);

  const rest = slash(OWNER, ch, 'all');
  await handler()(rest);
  assert.equal(ch.left(), 0);
  assert.match(rest.calls.at(-1)[1], /Deleted \*\*2\*\* messages/);

  const bad = slash(OWNER, ch, 'lots');
  await handler()(bad);
  assert.match(bad.calls[0][1].content, /number of messages/);
});

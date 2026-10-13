import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { createThread, sendToThread } from '../src/agent/tools/discord.js';
import { executeTool } from '../src/agent/tools/index.js';
import { joinThread } from '../src/discord/threads.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

function fakeThread(name, parent, extra = {}) {
  const sent = [];
  return { id: '900000000000000001', name, parent, sent, isThread: () => true, members: { add: async () => {} }, send: async (p) => sent.push(p), ...extra };
}

function fakeGuild() {
  const made = [];
  const general = {
    id: '800000000000000001',
    name: 'general',
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: {
      create: async (opts) => {
        const t = fakeThread(opts.name, general, { opts });
        made.push(t);
        return t;
      },
    },
  };
  const existing = fakeThread('plans', general, { id: '900000000000000002', joined: true });
  const cache = new Map([[general.id, general], [existing.id, existing]]);
  const guild = {
    channels: {
      cache,
      fetch: async (id) => cache.get(id) ?? null,
      fetchActiveThreads: async () => ({ threads: new Map([[existing.id, existing]]) }),
    },
  };
  return { guild, general, existing, made };
}

const owner = (guild, channel) => ({ guild, isOwner: true, config: { ownerId: '1' }, message: { channel, author: { id: '1' } } });

test('create_thread opens a thread in this channel and posts the message there', async () => {
  const { guild, general, made } = fakeGuild();
  const out = await createThread({ name: 'Movie night', message: 'Who is in?' }, owner(guild, general));
  assert.match(out, /Created the thread <#900000000000000001> \("Movie night"\) and posted the message there/);
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.name, 'Movie night');
  assert.deepEqual(made[0].sent.map((p) => p.content), ['Who is in?']);
});

test('create_thread from inside a thread opens it in the parent, and private ones add the sender', async () => {
  const { guild, general, existing, made } = fakeGuild();
  const added = [];
  general.threads.create = async (opts) => {
    const t = fakeThread(opts.name, general, { opts, members: { add: async (id) => added.push(id) } });
    made.push(t);
    return t;
  };
  await createThread({ name: 'secret', private: true }, owner(guild, existing));
  assert.equal(made[0].opts.type, ChannelType.PrivateThread);
  assert.deepEqual(added, ['1']);
  assert.equal(made[0].sent.length, 0, 'no message, nothing posted');
});

test('create_thread reports what Discord refuses, and is Oscar only', async () => {
  const { guild, general } = fakeGuild();
  general.threads.create = async () => {
    throw new Error('Missing Permissions');
  };
  assert.match(await createThread({ name: 'x', message: 'y' }, owner(guild, general)), /wouldn't create the thread: Missing Permissions/);
  assert.match(await createThread({ name: 'x', channel: 'nope' }, owner(guild, general)), /No channel "nope"/);
  assert.match(await executeTool('create_thread', { name: 'x' }, { ...owner(guild, general), isOwner: false }), /restricted to Oscar/);
});

test('send_to_thread posts in an existing thread found by name or mention', async () => {
  const { guild, general, existing } = fakeGuild();
  assert.match(await sendToThread({ thread: 'Plans', message: 'saturday?' }, owner(guild, general)), /Posted in <#900000000000000002>/);
  assert.match(await sendToThread({ thread: '<#900000000000000002>', message: 'or sunday' }, owner(guild, general)), /Posted/);
  assert.deepEqual(existing.sent.map((p) => p.content), ['saturday?', 'or sunday']);
  assert.match(await sendToThread({ thread: 'unknown', message: 'x' }, owner(guild, general)), /No thread "unknown"/);
});

test('Panda joins threads it is not in, and the prompt names the thread', async () => {
  let joins = 0;
  const thread = fakeThread('t', null, { joined: false, joinable: true, join: async () => joins++ });
  assert.equal(await joinThread(thread), true);
  assert.equal(await joinThread({ ...thread, joined: true }), false);
  assert.equal(joins, 1);
  const prompt = await buildSystemPrompt({
    config: { botName: 'Panda', ownerId: '1', rulesFile: '/nonexistent/RULES.md' },
    guild: { name: 'Server' },
    message: { channel: fakeThread('plans', { name: 'general' }), author: { id: '2', username: 'x' } },
  });
  assert.match(prompt, /Channel: the thread "plans" \(id:900000000000000001\) in #general/);
});

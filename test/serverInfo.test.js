import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { serverInfo } from '../src/agent/tools/discord.js';

// A guild with one public and one private channel, and an event in each.
const seen = (ok) => () => ({ has: () => ok });
const channel = (id, name, ok, extra = {}) => ({ id, name, type: ChannelType.GuildText, rawPosition: Number(id), parentId: null, permissionsFor: seen(ok), ...extra });
const general = channel('1', 'general', true, { topic: 'say hi' });
const secret = channel('2', 'mods-only', false);
const map = (...items) => new Map(items.map((x) => [x.id, x]));
const event = (id, name, channelId, start) => ({
  id, name, channelId, status: 1, scheduledStartAt: new Date(start), scheduledStartTimestamp: start, userCount: 4, url: `https://discord.com/events/g/${id}`,
});
const guild = {
  id: 'g',
  channels: {
    cache: map(general, secret),
    fetch: async () => map(general, secret),
  },
  scheduledEvents: {
    fetch: async () => map(event('e2', 'Mod meeting', '2', 2000), event('e1', 'Game night', '1', 1000), { ...event('e3', 'Picnic', null, 3000), entityMetadata: { location: 'the park' } }),
  },
  roles: { everyone: { id: 'g' } },
};
const invocation = { guild, member: { id: 'u' } };

test('server_info lists only the channels the sender can see', async () => {
  const out = await serverInfo({ section: 'channels' }, invocation);
  assert.match(out, /#general \(GuildText\) id:1 — say hi/);
  assert.doesNotMatch(out, /mods-only/);
});

test('server_info shows scheduled events in order, hiding ones in channels the sender cannot see', async () => {
  const out = await serverInfo({ section: 'events' }, invocation);
  assert.ok(out.indexOf('Game night') < out.indexOf('Picnic'), 'sorted by start');
  assert.match(out, /Game night \(id:e1\) — Scheduled\n {2}Starts <t:1:F>\n {2}Where: <#1> · 4 interested/);
  assert.match(out, /Where: the park/);
  assert.doesNotMatch(out, /Mod meeting/);
});

test('server_info explains that a DM has no server', async () => {
  assert.match(await serverInfo({ section: 'roles' }, { guild: null }), /DM/);
});

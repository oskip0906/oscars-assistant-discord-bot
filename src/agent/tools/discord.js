import { ChannelType, PermissionFlagsBits, GuildScheduledEventStatus } from 'discord.js';
import { reactOnce, hasReacted } from '../../discord/reactions.js';
import { chunkMessage } from '../../discord/chunk.js';
import { redactSecrets } from '../../config.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'get_user_id',
      description:
        "Look up any guild member's numeric id in this server by (partial) name — PEOPLE AND BOTS ALIKE. Bots are ordinary members and are pinged the same way, so use this whenever you are asked to ping or mention a bot rather than saying you cannot. Accepts a bare name, an @name, a <@id> mention, or a raw id. Ping format: <@id>.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Username, display name, or partial name to search for' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'react',
      description:
        "React to the message you're answering with an emoji (unicode like 👋, or a custom emote in <:name:id> form). Exactly ONE reaction per message: call it once, with the single emoji that fits best; any further call adds nothing. For lightweight social messages (bye, thanks, lol, gg, simple agreement) reacting INSTEAD of replying is best: react, then return an empty final response (no text).",
      parameters: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'The emoji to react with' },
        },
        required: ['emoji'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'server_info',
      description:
        "Look up anything about this Discord server as it is right now: its channels, roles, scheduled events, members and users, emojis, stickers and threads. Use it for any question about the server or the people in it. Sections: 'overview' (name, owner, counts, boosts, created), 'channels' (every category, channel and topic the sender can see), 'roles' (color, member count, key permissions), 'events' (scheduled events: start/end, where, status, how many are interested), 'members' (who is here and their roles; `query` filters by name), 'user' (one member in detail: roles, nickname, joined, account age, voice; `query` is a name, @mention or id), 'emojis' (custom emojis and stickers), 'threads' (active threads).",
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['overview', 'channels', 'roles', 'events', 'members', 'user', 'emojis', 'threads'] },
          query: { type: 'string', description: "For 'members': a name filter. For 'user': the member's name, @mention or id (default: the sender)." },
        },
        required: ['section'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_message_sender',
      description:
        'Get the user id, username, and display name of whoever sent the message you are currently answering (it is also inline in the message prefix).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_thread',
      description:
        "Create a new Discord thread and post a message in it. Use it whenever Oscar asks you to start a thread, or to send or say something \"in a new thread\": the thread is made and `message` is posted there, not in this channel. By default it opens in this channel (in its parent channel when you are already in a thread); `channel` picks another one. `from_message` hangs it off the message you are answering instead. You read and answer messages in threads like in any channel. Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Thread title, up to 100 characters.' },
          message: { type: 'string', description: 'What to post in the new thread (required in a forum channel).' },
          channel: { type: 'string', description: 'Where to open it: a channel id, <#id> mention or name (default: this channel).' },
          from_message: { type: 'boolean', description: 'Start the thread from the message you are answering (default false).' },
          private: { type: 'boolean', description: 'A private thread only invited people see; the sender is added (default false).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_thread',
      description:
        "Post a message in an existing thread (not the one you are answering in: there, just reply). Use it when Oscar asks you to say or send something in a thread that already exists. `thread` is its id, <#id> mention or name (server_info's 'threads' section lists the active ones). Oscar only.",
      parameters: {
        type: 'object',
        properties: {
          thread: { type: 'string', description: 'The thread: id, <#id> mention or name.' },
          message: { type: 'string', description: 'What to post there.' },
        },
        required: ['thread', 'message'],
      },
    },
  },
];

export async function getUserId({ name }, invocation) {
  const guild = invocation.guild;
  if (!guild) return 'Not in a server (this is a DM) — there is no member list to search.';
  // The model routinely passes back what it saw on screen: "@SomeBot", a raw
  // <@123> mention, or the id itself. Searching for those literally finds
  // nothing, and a fruitless lookup is what it then reports as "I can't".
  const raw = String(name || '').trim();
  // Inside <@…> the wrapper already proves it is an id, so any digits count. A
  // bare number has to look like a snowflake before it is treated as one.
  const mention = raw.match(/^<@!?(\d+)>$/) || raw.match(/^(\d{15,})$/);
  if (mention) {
    const id = mention[1];
    const member = await guild.members.fetch(id).catch(() => null);
    const who = member ? `${member.displayName} (@${member.user.username})${member.user.bot ? ' [BOT]' : ''}` : 'that account';
    return `${who} id:${id} — ping with <@${id}>. Bots are pinged exactly like people.`;
  }
  const query = raw.replace(/^@+/, '');
  if (!query) return 'Provide a name to search for.';

  const matches = new Map();
  try {
    const found = await guild.members.search({ query, limit: 10 });
    for (const member of found.values()) matches.set(member.id, member);
  } catch {
    /* REST search unavailable — cache fallback below */
  }
  const lower = query.toLowerCase();
  for (const member of guild.members.cache.values()) {
    if (matches.size >= 15) break;
    if (
      member.user.username.toLowerCase().includes(lower) ||
      (member.displayName || '').toLowerCase().includes(lower)
    ) {
      matches.set(member.id, member);
    }
  }
  if (!matches.size) {
    return `No member matching "${query}" is in this server (searched the API and local cache, people and bots alike). The name may be spelled differently — ask which one they mean. This is a spelling miss, not a restriction on pinging.`;
  }
  return [
    ...[...matches.values()].map(
      (m) =>
        `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? ' [BOT]' : ''} — ping with <@${m.id}>`,
    ),
    'Every id above is pingable with <@id>, bots included.',
  ].join('\n');
}

export async function react({ emoji }, invocation) {
  const trimmed = String(emoji || '').trim();
  if (!trimmed) return 'Provide an emoji to react with.';
  // One reaction per message, whatever the model asks for: the first call wins.
  if (await reactOnce(invocation.message, trimmed)) {
    invocation.reacted = true;
    return `Reacted with ${trimmed}.`;
  }
  if (hasReacted(invocation.message)) {
    invocation.reacted = true;
    return `Not added: you already reacted to this message, and you add at most one reaction per message.`;
  }
  return `Couldn't react with "${trimmed}", and no other reaction will be tried on this message. Answer in words if the turn needs it.`;
}

export function getMessageSender(_args, invocation) {
  const author = invocation.message.author;
  return JSON.stringify({
    id: author.id,
    username: author.username,
    displayName: invocation.member?.displayName || author.displayName || author.username,
    bot: author.bot,
    isOwner: author.id === invocation.config.ownerId,
    pingWith: `<@${author.id}>`,
  });
}

// --- server_info --------------------------------------------------------------

const LIST_MAX = 100;
const KEY_PERMISSIONS = ['Administrator', 'ManageGuild', 'ManageChannels', 'ManageRoles', 'ManageMessages', 'KickMembers', 'BanMembers', 'ModerateMembers', 'MentionEveryone'];
// A Discord timestamp renders in each reader's own timezone.
const when = (date) => (date ? `<t:${Math.floor(date.getTime() / 1000)}:F>` : 'unknown');
const capped = (lines, what) => (lines.length > LIST_MAX ? [...lines.slice(0, LIST_MAX), `…and ${lines.length - LIST_MAX} more ${what}`] : lines);
// Only what the sender could see themselves, so a private channel's name or topic never leaks.
const visible = (channel, viewer) => channel?.permissionsFor?.(viewer)?.has(PermissionFlagsBits.ViewChannel) ?? false;
const memberLine = (m) => `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? ' [BOT]' : ''}`;
const roleNames = (m, guild) =>
  [...m.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position).map((r) => r.name);

// The full list needs the Server Members intent (index.js falls back without
// it); then only the members Discord already sent are known.
async function allMembers(guild) {
  if (guild.client?.options?.intents?.has?.('GuildMembers')) await guild.members.fetch().catch(() => null);
  return [...guild.members.cache.values()];
}

async function findMember(guild, query) {
  const raw = String(query).trim();
  const id = raw.match(/^<@!?(\d+)>$/)?.[1] || raw.match(/^(\d{15,})$/)?.[1];
  if (id) return guild.members.fetch(id).catch(() => null);
  const name = raw.replace(/^@+/, '').toLowerCase();
  const found = await guild.members.search({ query: name, limit: 1 }).catch(() => null);
  return (
    found?.first?.() ??
    [...guild.members.cache.values()].find((m) => m.user.username.toLowerCase().includes(name) || m.displayName.toLowerCase().includes(name)) ??
    null
  );
}

export async function serverInfo({ section, query = '' }, invocation) {
  const guild = invocation.guild;
  if (!guild) return 'This is a DM, not a server: there are no channels, roles or events to read.';
  const viewer = invocation.member ?? guild.roles.everyone;
  const q = String(query || '').trim();

  switch (section) {
    case 'overview': {
      const owner = await guild.fetchOwner().catch(() => null);
      return [
        `${guild.name} (id:${guild.id})${guild.description ? `: ${guild.description}` : ''}`,
        `Owner: ${owner ? memberLine(owner) : `id:${guild.ownerId}`}`,
        `Members: ${guild.memberCount} · Channels: ${guild.channels.cache.size} · Roles: ${guild.roles.cache.size} · Custom emojis: ${guild.emojis.cache.size}`,
        `Boost level ${guild.premiumTier} with ${guild.premiumSubscriptionCount ?? 0} boosts`,
        `Created ${when(guild.createdAt)}`,
      ].join('\n');
    }
    case 'channels': {
      const channels = [...(await guild.channels.fetch()).values()].filter((c) => c && visible(c, viewer));
      const byPosition = (a, b) => a.rawPosition - b.rawPosition;
      const voice = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
      const line = (c) => `${voice.includes(c.type) ? '🔊' : '#'}${c.name} (${ChannelType[c.type]}) id:${c.id}${c.topic ? ` — ${c.topic.slice(0, 150)}` : ''}`;
      const categories = channels.filter((c) => c.type === ChannelType.GuildCategory).sort(byPosition);
      const shown = new Set(categories.map((c) => c.id));
      // A channel whose category the sender can't see is listed on its own.
      const out = channels.filter((c) => c.type !== ChannelType.GuildCategory && !shown.has(c.parentId)).sort(byPosition).map(line);
      for (const cat of categories) out.push(`[${cat.name}]`, ...channels.filter((c) => c.parentId === cat.id).sort(byPosition).map((c) => `  ${line(c)}`));
      return out.length ? capped(out, 'channels').join('\n') : 'No channels the sender can see.';
    }
    case 'roles': {
      const roles = [...(await guild.roles.fetch()).values()].sort((a, b) => b.position - a.position);
      await allMembers(guild);
      const lines = roles.map((r) => {
        const granted = r.permissions.toArray();
        const perms = KEY_PERMISSIONS.filter((p) => granted.includes(p));
        return `${r.name} id:${r.id} · ${r.hexColor} · ${r.members.size} member(s)${r.managed ? ' · managed by an integration' : ''}${perms.length ? ` · ${perms.join(', ')}` : ''}`;
      });
      return capped(lines, 'roles').join('\n');
    }
    case 'events': {
      const events = [...(await guild.scheduledEvents.fetch()).values()]
        .filter((e) => !e.channelId || visible(guild.channels.cache.get(e.channelId), viewer))
        .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
      if (!events.length) return 'No scheduled events in this server.';
      return events
        .map((e) =>
          [
            `${e.name} (id:${e.id}) — ${GuildScheduledEventStatus[e.status] ?? e.status}`,
            `  Starts ${when(e.scheduledStartAt)}${e.scheduledEndAt ? `, ends ${when(e.scheduledEndAt)}` : ''}`,
            `  Where: ${e.channelId ? `<#${e.channelId}>` : e.entityMetadata?.location || 'not set'} · ${e.userCount ?? '?'} interested`,
            ...(e.description ? [`  ${e.description.slice(0, 300)}`] : []),
            ...(e.url ? [`  ${e.url}`] : []),
          ].join('\n'),
        )
        .join('\n');
    }
    case 'members': {
      const pool = new Map((await allMembers(guild)).map((m) => [m.id, m]));
      if (q) for (const m of (await guild.members.search({ query: q, limit: 100 }).catch(() => null))?.values() ?? []) pool.set(m.id, m);
      const lower = q.toLowerCase();
      const members = [...pool.values()]
        .filter((m) => !q || m.displayName.toLowerCase().includes(lower) || m.user.username.toLowerCase().includes(lower))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      if (!members.length) return q ? `No member matching "${q}".` : 'No members are loaded.';
      const partial = !q && guild.memberCount > members.length ? ` of ${guild.memberCount} (the rest are not loaded)` : '';
      const lines = members.map((m) => [memberLine(m), ...roleNames(m, guild)].join(' · '));
      return [`${members.length} member(s)${partial}:`, ...capped(lines, 'members')].join('\n');
    }
    case 'user': {
      const member = q ? await findMember(guild, q) : invocation.member;
      if (!member) return q ? `No member matching "${q}" in this server.` : 'Say whose details to look up.';
      const voiceChannel = member.voice?.channel;
      return [
        memberLine(member),
        `Nickname: ${member.nickname || 'none'} · Roles: ${roleNames(member, guild).join(', ') || 'none'}`,
        `Joined the server ${when(member.joinedAt)} · Account created ${when(member.user.createdAt)}`,
        ...(member.premiumSince ? [`Boosting since ${when(member.premiumSince)}`] : []),
        ...(member.communicationDisabledUntil > new Date() ? [`Timed out until ${when(member.communicationDisabledUntil)}`] : []),
        ...(voiceChannel && visible(voiceChannel, viewer) ? [`In voice: 🔊${voiceChannel.name}`] : []),
        ...(member.displayAvatarURL ? [`Avatar: ${member.displayAvatarURL()}`] : []),
      ].join('\n');
    }
    case 'emojis': {
      const emojis = [...(await guild.emojis.fetch()).values()].map((e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`);
      const stickers = [...(await guild.stickers.fetch()).values()].map((s) => `${s.name} id:${s.id}`);
      return [`Emojis (${emojis.length}): ${emojis.join(' ') || 'none'}`, `Stickers (${stickers.length}): ${stickers.join(', ') || 'none'}`].join('\n');
    }
    case 'threads': {
      const { threads } = await guild.channels.fetchActiveThreads();
      const lines = [...threads.values()].filter((t) => visible(t, viewer)).map((t) => `${t.name} id:${t.id} in <#${t.parentId}> · ${t.messageCount ?? '?'} messages`);
      return lines.length ? capped(lines, 'threads').join('\n') : 'No active threads the sender can see.';
    }
    default:
      return `Unknown section "${section}". Use one of: overview, channels, roles, events, members, user, emojis, threads.`;
  }
}

// --- threads --------------------------------------------------------------------

const THREAD_PARENTS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia];
const FORUMS = [ChannelType.GuildForum, ChannelType.GuildMedia];
const channelId = (ref) => String(ref ?? '').trim().match(/^<#(\d+)>$|^(\d{15,})$/)?.slice(1).find(Boolean);
const bareName = (ref) => String(ref ?? '').trim().replace(/^#/, '').toLowerCase();

async function findChannel(guild, ref) {
  const id = channelId(ref);
  if (id) return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  const name = bareName(ref);
  return [...guild.channels.cache.values()].find((c) => c.name?.toLowerCase() === name) ?? null;
}

async function findThread(guild, ref) {
  const id = channelId(ref);
  const byId = id ? guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null)) : null;
  if (byId) return byId.isThread?.() ? byId : null;
  const name = bareName(ref);
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  const threads = [...(active?.threads?.values() ?? []), ...guild.channels.cache.values()].filter((c) => c.isThread?.());
  return threads.find((t) => t.name.toLowerCase() === name) ?? threads.find((t) => t.name.toLowerCase().includes(name)) ?? null;
}

// Sent from the tool, so it skips the reply path: scrubbed and chunked the same way.
async function post(channel, text) {
  for (const content of chunkMessage(redactSecrets(text))) await channel.send({ content, allowedMentions: { parse: ['users'] } });
}

const failed = (what, err) => `${what}: ${String(err?.message || err).slice(0, 200)}`;

export async function createThread({ name = '', message = '', channel = '', from_message: fromMessage = false, private: isPrivate = false } = {}, invocation) {
  const guild = invocation.guild;
  if (!guild) return 'Threads only exist in a server, not in DMs.';
  const title = String(name).trim().slice(0, 100);
  if (!title) return 'A thread needs a name.';
  const text = String(message ?? '').trim();
  const here = invocation.message?.channel;
  let thread;
  try {
    if (fromMessage) {
      if (here?.isThread?.()) return 'The message you are answering is already in a thread; a thread cannot start from it. Leave out from_message to open a new one.';
      thread = await invocation.message.startThread({ name: title, autoArchiveDuration: 1440 });
    } else {
      const target = channel ? await findChannel(guild, channel) : here?.isThread?.() ? here.parent : here;
      if (!target) return `No channel "${channel}" in this server. Check the name with server_info's 'channels' section.`;
      if (!THREAD_PARENTS.includes(target.type) || !target.threads?.create) return `#${target.name} cannot hold threads; pick a text, announcement or forum channel.`;
      if (FORUMS.includes(target.type)) {
        if (!text) return `#${target.name} is a forum: a new post needs a message.`;
        thread = await target.threads.create({ name: title, autoArchiveDuration: 1440, message: { content: redactSecrets(text).slice(0, 2000), allowedMentions: { parse: ['users'] } } });
      } else {
        thread = await target.threads.create({ name: title, autoArchiveDuration: 1440, ...(isPrivate ? { type: ChannelType.PrivateThread, invitable: true } : {}) });
        if (isPrivate) await thread.members.add(invocation.message.author.id).catch(() => {});
      }
    }
  } catch (err) {
    return failed("Discord wouldn't create the thread", err);
  }
  const posted = text && !FORUMS.includes(thread.parent?.type);
  if (posted) {
    try {
      await post(thread, text);
    } catch (err) {
      return failed(`Created the thread <#${thread.id}>, but Discord rejected the message in it`, err);
    }
  }
  return `Created the thread <#${thread.id}> ("${thread.name}")${posted || FORUMS.includes(thread.parent?.type) ? ' and posted the message there' : ''}. Tell them briefly where it is (<#${thread.id}> links to it); don't repeat the message here.`;
}

export async function sendToThread({ thread = '', message = '' } = {}, invocation) {
  const guild = invocation.guild;
  if (!guild) return 'Threads only exist in a server, not in DMs.';
  const text = String(message).trim();
  if (!text) return 'Give the message to post.';
  const target = await findThread(guild, thread);
  if (!target) return `No thread "${thread}" found. server_info's 'threads' section lists the active ones; create_thread makes a new one.`;
  try {
    if (target.archived) await target.setArchived(false).catch(() => {});
    if (!target.joined && target.joinable) await target.join().catch(() => {});
    await post(target, text);
  } catch (err) {
    return failed(`Discord rejected the message in <#${target.id}>`, err);
  }
  return `Posted in <#${target.id}> ("${target.name}"). Tell them briefly; don't repeat the message here.`;
}

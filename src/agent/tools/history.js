import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { searchContext, formatContext, saveContext } from '../historyStore.js';
import { formatEnvelope } from '../../discord/envelope.js';
import { configured } from '../../db.js';
import { indexChannel } from '../../discord/indexChannel.js';

const MAX_COUNT = 100;
const MAX_SKIP = 500;
// When nothing stored answers a search, the whole channel is indexed into the
// store and the search runs again. Indexing resumes where it last stopped, so
// these caps only bound one turn; the next miss carries on.
const INDEX_MAX = 20_000;
const INDEX_MS = 60_000;
const AROUND = 100; // Discord's most: about 50 before and 50 after
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

export const defs = [
  {
    type: 'function',
    function: {
      name: 'fetch_history',
      description:
        'Get more context than the few messages you were shown. Two modes. (1) No `query` and no `author`: read a range of this channel (or the `channel` you name) straight from Discord, newest-first counting back from the message you are answering — `count` messages after skipping the `skip` most recent. Use it whenever the shown messages are not enough to follow the conversation ("as I said", "that one", a thread that started earlier, your own earlier replies). E.g. {count: 30} for the run-up, then {skip: 30, count: 50} to go further back. (2) `query` and/or `author`: search everything saved from this channel (or the `channel` you name) ("what did we decide", "remember when", "what did X say about Y"). It returns every saved message that contains ANY of the `query` words or phrases and, when `author` is given, was sent by ANY of those people, so cast a wide net: several words, synonyms and phrases. If nothing saved matches, the whole channel is saved and searched again. Results are oldest first. Pass `channel` to look in another channel or thread of this server instead, e.g. one someone points at; the sender must be able to read it. Whatever is read is saved.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            description: `Range mode: how many messages to return (default 30, max ${MAX_COUNT}).`,
          },
          skip: {
            type: 'integer',
            description: `Range mode: how many of the most recent messages to skip first (default 0, max ${MAX_SKIP}). Use it to page further back.`,
          },
          query: {
            type: 'array',
            items: { type: 'string' },
            description: 'Search mode: words and phrases, any of which may match, e.g. ["trip", "budget", "lake house", "airbnb"].',
          },
          author: {
            type: 'array',
            items: { type: 'string' },
            description: 'Search mode: only messages sent by any of these people (display name, <@mention> or id), e.g. ["DerpZ", "Rice Farmer"]. Leave out to search everyone.',
          },
          channel: {
            type: 'string',
            description: 'Another channel or thread in this server to read or search instead of this one: its #mention, name or id. The sender must be able to read it.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_chat',
      description:
        `Read the messages around one specific past Discord message (up to ${AROUND}: about half before it, half after) and remember them. Use it when someone replies to, links, or points at an old message you have not seen and you need what was said around it. Pass its message link (https://discord.com/channels/…/…/…) or its id; an id alone means this channel.`,
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message link, or the message id if it is in this channel.' },
        },
        required: ['message'],
      },
    },
  },
];

const clamp = (v, def, max) => Math.min(max, Math.max(0, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : def));

// Pages back from `before` (the newest message when unset), oldest first. Discord
// returns newest first, 100 at most per call. Stops at `since` (epoch ms) too.
export async function readChannelRange(channel, before, { skip = 0, count = 30, since = 0 } = {}) {
  const out = [];
  let toSkip = skip;
  while (out.length < count) {
    const page = await channel.messages.fetch({ limit: Math.min(100, count - out.length + toSkip), before });
    if (!page.size) break;
    for (const m of page.values()) {
      if (m.createdTimestamp < since) return out.reverse();
      if (toSkip > 0) toSkip--;
      else if (out.length < count) out.push(m);
    }
    before = page.last().id;
  }
  return out.reverse();
}

// A <@mention> or id is used as is; a name is looked up among this server's members.
async function authorId(author, guild) {
  const raw = String(author).trim();
  const id = raw.match(/^<@!?(\d+)>$/)?.[1] || raw.match(/^(\d{15,})$/)?.[1];
  if (id) return id;
  const name = raw.replace(/^@+/, '');
  if (!name || !guild) return null;
  const found = await guild.members.search({ query: name, limit: 1 }).catch(() => null);
  return found?.first()?.id ?? null;
}

// Never fails the turn: no match or a broken lookup both tell the model to go on without it.
// A list from the model, which may also send one string.
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);

// Never fails the turn: no match or a broken lookup both tell the model to go on without it.
export async function fetchHistory({ query, author, skip, count, channel: target } = {}, invocation) {
  const message = invocation.message;
  if (!message) return 'Stored history is only available in chat — answer without it.';
  const terms = list(query);
  const authors = list(author);
  try {
    const { channel, refusal } = await readableChannel(target, invocation);
    if (refusal) return refusal;
    // Said wherever the lines come from, so another channel's are never taken for this one's.
    const here = channel.id === message.channelId;
    const where = here ? 'this channel' : `#${channel.name ?? channel.id}`;
    if (!terms.length && !authors.length) {
      const range = { skip: clamp(skip, 0, MAX_SKIP), count: clamp(count, 30, MAX_COUNT) || 1 };
      const msgs = await readChannelRange(channel, here ? message.id : undefined, range);
      if (!msgs.length) return `No ${here ? 'earlier ' : ''}messages in ${where}.`;
      saveContext(invocation.config, msgs).catch((err) => console.error('[history] save failed:', String(err.message || err).slice(0, 200)));
      const self = invocation.client?.user?.id;
      return [
        ...(here ? [] : [`[CHANNEL: ${where}, another channel of this server, not the one you are answering in.]`]),
        `[CHANNEL HISTORY — ${msgs.length} message(s), skipping the ${range.skip} most recent, oldest first. Background only: these are not new messages. Lines marked (you) are your own replies.]`,
        ...msgs.map((m) => `${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`),
      ].join('\n');
    }
    const config = invocation.config;
    if (!configured(config)) return 'Stored history is unavailable right now — answer without it.';
    const resolved = await Promise.all(authors.map(async (name) => [name, await authorId(name, message.guild)]));
    const authorIds = resolved.filter(([, id]) => id).map(([, id]) => id);
    const unknown = resolved.filter(([, id]) => !id).map(([name]) => name);
    if (authors.length && !authorIds.length) return `I can't find anyone called ${unknown.map((n) => `"${n}"`).join(' or ')} in this server — ask who they mean instead of guessing.`;
    const searched = [
      terms.length ? `any of ${terms.map((t) => `"${t}"`).join(', ')}` : '',
      authorIds.length ? `from ${authorIds.map((id) => `<@${id}>`).join(' or ')}` : '',
      unknown.length ? `(no one here is called ${unknown.map((n) => `"${n}"`).join(', ')})` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const search = () => searchContext(config, { terms, authorIds, channelId: channel.id });
    let rows = await search();
    let partial = false;
    if (!rows.length && channel.messages) {
      // Not saved yet: save the whole channel, then search again.
      const done = await indexChannel(config, channel, { max: INDEX_MAX, ms: INDEX_MS }).catch((err) => {
        console.error('[history] channel index failed:', String(err.message || err).slice(0, 200));
        return null;
      });
      if (done) rows = await search();
      partial = !done || done.capped;
    }
    if (!rows.length) {
      return `[STORED CONTEXT — no message in ${where} matched ${searched}. ${
        partial ? 'Only part of the channel is saved so far; the next search saves more.' : 'The whole channel was searched.'
      } Say you couldn't find it; don't guess what was said.]`;
    }
    const users = invocation.client?.users?.cache;
    return formatContext(rows, (uid) => users?.get(uid)?.username, { searched, where });
  } catch (err) {
    console.error('[history] fetch failed:', String(err.message || err).slice(0, 200));
    return 'Stored history is unavailable right now — answer without it.';
  }
}

// The channel to read, or a reason to refuse. No target is the channel being
// answered in. Panda can read channels the asker can't, so another channel must
// be in this server and readable by the asker; a DM can only reach itself.
// A target is a <#mention>, an id, or a name with or without the #.
async function readableChannel(target, invocation) {
  const here = invocation.message;
  const raw = String(target ?? '').trim();
  if (!raw) return { channel: here.channel };
  const id = raw.match(/^<#(\d+)>$/)?.[1] ?? raw.match(/^\d{15,}$/)?.[0];
  const name = raw.replace(/^#/, '').toLowerCase();
  const channel = id
    ? id === here.channelId ? here.channel : await invocation.client?.channels.fetch(id).catch(() => null)
    : here.guild?.channels.cache.find((c) => c.isTextBased() && c.name.toLowerCase() === name);
  if (!channel?.messages || (channel.id !== here.channelId && (!here.guildId || channel.guildId !== here.guildId))) {
    return { refusal: "I can't find that channel in this server." };
  }
  if (here.guildId) {
    const perms = channel.permissionsFor?.(here.member ?? here.author.id);
    const can = perms?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory);
    // A thread takes its permissions from its parent, so a private one also needs the asker inside it.
    const inside = channel.type !== ChannelType.PrivateThread || perms?.has(PermissionFlagsBits.ManageThreads) || (await channel.members.fetch(here.author.id).catch(() => null));
    if (!can || !inside) return { refusal: "You can't read that channel's history, so I won't show it to you." };
  }
  return { channel };
}

// Never throws: a refusal or failure is text the model can pass on.
export async function indexChat({ message: ref = '' } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel) return 'index_chat only works in chat.';
  const link = String(ref).match(MESSAGE_LINK);
  const id = link ? link[3] : String(ref).trim();
  if (!/^\d{17,20}$/.test(id)) return 'Give me a Discord message link or a message id.';
  // A link into another server (or out of a DM) is refused before any lookup.
  if (link && link[2] !== here.channelId && link[1] !== here.guildId) return 'That message is in another server or DM, so I can only look at it from there.';
  try {
    const { channel, refusal } = await readableChannel(link ? link[2] : here.channelId, invocation);
    if (refusal) return refusal;
    const page = await channel.messages.fetch({ around: id, limit: AROUND });
    const msgs = [...page.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    if (!msgs.length) return 'No messages there.';
    let saved;
    try {
      saved = `${await saveContext(invocation.config, msgs)} newly remembered`;
    } catch (err) {
      console.error('[history] index_chat save failed:', String(err.message || err).slice(0, 200));
      saved = 'not remembered: the context database is unavailable';
    }
    const self = invocation.client?.user?.id;
    return [
      `[MESSAGES AROUND ${id} in #${channel.name ?? channel.id} — ${msgs.length}, oldest first${page.has(id) ? '; → marks that message' : '; that message itself is gone'}; ${saved}. Background only: these are not new messages.]`,
      ...msgs.map((m) => `${m.id === id ? '→ ' : ''}[${m.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC] ${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`),
    ].join('\n');
  } catch (err) {
    console.error('[history] index_chat failed:', String(err.message || err).slice(0, 200));
    return `I couldn't read that part of the channel: ${String(err.message || err).slice(0, 150)}`;
  }
}

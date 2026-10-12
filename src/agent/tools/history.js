import { PermissionFlagsBits } from 'discord.js';
import { searchContext, formatContext, saveContext, pickRelevant, relevantTo } from '../historyStore.js';
import { formatEnvelope } from '../../discord/envelope.js';
import { configured } from '../../db.js';

const MAX_COUNT = 100;
const MAX_SKIP = 500;
// When nothing remembered answers a search, the channel is read back section by
// section, all the way to its first message, stopping at the first section with
// a match. The caps only keep one turn from running forever on a huge channel.
const SECTION = 500;
const SCAN_MAX = 20_000;
const SCAN_MS = 90_000;
const SHOWN = 40; // most lines a search hands the model
const AROUND = 100; // Discord's most: about 50 before and 50 after
const MESSAGE_LINK = /discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/;

export const defs = [
  {
    type: 'function',
    function: {
      name: 'fetch_history',
      description:
        'Get more context than the few messages you were shown. Two modes. (1) No `query` and no `author`: read a range of this channel straight from Discord, newest-first counting back from the message you are answering — `count` messages after skipping the `skip` most recent. Use it whenever the shown messages are not enough to follow the conversation ("as I said", "that one", a thread that started earlier, your own earlier replies). E.g. {count: 30} for the run-up, then {skip: 30, count: 50} to go further back. (2) `query` and/or `author`: search what you remember from earlier chats in this channel ("what did we decide", "remember when", "what did X say about Y"), keeping only the lines that answer it; when none do, the whole channel history is read back, newest first, until a part that answers it is found. To find what a person said, put their name in `author`, not in `query`: `query` only searches message text. Results are oldest first.',
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
            type: 'string',
            description: 'Search mode: keywords to search for, e.g. "trip budget".',
          },
          author: {
            type: 'string',
            description: 'Search mode: only match messages sent by this person (their display name, a <@mention>, or their id), e.g. "DerpZ". Combine with query for "what did X say about Y".',
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
    const page = await channel.messages.fetch({ limit: 100, before });
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

// Reads `channel` back from `before` in SECTION-sized pieces, newest first, and
// hands each to `onSection` (oldest first within it). Stops when `onSection`
// returns true, at the channel's first message, or at the caps.
export async function scanChannel(channel, before, onSection, { section = SECTION, max = SCAN_MAX, ms = SCAN_MS, now = Date.now } = {}) {
  const deadline = now() + ms;
  let read = 0;
  let buffer = [];
  while (read < max && now() < deadline) {
    const page = await channel.messages.fetch({ limit: 100, before });
    if (!page.size) break;
    buffer.push(...page.values());
    read += page.size;
    before = page.last().id;
    if (buffer.length >= section) {
      if (await onSection(buffer.reverse())) return { read, done: true };
      buffer = [];
    }
  }
  if (buffer.length && (await onSection(buffer.reverse()))) return { read, done: true };
  return { read, done: false, capped: read >= max || now() >= deadline };
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

const nameIs = (m, author) => {
  const want = String(author).replace(/^@+/, '').toLowerCase();
  return [m.member?.displayName, m.author.displayName, m.author.username].some((n) => n?.toLowerCase().includes(want));
};

// Never fails the turn: no match or a broken lookup both tell the model to go on without it.
export async function fetchHistory({ query = '', author = '', skip, count } = {}, invocation) {
  const message = invocation.message;
  if (!message) return 'Stored history is only available in chat — answer without it.';
  try {
    if (!query && !author) {
      const range = { skip: clamp(skip, 0, MAX_SKIP), count: clamp(count, 30, MAX_COUNT) || 1 };
      const msgs = await readChannelRange(message.channel, message.id, range);
      if (!msgs.length) return 'No earlier messages in this channel.';
      saveContext(invocation.config, msgs).catch((err) => console.error('[history] save failed:', String(err.message || err).slice(0, 200)));
      const self = invocation.client?.user?.id;
      return [
        `[CHANNEL HISTORY — ${msgs.length} message(s), skipping the ${range.skip} most recent, oldest first. Background only: these are not new messages. Lines marked (you) are your own replies.]`,
        ...msgs.map((m) => `${m.author.id === self ? '(you) ' : ''}${formatEnvelope(m)}`),
      ].join('\n');
    }
    const config = invocation.config;
    const id = author ? await authorId(author, message.guild) : null;
    // A name nobody here has can still match in the channel scan below.
    let rows = !configured(config) || (author && !id) ? [] : await searchContext(config, { query, authorId: id, channelId: message.channelId });
    // Keyword hits are only candidates: Jev keeps the lines that answer the
    // question, so the model gets the part it needs and nothing more.
    if (rows.length && query) {
      const asLines = rows.map((r) => ({ ...r, author: { id: r.author_id, username: invocation.client?.users?.cache?.get(r.author_id)?.username || r.author_id }, content: r.content }));
      // Jev down: the keyword hits are the best there is.
      rows = await pickRelevant(config, asLines, relevantTo, query, undefined, () => true);
    }
    let scanNote = '';
    if (!rows.length) {
      // Nothing remembered answers it: read the channel back until a section does.
      const found = [];
      const mine = (m) => m.content && (!author || m.author.id === id || nameIs(m, author));
      // Jev down: a line with one of the query's words, so the scan still ends.
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const mentions = (m) => words.some((w) => m.content.toLowerCase().includes(w));
      const scan = await scanChannel(message.channel, message.id, async (section) => {
        const candidates = section.filter(mine);
        found.unshift(...(query ? await pickRelevant(config, candidates, relevantTo, query, undefined, mentions) : candidates));
        return found.length >= (query ? 1 : SHOWN);
      });
      if (!scan.done && scan.capped) scanNote = `\n(Read ${scan.read} messages back; older ones were not searched.)`;
      await saveContext(config, found).catch((err) => console.error('[history] save failed:', String(err.message || err).slice(0, 200)));
      rows = found.map((m) => ({ author_id: m.author.id, content: m.content, created_at: m.createdAt }));
    }
    rows = rows.slice(-SHOWN);
    const users = invocation.client?.users?.cache;
    return rows.length ? formatContext(rows, (uid) => users?.get(uid)?.username) + scanNote : `No earlier conversations matched — answer without them, and don't guess what was said.${scanNote}`;
  } catch (err) {
    console.error('[history] fetch failed:', String(err.message || err).slice(0, 200));
    return 'Stored history is unavailable right now — answer without it.';
  }
}

// The channel the message lives in, or a reason to refuse. Panda can read
// channels the asker can't, so another channel must be in this server and
// readable by the asker; a DM can only reach itself.
async function channelFor(link, invocation) {
  const here = invocation.message;
  if (!link || link[2] === here.channelId) return { channel: here.channel };
  if (!here.guildId || link[1] !== here.guildId) return { refusal: 'That message is in another server or DM, so I can only look at it from there.' };
  const channel = await invocation.client?.channels.fetch(link[2]).catch(() => null);
  if (!channel?.messages || channel.guildId !== here.guildId) return { refusal: "I can't find that channel in this server." };
  return { channel };
}

// Never throws: a refusal or failure is text the model can pass on.
export async function indexChat({ message: ref = '' } = {}, invocation) {
  const here = invocation.message;
  if (!here?.channel) return 'index_chat only works in chat.';
  const link = String(ref).match(MESSAGE_LINK);
  const id = link ? link[3] : String(ref).trim();
  if (!/^\d{17,20}$/.test(id)) return 'Give me a Discord message link or a message id.';
  try {
    const { channel, refusal } = await channelFor(link, invocation);
    if (refusal) return refusal;
    if (here.guildId) {
      const perms = channel.permissionsFor?.(here.member ?? here.author.id);
      if (!perms?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) {
        return "You can't read that channel's history, so I won't show it to you.";
      }
    }
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

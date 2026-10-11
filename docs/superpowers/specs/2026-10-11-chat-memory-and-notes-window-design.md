# Chat memory per channel, fuller history fetches, notes by time window

Date: 2026-10-11. Status: draft.

## Why

Panda's chat memory (`context_messages`) only keeps lines Jev picks, and it is global: a line said in
one channel can come back in any channel or server. Oscar wants memory to hold everything Panda was
actually given, split by server and channel, and wants notes ("summarize this", "note this down")
to cover a time window instead of the last 50 messages.

## Goals

1. **Memory is per channel.** Every saved line records its server and channel. A search only returns
   lines from the channel it runs in.
2. **Save what Panda was given, unfiltered:** every message in a batch, Panda's replies, everything a
   `fetch_history` range read returns, and everything `index_chat` reads.
3. **History fetch reads 1000 messages.** When a search finds nothing stored, scan the last 1000
   messages of the channel. Jev keeps the relevant ones, which are saved and returned with their authors.
4. **Old message → 50 before and 50 after.** `index_chat` reads about 100 messages around the
   target instead of 50.
5. **Never a duplicate row.** Same Discord message = same id = one row (already true: `id` primary
   key plus `on conflict do nothing`).
6. **Notes by time window, from chat or slash command.** Anything meaning "summarize / note this
   down" saves a note covering the last N minutes. **The default is 10 minutes** for both chat and
   `/save_note`. If the transcript is too long, Jev filters it before the writer model sees it.

## Non-goals

- Splitting notes by channel. Notes stay shared with everyone, as today.
- Searching memory across channels ("what did we say in #planning"). Only the current channel.
- Running `index_chat` automatically on replies. It stays a tool the model chooses.
- Backfilling channel ids for rows saved before this change.

## Anti-goals

- A line from one channel or server ever being returned in another.
- Deleting existing rows without Oscar confirming (see Old rows).
- The database or Jev being slow or down breaking a reply. Every DB call and Jev call on the reply
  path keeps failing soft, as today.

## Design

### Schema (`src/schema.sql`, applied at every boot, so idempotent)

```sql
alter table context_messages add column if not exists guild_id text;
alter table context_messages add column if not exists channel_id text;
create index if not exists context_messages_channel on context_messages (channel_id, created_at);
```

A thread has its own channel id, so a thread's memory is that thread's only.

**Old rows** have null `channel_id`, so they never match a search. They stay until the context
cleanup removes them, oldest first, which comes after Oscar's approval. Nothing is deleted by this change.

### `src/agent/historyStore.js`

- `saveContext` also writes `m.guildId` and `m.channelId`. It still skips DMs (no `guildId`).
- `searchContext(config, { query, authorId, channelId })` adds `where m.channel_id = $3`.
  `channelId` is required: no channel means no rows.
- `rememberTurn` drops the Jev filter and saves `[...batch, ...replies]` as is.
- `pickRelevant` runs its 25-line Jev batches 5 at a time with the existing `pool`
  (`src/agent/research/gather.js`), so 1000 lines is about 40 calls in about 2 s. It still keeps nothing
  when Jev is down.

### `src/agent/tools/history.js`

- `readChannelRange` takes a channel and a `before` id (so `/save_note` can use it without a
  message) plus an optional `since` timestamp. It stops paging at `since` or at `count`.
- `fetch_history` range mode saves what it read.
- `fetch_history` search mode searches this channel's memory first. If nothing is stored, it scans the
  last **1000** messages (was 100), Jev keeps the relevant ones, and those are saved and returned. The
  author-only scan is unchanged, but now saves what it returns too.
- `index_chat`: change `around` to `limit: 100` (Discord's maximum, split about evenly before and after).
  Save all of them, unfiltered. The asker-can-read-that-channel check stays.

### Notes (`src/agent/notes.js`, `src/agent/tools/notes.js`, `src/discord/commands.js`)

- New chat tool `save_note({ minutes = 10, topic? })`. The description tells the model to use it for
  any request to summarize, note down, write up or remember a conversation, and to turn "last hour" /
  "today" / "since 9am" into minutes. It reads the current channel back to `now - minutes` (capped at
  1000 messages), calls `saveNote`, and returns the note so Panda can show the summary in its reply.
  Anyone can use it, like `/save_note`.
- `/save_note` gets an optional `minutes` option (default 10), replacing the fixed last 50 messages.
- `saveNote`: today it keeps only the newest 60k characters. New: when the transcript is over 60k,
  first run `pickRelevant` (`relevantTo` the `topic`, or `worthRemembering` when there is no topic), then
  cut to 60k only if it is still over. Jev down → today's cut. Writing, filing and linking are unchanged.
- The system prompt's `Date:` line includes the UTC time, so the model can turn clock times into minutes.

### Also update

- `src/agent/tools/index.js` (register `save_note`), `src/discord/menu.js` (the `/save_note` line),
  `ARCHITECTURE.md` (memory is now per channel and unfiltered; how notes pick their window).
- `docs/superpowers/specs/2026-10-11-pms-db-notes-reminders-design.md`: its non-goal "notes only from
  slash commands" no longer holds.
- Tests: `test/history.test.js` (unfiltered `rememberTurn`, channel scoping, 1000 scan),
  `test/notes.test.js` (over-60k path uses Jev, Jev-down fallback).

## Calls made without Oscar (check these)

- Panda's own replies are saved, so "what did you tell me" works.
- `index_chat` saves all ~100 messages unfiltered. The 1000 scan stays Jev-filtered, as asked.
- Stored memory is searched before the 1000 scan. The scan only runs when nothing matched.
- "Same author, content and date" = the exact timestamp, which the message id already guarantees.
- "Context length" for notes = the existing 60k-character transcript budget.

# Move to PMS db-1: context, notes, reminders

Date: 2026-10-11. Status: approved and built.

## Why

Panda already runs on PMS containers (`panda-bot`, `panda-searxng`). Its data still lives in Supabase.
Oscar wants one home for everything: the PMS Postgres `db-1` in project `oscars-discord-bot`.
While moving, the storage gets three jobs with fixed budgets: hidden chat context, shared notes
organized like a knowledge graph, and DM reminders.

## Goals

1. All bot data lives in PMS `db-1`. Supabase is deleted entirely.
2. db-1 is split into sections with fixed budgets (see Storage budget).
3. Context: hidden, flat, global memory of chat. It is saved selectively and only when missing.
4. Notes: anyone can save a model-written summary of the current conversation. Notes live in a
   folder tree that the model organizes and Jev walks when searching.
5. Reminders: anyone can create one-time or repeating reminders, which are delivered by DM to the
   person who created them, in their own timezone.
6. New slash commands, listed in the `/menu` embed under two new sections.

## Non-goals

- Copying chat history from Supabase. The bot re-indexes when it needs context.
- Saving notes or reminders from free chat ("remind me…"). Only the slash commands create them.
- Editing notes or reminders after creation. Delete and recreate instead.
- Backups. PMS keeps none, so db-1 is the only copy. Oscar accepts this.

## Anti-goals (a failure even if it works)

- Losing Panda's persona (`identity.md`, `soul.md`) or Oscar's `set_rule` history in the move.
- Deleting any data without Oscar confirming first.
- Context ever being shown to users as a browsable thing. It only feeds the model.
- The database being slow or down breaking a chat reply. Every DB call on the reply path must
  fail soft, the way `historyStore.js` and `prompts.js` do today.

## Constraints and facts

- db-1: Postgres, `pms-db-250m-512` (0.25 vCPU, 512 MiB RAM), **1 GiB storage limit**, about 8 MB
  used. Internal host `db-ftbrem10a49p.prj-d6zd0y6e3t41.svc.cluster.local:5432`, database `app`,
  user `app`. The password is set at creation; use `pms db reset-password` if it's lost.
  pgvector is off and stays off (see Decisions).
- The bot container has no disk, and `/app/data` resets on restart, so all durable state must be in db-1.
- There is a single bot instance, so no cross-process locking is needed.
- Node 24, ESM, tests run with `node --test`. A Postgres client is a new dependency (`pg`).
  It's the only one.

## Storage budget

Total = the `storage_limit_bytes` reported by PMS (1 GiB). Sections:

| Section | Share | ≈ size | Tables |
|---|---|---|---|
| Persona | fixed 10 MB, reserved first | 10 MB | `prompts` |
| Context | 75% of the rest | ≈ 760 MB | `context_messages` |
| Notes | 20% of the rest | ≈ 203 MB | `note_folders`, `notes`, `note_links` |
| Reminders | 5% of the rest | ≈ 51 MB | `reminders`, `user_settings` |

- A section's size is `sum(pg_total_relation_size(table))` over its tables.
- The bot checks the sizes after every write to a section (throttled to at most once a minute)
  and once an hour.
- **At 100% of a section:** the bot DMs Oscar (`dmOwner`) once: "Context is full (760 MB). Delete the
  oldest N rows to bring it down to 90%? [Confirm] [Not now]". This reuses the `ApprovalCard`
  pattern. No new alert for that section goes out until the current one is answered.
  - Confirm deletes the oldest rows (by `created_at`) in that section until it's at 90%, then
    reports what it removed.
  - Until Oscar confirms, new writes to that section are refused. Context writes are dropped
    quietly with a log line. Note and reminder commands reply "Storage for notes is full; Oscar has
    been asked to approve a cleanup."
- Persona is never auto-cleaned. Over 10 MB, only an alert is sent.

## Data model (`db/schema.sql`, applied at boot with `create … if not exists`)

```
prompts(name text primary key, content text not null, updated_at timestamptz default now())
  -- identity.md, soul.md, and set_rule's backups (soul.<timestamp>.md)

context_messages(id text primary key,      -- Discord message id; re-saving is a no-op
                 author_id text not null,
                 content text not null,
                 created_at timestamptz not null,   -- "the order"
                 fts tsvector generated always as (to_tsvector('english', content)) stored)
  index on created_at; gin index on fts

note_folders(id bigserial pk, parent_id bigint null references note_folders on delete restrict,
             name text not null, description text not null default '',
             unique (parent_id, name))   -- note: NULL parent needs a partial unique index for roots
notes(id bigserial pk, folder_id bigint not null references note_folders,
      title text not null, description text not null, body text not null,
      author_id text not null, guild_id text null, channel_id text not null,
      created_at timestamptz default now(),
      fts tsvector generated (title || description || body))
  gin index on fts; gin trigram index on title (pg_trgm)
note_links(from_id bigint references notes on delete cascade,
           to_id bigint references notes on delete cascade, primary key (from_id, to_id))

user_settings(user_id text primary key, timezone text not null)   -- IANA name
reminders(id bigserial pk, user_id text not null, name text not null,
          next_at timestamptz not null,             -- absolute UTC
          repeat text not null,                     -- 'once' | 'daily' | 'weekly' | 'monthly'
          local_time text not null,                 -- 'HH:MM' in the creator's zone, for recurrences
          weekday int null, month_day int null,
          timezone text not null,                   -- copied at creation
          active boolean default true, last_error text null,
          created_at timestamptz default now())
  index on (active, next_at)
```

## Context (hidden, flat, global)

- Rows hold only the message id (dedupe key), author id, content and timestamp. There is **no
  server or channel scoping**: Oscar chose truly global context. This is Oscar's call. The cost is
  that anything saved from one server can come up when the bot answers in another.
- **DMs are never saved to context.** A message with no `guildId` is skipped at every save point.
- **Saving is selective.** After a reply goes out (where `saveMessages` runs today in
  `messageHandler.js`), one cheap model call gets the turn's messages and the question "which of
  these lines are worth remembering for later?". It returns message ids, and only those rows are
  inserted, with `on conflict do nothing`. An empty list saves nothing. This call runs after the
  reply, off the reply path, the same way the current save works.
- **Index only when missing.** `fetch_history` search mode queries `context_messages` with full-text
  search first. If nothing ranks above a threshold, it falls back to reading the channel from
  Discord (the existing range mode), then saves only the lines the model picks as relevant to the
  question.
- The `index_chat` tool (read about 50 messages around one old message) stays, but it saves only
  the relevant lines. The **`/index_chat` slash command is removed**, because bulk-saving a whole
  channel goes against the selective rule. It's also removed from the menu.
- Search results go to the model as `[STORED CONTEXT …] <@author_id>: content` lines, oldest first.
  No command lists them.

## Notes (shared, organized)

- **`/save_note`** (anyone). Reads the recent conversation in the channel (the same window the
  bot reads for a normal reply, extended with `readChannelRange` up to about 100 messages). Then
  one model call produces `{title, description, body}`, where the body is an organized markdown
  summary of *everything* discussed.
- **Placement.** A second model call gets the folder tree (names and descriptions only, indented)
  plus the new note's title and description. It returns one of three things: an existing folder
  path, a new folder path (any depth, created as needed, each new folder with a one-line
  description), or a new top-level folder. It can also return up to 3 existing note ids to link,
  chosen from the top 5 full-text matches it was shown. The reply is an embed with the note's
  title, description and folder path.
- **Smart fetch (the model's `search_notes` tool, and `/open_note` when there's no exact title).**
  Start at the root. At each level, ask Jev (`decide`, `choice` question) which child folders are
  relevant to the query, and descend into every child whose probability is ≥ 0.25 (at least the
  top one). The search goes at most 6 levels deep and opens at most 8 folders in total. The
  candidates are the notes in the folders it reached, plus their linked notes, ranked by
  full-text match. **Fallback:** if Jev is off or fails, the search uses plain full-text plus title
  trigram similarity across all notes.
- **`/open_note <title>`** (anyone). An exact title match (case-insensitive) opens that note.
  Otherwise the bot uses the most similar title (`pg_trgm similarity`). If that's below 0.3, it
  falls back to smart fetch and opens the top result. The reply is an embed with the title,
  description, folder path, author, date and the body (split into pages over 4096 chars), plus a
  "Related" line listing linked notes.
- **`/display_notes`** (anyone). An embed showing the tree with indented folders (`📁`) and notes
  (`📄 title — description`). When it doesn't fit (embed limit), it shows top-level folders with
  counts, and a select menu lets the user open a folder, which edits the message to show that
  folder. A "⬆ Up" button goes back. Choosing a note in the select menu opens it, like `/open_note`.
- **`/delete_note <title>`**. The note's author or Oscar can delete it, and the bot confirms with
  a button first. Folders that end up empty are deleted with it.
- Everyone sees every note, from every server. Notes are not hidden.

## Reminders

- **`/add_reminder name when [repeat] [timezone]`**:
  - `when` is `YYYY-MM-DD HH:MM` for a one-time reminder, or `HH:MM` for a repeating one.
  - `repeat` is `once` (default), `daily`, `weekly:<mon..sun>`, or `monthly:<1..31>`.
  - On a first use with no timezone saved and none given, the bot replies (ephemerally) with a
    timezone select of common IANA zones. Picking one saves `user_settings` and creates the
    reminder.
  - Passing `timezone` updates the saved one. It's validated with `Intl.DateTimeFormat`.
  - A one-time reminder in the past is rejected.
  - `monthly:31` in a shorter month fires on the last day of that month.
- **Scheduler:** `setInterval` every 30 s from `index.js` after login. It selects
  `active and next_at <= now()`, DMs the user `⏰ <name>` (adding "(late)" if more than 2 min
  overdue), then either sets `active=false` (once) or computes the next `next_at` from
  `local_time` in the stored timezone, so daylight saving is handled correctly. If a DM fails, it
  sets `last_error` and keeps the reminder going. Missed reminders fire once on startup, never
  more than once.
- **`/show_reminders`** (anyone). An embed listing every active reminder from everyone: name,
  `<@creator>`, next time as `<t:unix:F>` (`<t:unix:R>`), the repeat in words, and ⚠️ with the last
  error if set.
- **`/delete_reminder <name>`**. The creator, or Oscar, deletes it. If several reminders share a
  name, the bot autocompletes from the caller's own reminders (Oscar sees all of them).

## Menu

`menu.js` gets two new fields after "🧠 AI Skill Commands": **📝 Notes**
(`/save_note`, `/display_notes`, `/open_note`, `/delete_note`) and **⏰ Reminders**
(`/add_reminder`, `/show_reminders`, `/delete_reminder`). The "🗂️ History" field goes away
along with `/index_chat`. Command names use underscores, matching the existing commands.

## Migration and cutover order

1. Turn on `pg_trgm` (built in, no PMS toggle needed). Add a `DATABASE_URL` env var to
   `panda-bot` (internal host above) with `pms container edit --set-env-file`. Remove
   `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from config, the redaction list, `.env.example`, and the
   startup warning. Delete `supabase/*.sql` and replace them with `db/schema.sql`.
2. A one-off script copies every object in Supabase Storage bucket `prompts` (`identity.md`,
   `soul.md`, and backups) into the `prompts` table, then verifies the byte counts match.
3. Deploy the new code (CI builds and deploys on push to main).
4. Check in production: Panda answers with its persona, and `set_rule` round-trips.
5. **Only then** delete the Supabase project. This can't be undone and needs Oscar's go-ahead at
   that moment. Oscar does it in the Supabase dashboard (Settings → General → Delete project),
   since the connected tools can only pause a project, not delete it.

## Testing

Tests use an injected query function, the same pattern as `fetchImpl`, so none of them need a real
database. They cover:
- reminder next-time math (daily, weekly, monthly-31 rollover, a DST change in America/Toronto)
- `when` parsing and rejection of bad input
- the budget check deciding to alert or refuse at 100%, and cleanup stopping at 90%
- Jev traversal picking branches and falling back when `decide` returns null
- open_note matching exact, then similar, then smart fetch
- DM messages never reaching context
- the menu listing the new sections

There's also one manual smoke run against db-1 through `pms db connect`.

## My calls (Oscar didn't decide these; check them)

- No pgvector. Titles match by trigram and content by Postgres full-text search, and Jev walking the
  folder tree supplies the "smart" part. Vectors would need an embedding API and would eat into
  the context budget. They can come later if search feels dumb.
- Cleanup trims a full section to 90%, not just enough for one row, so alerts don't repeat constantly.
- While a section waits for cleanup approval, writes are refused rather than oldest rows being dropped.
- Only the author or Oscar can delete a note or reminder.
- `/index_chat` is removed. The model's `index_chat` tool stays, but saves selectively.
- Structured `when` and `repeat` options instead of free text like "tomorrow 7pm". This is simpler
  and can't be misread.
- Reminders missed while the bot was down fire once, late, marked "(late)".
- Command names use underscores (`save_note`) rather than the hyphens in the request (`add-reminder`).

## As built (2026-10-11): where the build differs from this design

- Jev (one yes/no per line, ≥ 0.5) picks the context lines to remember, not a model call. It's faster
  and cheaper, and the bot already relies on it. With Jev off, nothing new is remembered.
- A section's size is `sum(octet_length(row::text))`. `pg_column_size(row)` changes with the query
  plan (about 3 bytes per row), which made the cleanup overshoot by a row in testing.
- The first `/add_reminder` asks for the `timezone` option (with autocomplete) instead of a
  follow-up select menu, so no half-made reminder is held in memory.
- `notes` has no guild or channel columns, because everyone sees every note.
- `/save_note` reads the channel's last 50 messages.

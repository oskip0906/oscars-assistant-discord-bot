-- Everything Panda stores, in the PMS Postgres db-1. Applied at every boot
-- (src/db.js), so every statement must be safe to run again.

create extension if not exists pg_trgm;

-- Persona: identity.md, soul.md, and set_rule's backups (history/soul-….md).
create table if not exists prompts (
  name text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

-- Bot-wide settings that must survive a restart, e.g. the model /set_model picked.
create table if not exists bot_settings (
  key text primary key,
  value text not null
);

-- Private mode (src/privateMode.js): one row, id 1. No row means OFF.
create table if not exists pms (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Hidden chat context, split by channel: a search only returns lines from the
-- channel it runs in (a thread is its own channel). Everything Panda was given
-- is saved, never DMs. The Discord message id makes a re-save a no-op.
create table if not exists context_messages (
  id text primary key,
  author_id text not null,
  content text not null,
  created_at timestamptz not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored
);
create index if not exists context_messages_time on context_messages (created_at);
create index if not exists context_messages_fts on context_messages using gin (fts);
-- Rows saved before the split have no channel, so no search returns them; the
-- context cleanup ages them out, oldest first.
alter table context_messages add column if not exists guild_id text;
alter table context_messages add column if not exists channel_id text;
create index if not exists context_messages_channel on context_messages (channel_id, created_at);
-- How far a channel's history has been copied in (src/discord/indexChannel.js):
-- everything from oldest_id up to newest_id is stored, and complete means
-- oldest_id is the channel's first message. A run picks up from here.
create table if not exists context_channels (
  channel_id text primary key,
  newest_id text,
  oldest_id text,
  complete boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Notes: a folder tree the model organizes, plus links between related notes.
create table if not exists note_folders (
  id bigserial primary key,
  parent_id bigint references note_folders (id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists note_folders_name on note_folders (coalesce(parent_id, 0), lower(name));

create table if not exists notes (
  id bigserial primary key,
  folder_id bigint not null references note_folders (id),
  title text not null,
  description text not null,
  body text not null,
  author_id text not null,
  created_at timestamptz not null default now(),
  fts tsvector generated always as (to_tsvector('english', title || ' ' || description || ' ' || body)) stored
);
create index if not exists notes_fts on notes using gin (fts);
create index if not exists notes_title_trgm on notes using gin (title gin_trgm_ops);

create table if not exists note_links (
  from_id bigint not null references notes (id) on delete cascade,
  to_id bigint not null references notes (id) on delete cascade,
  primary key (from_id, to_id)
);
-- A note can be a file (create_note with a file name): its body is the file's
-- text and file_name what it is sent back as ("plan.md", "list.csv").
alter table notes add column if not exists file_name text;

-- Reminders. next_at is absolute; repeats are recomputed from local_time in the
-- creator's timezone so they survive daylight saving changes.
create table if not exists user_settings (
  user_id text primary key,
  timezone text not null
);

create table if not exists reminders (
  id bigserial primary key,
  user_id text not null,
  name text not null,
  next_at timestamptz not null,
  repeat text not null,          -- once | daily | weekly:<0-6, 0 = Sunday> | monthly:<1-31>
  local_time text not null,      -- HH:MM in timezone
  timezone text not null,
  active boolean not null default true,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists reminders_due on reminders (next_at) where active;
-- Where the reminder was made. It goes off there, pinging its creator; null
-- (made in a DM, or before this column) means a DM.
alter table reminders add column if not exists channel_id text;

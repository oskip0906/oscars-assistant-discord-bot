-- Message history for Panda: fetch_history reads it, the chat handler and
-- /index_chat write it. Applied to Supabase as the `discord_history` migration.

create table public.discord_messages (
  id text primary key,            -- Discord message id: re-saving a message just refreshes it
  guild_id text,                  -- null for DMs
  guild_name text,
  channel_id text not null,
  channel_name text,
  author_id text not null,
  author_name text not null,
  is_bot boolean not null default false,
  content text not null,
  reply_to text,
  created_at timestamptz not null,
  fts tsvector generated always as (to_tsvector('english', content)) stored
);
create index discord_messages_channel_time on public.discord_messages (channel_id, created_at);
create index discord_messages_guild_time on public.discord_messages (guild_id, created_at);
create index discord_messages_fts on public.discord_messages using gin (fts);

-- No policies on purpose: only the bot's secret key (which bypasses RLS) can touch it.
alter table public.discord_messages enable row level security;

-- Server → channel → conversation. A conversation is a run of messages in one
-- channel with no gap over 30 minutes; it is worked out here at read time, so
-- backfills in any order still group correctly.
-- Query mode returns the conversations whose best keyword match ranks highest,
-- each cut to 20 messages before and 10 after that match. No query returns the
-- most recent conversations, each cut to its last 21 messages.
-- p_author keeps only matches sent by someone whose name contains it; the
-- conversation around each match still shows everyone, for context.
-- shortcut: re-groups the whole channel/server on every call; store a
-- conversation id at write time if a scope grows past ~1M messages.
create or replace function public.search_discord_history(
  p_guild_id text,
  p_channel_id text default null,
  p_query text default null,
  p_conversations int default 3,
  p_author text default null
) returns table (
  channel_id text,
  channel_name text,
  conversation bigint,
  author_name text,
  is_bot boolean,
  content text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  with scoped as (
    select m.*,
      case when m.created_at - lag(m.created_at) over (partition by m.channel_id order by m.created_at, m.id)
                <= interval '30 minutes' then 0 else 1 end as starts
    from public.discord_messages m
    where m.guild_id is not distinct from p_guild_id
      and (p_channel_id is null or m.channel_id = p_channel_id)
  ),
  grouped as (
    select s.*, sum(s.starts) over (partition by s.channel_id order by s.created_at, s.id) as convo
    from scoped s
  ),
  positioned as (
    select g.*, row_number() over (partition by g.channel_id, g.convo order by g.created_at, g.id) as pos
    from grouped g
  ),
  hits as (
    select distinct on (p.channel_id, p.convo)
      p.channel_id, p.convo, p.pos as hit_pos, p.created_at as hit_at,
      case when coalesce(p_query, '') = '' then extract(epoch from p.created_at)::float8
           else ts_rank(p.fts, websearch_to_tsquery('english', p_query))::float8 end as score
    from positioned p
    where (coalesce(p_query, '') = '' or p.fts @@ websearch_to_tsquery('english', p_query))
      and (coalesce(p_author, '') = '' or p.author_name ilike '%' || p_author || '%')
    order by p.channel_id, p.convo, score desc
  ),
  top as (
    select * from hits order by score desc, hit_at desc limit p_conversations
  )
  select p.channel_id, p.channel_name, p.convo, p.author_name, p.is_bot, p.content, p.created_at
  from positioned p
  join top t on t.channel_id = p.channel_id and t.convo = p.convo
  where p.pos between t.hit_pos - 20 and t.hit_pos + 10
  order by t.hit_at, p.channel_id, p.convo, p.pos;
$$;

revoke execute on function public.search_discord_history(text, text, text, int, text) from public, anon, authenticated;

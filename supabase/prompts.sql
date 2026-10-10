-- Panda's prompts live in Storage, not in the repo: prompts/identity.md (fixed)
-- and prompts/soul.md (Oscar changes it with set_rule), plus prompts/history/,
-- where set_rule keeps every soul.md it replaces. Applied to Supabase as the
-- `prompts_bucket` migration.

-- Private and no policies on purpose: only the bot's secret key (which bypasses RLS) can touch it.
insert into storage.buckets (id, name, public)
values ('prompts', 'prompts', false)
on conflict (id) do nothing;

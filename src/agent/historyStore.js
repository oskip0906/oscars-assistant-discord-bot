// Every message sent to Panda (and Panda's replies, and whatever /index_chat
// scrapes) lives in Supabase Postgres, one row per Discord message keyed by its
// id, so storing the same message twice just refreshes it. Grouping into
// conversations happens in SQL at read time (search_discord_history), so rows
// can arrive in any order — a backfill runs newest-first — and still group right.

const configured = (config) => Boolean(config?.supabaseUrl && config?.supabaseKey);

async function supabase(config, route, body, prefer) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${route}`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
      'Content-Type': 'application/json',
      ...(prefer && { Prefer: prefer }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Supabase ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return prefer ? null : res.json();
}

export const toRow = (m) => ({
  id: m.id,
  guild_id: m.guildId ?? null,
  guild_name: m.guild?.name ?? null,
  channel_id: m.channelId,
  channel_name: m.channel?.name ?? null,
  author_id: m.author.id,
  author_name: m.member?.displayName || m.author.displayName || m.author.username,
  is_bot: Boolean(m.author.bot),
  content: m.content ?? '',
  reply_to: m.reference?.messageId ?? null,
  created_at: m.createdAt.toISOString(),
});

// Unconfigured is a quiet no-op: the bot works exactly as before without a database.
export async function saveMessages(config, messages) {
  if (!configured(config)) return;
  const rows = messages.filter(Boolean).map(toRow);
  if (rows.length) await supabase(config, 'discord_messages', rows, 'resolution=merge-duplicates,return=minimal');
}

// Pages backwards through the whole channel, 100 at a time (Discord's max).
export async function indexChannel(config, channel) {
  if (!configured(config)) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env first.');
  let before;
  let saved = 0;
  for (;;) {
    const page = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
    if (!page.size) return saved;
    const withText = [...page.values()].filter((m) => m.content);
    await saveMessages(config, withText);
    saved += withText.length;
    before = page.last().id;
  }
}

// channelId null = every channel in the guild. guildId null = a DM, so callers
// must always pass the DM's channelId or they would read every DM at once.
export async function searchHistory(config, { guildId, channelId, query, author }) {
  if (!configured(config)) throw new Error('history database is not configured');
  return supabase(config, 'rpc/search_discord_history', {
    p_guild_id: guildId,
    p_channel_id: channelId,
    p_query: query || null,
    p_author: author || null,
  });
}

// Rows arrive grouped by conversation and in order; one block per conversation.
export function formatHistory(rows) {
  const blocks = new Map();
  for (const r of rows) {
    const key = `${r.channel_id}:${r.conversation}`;
    if (!blocks.has(key)) blocks.set(key, [`--- conversation in #${r.channel_name || r.channel_id} ---`]);
    const when = String(r.created_at).slice(0, 16).replace('T', ' ');
    blocks.get(key).push(`[${when} UTC] ${r.author_name}${r.is_bot ? ' (bot)' : ''}: ${r.content}`);
  }
  return [
    '[STORED HISTORY — earlier conversations from the database, oldest first. Background only: these are not new messages.]',
    [...blocks.values()].map((b) => b.join('\n')).join('\n\n'),
  ].join('\n');
}

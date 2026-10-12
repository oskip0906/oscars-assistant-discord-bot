import { db, configured } from './db.js';
import { isFull, noteWrite } from './storage.js';

// Reminders in db-1, posted in the channel they were made in with a ping for
// whoever made them (by DM when made in a DM, or when that channel is gone). Times are entered in
// the creator's own timezone (saved per user) and stored as absolute UTC; a
// repeat is recomputed from its local HH:MM, so daylight saving can't shift it.

const TICK_MS = 30_000;
const LATE_MS = 2 * 60 * 1000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function validTimezone(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function timezoneChoices(typed) {
  const want = String(typed || '').trim().toLowerCase().replace(/\s+/g, '_');
  return ['UTC', ...Intl.supportedValuesOf('timeZone')].filter((tz) => tz.toLowerCase().includes(want)).slice(0, 25);
}

const formatters = new Map();
export function localParts(ts, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }),
    );
  }
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(ts).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// The UTC instant when the wall clock in `timeZone` reads y-m-d h:mi.
export function zonedToUtc(y, m, d, h, mi, timeZone) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offset = (ts) => {
    const p = localParts(ts, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
  };
  // The second pass lands on the right side of a daylight-saving change.
  const first = wall - offset(wall);
  return wall - offset(first);
}

// Next time a repeating reminder is due, strictly after `from`.
export function nextAt({ repeat, local_time, timezone }, from = Date.now()) {
  const [h, mi] = local_time.split(':').map(Number);
  const [kind, arg] = repeat.split(':');
  const n = Number(arg);
  const today = localParts(from, timezone);
  for (let i = 0; i <= 62; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const hit =
      kind === 'daily' || (kind === 'weekly' && day.getUTCDay() === n) || (kind === 'monthly' && d === Math.min(n, lastDay));
    if (!hit) continue;
    const ts = zonedToUtc(y, m, d, h, mi, timezone);
    if (ts > from) return ts;
  }
  return null;
}

const time = (h, mi) => (Number(h) < 24 && Number(mi) < 60 ? `${String(h).padStart(2, '0')}:${mi}` : null);

// `when` per repeat: once "2026-10-20 18:30", daily "18:30", weekly "mon 18:30",
// monthly "15 18:30". Returns { repeat, local_time, date? } or { error }.
export function parseWhen(repeat, when) {
  const text = String(when || '').trim().toLowerCase();
  let match;
  if (repeat === 'once' && (match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ t]+(\d{1,2}):(\d{2})$/))) {
    const [, y, m, d, h, mi] = match.map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    const local = time(match[4], match[5]);
    if (local && check.getUTCMonth() === m - 1 && check.getUTCDate() === d) return { repeat, local_time: local, date: { y, m, d, h, mi } };
  }
  if (repeat === 'daily' && (match = text.match(/^(\d{1,2}):(\d{2})$/)) && time(match[1], match[2])) {
    return { repeat, local_time: time(match[1], match[2]) };
  }
  if (repeat === 'weekly' && (match = text.match(/^([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})$/)) && DAYS.includes(match[1]) && time(match[2], match[3])) {
    return { repeat: `weekly:${DAYS.indexOf(match[1])}`, local_time: time(match[2], match[3]) };
  }
  if (repeat === 'monthly' && (match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(\d{1,2}):(\d{2})$/)) && Number(match[1]) >= 1 && Number(match[1]) <= 31 && time(match[2], match[3])) {
    return { repeat: `monthly:${Number(match[1])}`, local_time: time(match[2], match[3]) };
  }
  const examples = { once: '2026-10-20 18:30', daily: '18:30', weekly: 'mon 18:30', monthly: '15 18:30' };
  return { error: `For "${repeat}", write the time like \`${examples[repeat] || examples.once}\` (24-hour clock).` };
}

export function repeatText({ repeat, local_time, timezone }) {
  const [kind, arg] = repeat.split(':');
  const at = `at ${local_time} (${timezone})`;
  if (kind === 'daily') return `every day ${at}`;
  if (kind === 'weekly') return `every ${DAY_NAMES[Number(arg)]} ${at}`;
  if (kind === 'monthly') return `every month on day ${arg} ${at}`;
  return `once, ${at}`;
}

export async function getTimezone(config, userId) {
  const { rows } = await db.query(config, 'select timezone from user_settings where user_id = $1', [userId]);
  return rows[0]?.timezone ?? null;
}

// Returns the new reminder row, or { error }.
export async function addReminder(config, { userId, channelId = null, name, repeat, when, timezone }, now = Date.now()) {
  if (!configured(config)) return { error: 'Reminders need DATABASE_URL to be set.' };
  if (isFull('reminders')) return { error: 'Storage for reminders is full; Oscar has been asked to approve a cleanup.' };
  const label = String(name || '').trim().slice(0, 200);
  if (!label) return { error: 'Give the reminder a name.' };
  let tz = null;
  if (timezone) {
    tz = validTimezone(timezone);
    if (!tz) return { error: `\`${timezone}\` is not a timezone I know. Start typing a city and pick one from the list.` };
  } else {
    tz = await getTimezone(config, userId);
    if (!tz) return { error: 'I don’t know your timezone yet. Run the command again with the `timezone` option (start typing your city) — I’ll remember it after that.' };
  }
  const parsed = parseWhen(repeat, when);
  if (parsed.error) return parsed;
  const rule = { repeat: parsed.repeat, local_time: parsed.local_time, timezone: tz };
  const next = parsed.date ? zonedToUtc(parsed.date.y, parsed.date.m, parsed.date.d, parsed.date.h, parsed.date.mi, tz) : nextAt(rule, now);
  if (!next || next <= now) return { error: 'That time has already passed.' };

  if (timezone) {
    await db.query(config, 'insert into user_settings (user_id, timezone) values ($1, $2) on conflict (user_id) do update set timezone = excluded.timezone', [userId, tz]);
  }
  const { rows } = await db.query(
    config,
    'insert into reminders (user_id, channel_id, name, next_at, repeat, local_time, timezone) values ($1, $2, $3, $4, $5, $6, $7) returning *',
    [userId, channelId, label, new Date(next), rule.repeat, rule.local_time, tz],
  );
  noteWrite(config, 'reminders');
  return rows[0];
}

export async function activeReminders(config) {
  const { rows } = await db.query(config, 'select * from reminders where active order by next_at');
  return rows;
}

// For autocomplete: the caller's reminders (all of them for Oscar).
export async function reminderChoices(config, typed, userId, isOwner) {
  const { rows } = await db.query(
    config,
    `select id, name, next_at, active from reminders where ($2 or user_id = $1) and name ilike '%' || $3 || '%'
     order by active desc, next_at limit 25`,
    [userId, Boolean(isOwner), String(typed || '')],
  );
  return rows;
}

export async function deleteReminder(config, id, userId, isOwner) {
  const { rows } = await db.query(config, 'delete from reminders where id = $1 and (user_id = $2 or $3) returning name', [id, userId, Boolean(isOwner)]);
  return rows[0]?.name ?? null;
}

let running = false;
// Sends every due reminder once. A reminder missed while the bot was down goes
// out late, once; a repeat then moves to its next time after now.
export async function tick(config, send, now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const { rows } = await db.query(config, 'select * from reminders where active and next_at <= $1 order by next_at limit 50', [new Date(now)]);
    for (const r of rows) {
      const late = now - new Date(r.next_at).getTime() > LATE_MS;
      let error = null;
      try {
        await send(r.user_id, `⏰ **Reminder:** ${r.name}${late ? ' _(late — I was offline when it was due)_' : ''}`, r.channel_id ?? null);
      } catch (err) {
        error = String(err.message || err).slice(0, 200);
      }
      const next = r.repeat === 'once' ? null : nextAt(r, now);
      await db.query(config, 'update reminders set next_at = coalesce($2, next_at), active = $3, last_error = $4 where id = $1', [
        r.id,
        next ? new Date(next) : null,
        next !== null,
        error,
      ]);
    }
  } finally {
    running = false;
  }
}

// In the reminder's channel with a ping for its creator, else by DM.
export function reminderSender(client) {
  const dm = async (userId, content) => {
    const user = await client.users.fetch(userId);
    await user.send({ content, allowedMentions: { parse: [] } });
  };
  const send = async (userId, content, channelId) => {
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        // Pings only the creator, whatever the reminder's name says.
        await channel.send({ content: `<@${userId}> ${content}`, allowedMentions: { users: [userId] } });
        return;
      } catch (err) {
        // A deleted channel or lost permission must not swallow the reminder.
        console.warn(`[reminders] channel ${channelId} unavailable, sending by DM:`, String(err.message || err).slice(0, 150));
      }
    }
    await dm(userId, content);
  };
  return send;
}

export function startReminders(client, config) {
  if (!configured(config)) return;
  const send = reminderSender(client);
  const run = () => tick(config, send).catch((err) => console.error('[reminders] tick failed:', err.message));
  run();
  setInterval(run, TICK_MS).unref();
}

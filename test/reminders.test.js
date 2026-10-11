import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen, nextAt, zonedToUtc, addReminder, tick, repeatText, validTimezone } from '../src/reminders.js';
import { db } from '../src/db.js';

const iso = (ts) => new Date(ts).toISOString();
const TO = 'America/Toronto';

test('parses each repeat, and rejects what does not fit', () => {
  assert.deepEqual(parseWhen('once', '2026-10-20 18:30'), { repeat: 'once', local_time: '18:30', date: { y: 2026, m: 10, d: 20, h: 18, mi: 30 } });
  assert.deepEqual(parseWhen('daily', '7:05'), { repeat: 'daily', local_time: '07:05' });
  assert.deepEqual(parseWhen('weekly', 'Monday 09:00'), { repeat: 'weekly:1', local_time: '09:00' });
  assert.deepEqual(parseWhen('monthly', '31st 10:00'), { repeat: 'monthly:31', local_time: '10:00' });
  for (const [repeat, when] of [['once', '2026-02-30 10:00'], ['daily', '24:00'], ['daily', '7pm'], ['weekly', 'xyz 10:00'], ['monthly', '32 10:00'], ['monthly', '0 10:00']]) {
    assert.ok(parseWhen(repeat, when).error, `${repeat} ${when}`);
  }
});

test('local wall time converts to UTC on both sides of a daylight saving change', () => {
  assert.equal(iso(zonedToUtc(2026, 7, 1, 9, 0, TO)), '2026-07-01T13:00:00.000Z'); // EDT, UTC-4
  assert.equal(iso(zonedToUtc(2026, 12, 1, 9, 0, TO)), '2026-12-01T14:00:00.000Z'); // EST, UTC-5
  assert.equal(iso(zonedToUtc(2026, 3, 8, 9, 0, TO)), '2026-03-08T13:00:00.000Z'); // the morning clocks spring forward
});

test('next time for daily, weekly and monthly repeats', () => {
  const from = Date.parse('2026-10-31T23:00:00Z'); // Sat Oct 31, 19:00 in Toronto
  const daily = { repeat: 'daily', local_time: '18:00', timezone: TO };
  assert.equal(iso(nextAt(daily, from)), '2026-11-01T23:00:00.000Z'); // tomorrow; today's 18:00 has passed, and DST ended overnight
  assert.equal(iso(nextAt({ ...daily, local_time: '20:00' }, from)), '2026-11-01T00:00:00.000Z'); // later today
  assert.equal(iso(nextAt({ repeat: 'weekly:1', local_time: '09:00', timezone: TO }, from)), '2026-11-02T14:00:00.000Z');
  // monthly on the 31st falls on the last day of a shorter month
  assert.equal(iso(nextAt({ repeat: 'monthly:31', local_time: '09:00', timezone: 'UTC' }, from)), '2026-11-30T09:00:00.000Z');
});

test('describes a repeat in words', () => {
  assert.equal(repeatText({ repeat: 'weekly:3', local_time: '09:00', timezone: TO }), 'every Wednesday at 09:00 (America/Toronto)');
  assert.equal(validTimezone('America/Toronto'), 'America/Toronto');
  assert.equal(validTimezone('Mars/Base'), null);
});

function remindersTable(rows = [], settings = {}) {
  const log = { updates: [], inserts: [] };
  db.query = async (_config, text, params) => {
    if (text.includes('as used')) return { rows: [{ used: 0 }] };
    if (text.startsWith('select timezone')) return { rows: settings[params[0]] ? [{ timezone: settings[params[0]] }] : [] };
    if (text.startsWith('insert into user_settings')) return (settings[params[0]] = params[1]), { rows: [] };
    if (text.startsWith('insert into reminders')) {
      const row = { id: 1, user_id: params[0], name: params[1], next_at: params[2], repeat: params[3], local_time: params[4], timezone: params[5] };
      log.inserts.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('select * from reminders where active and next_at')) return { rows: rows.filter((r) => r.next_at <= params[0]) };
    if (text.startsWith('update reminders')) return log.updates.push(params), { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  };
  return log;
}

const config = { databaseUrl: 'postgres://test' };

test('adding a reminder needs a timezone once, then remembers it', async () => {
  const settings = {};
  const log = remindersTable([], settings);
  const now = Date.parse('2026-10-11T12:00:00Z');
  const first = await addReminder(config, { userId: 'u', name: 'gym', repeat: 'daily', when: '18:00' }, now);
  assert.match(first.error, /timezone/);
  assert.match((await addReminder(config, { userId: 'u', name: 'gym', repeat: 'daily', when: '18:00', timezone: 'Mars/Base' }, now)).error, /not a timezone/);

  const added = await addReminder(config, { userId: 'u', name: 'gym', repeat: 'daily', when: '18:00', timezone: TO }, now);
  assert.equal(iso(added.next_at), '2026-10-11T22:00:00.000Z');
  assert.equal(settings.u, TO);
  const again = await addReminder(config, { userId: 'u', name: 'call mom', repeat: 'once', when: '2026-10-12 09:00' }, now);
  assert.equal(iso(again.next_at), '2026-10-12T13:00:00.000Z');
  assert.match((await addReminder(config, { userId: 'u', name: 'x', repeat: 'once', when: '2026-10-01 09:00' }, now)).error, /passed/);
  assert.equal(log.inserts.length, 2);
});

test('a due reminder is DMed once: a one-off ends, a repeat moves on, a failed DM is recorded', async () => {
  const now = Date.parse('2026-10-11T22:00:30Z');
  const rows = [
    { id: 1, user_id: 'a', name: 'pay rent', next_at: new Date('2026-10-11T22:00:00Z'), repeat: 'once', local_time: '18:00', timezone: TO },
    { id: 2, user_id: 'b', name: 'gym', next_at: new Date('2026-10-10T22:00:00Z'), repeat: 'daily', local_time: '18:00', timezone: TO },
    { id: 4, user_id: 'd', name: 'water plants', next_at: new Date('2026-10-11T21:00:00Z'), repeat: 'weekly:0', local_time: '17:00', timezone: TO },
    { id: 3, user_id: 'c', name: 'later', next_at: new Date('2026-10-12T22:00:00Z'), repeat: 'once', local_time: '18:00', timezone: TO },
  ];
  const log = remindersTable(rows);
  const sent = [];
  await tick(config, async (userId, content) => {
    if (userId === 'b') throw new Error('Cannot send messages to this user');
    sent.push([userId, content]);
  }, now);

  assert.deepEqual(sent, [['a', '⏰ **Reminder:** pay rent'], ['d', '⏰ **Reminder:** water plants _(late — I was offline when it was due)_']]);
  assert.deepEqual(log.updates[0], [1, null, false, null]);
  const [id, next, active, error] = log.updates[1];
  assert.deepEqual([id, active, error], [2, true, 'Cannot send messages to this user']);
  assert.equal(iso(next), '2026-10-12T22:00:00.000Z');
  assert.equal(iso(log.updates[2][1]), '2026-10-18T21:00:00.000Z');
  assert.equal(log.updates.length, 3, 'a reminder not yet due is left alone');
});

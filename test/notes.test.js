import test from 'node:test';
import assert from 'node:assert/strict';
import { walkFolders, orQuery, folderPath, treeOutline, saveNote, windowMessages } from '../src/agent/notes.js';
import { folderView } from '../src/discord/notes.js';
import { db } from '../src/db.js';
import { check, cleanup, resetStorageState, setAlertOwner, SECTIONS } from '../src/storage.js';

const config = { databaseUrl: 'postgres://test', openrouterApiKey: 'k' };

// Travel/{Japan, Budget}, Music, and Travel/Japan/Food.
const folders = [
  { id: 1, parent_id: null, name: 'Travel', description: 'trips' },
  { id: 2, parent_id: 1, name: 'Japan', description: 'the Japan trip' },
  { id: 3, parent_id: 1, name: 'Budget', description: 'money for trips' },
  { id: 4, parent_id: null, name: 'Music', description: 'the music bot' },
  { id: 5, parent_id: 2, name: 'Food', description: 'where to eat' },
];

// Jev as a table: folder name -> probability.
const jev = (probs, seen = []) => async (_config, state, questions) => {
  seen.push(Object.keys(questions.folder.criteria));
  const keys = Object.keys(questions.folder.criteria);
  const probabilities = Object.fromEntries(keys.map((k) => [k, probs[folders.find((f) => `f${f.id}` === k).name] ?? 0]));
  const choice = keys.reduce((a, b) => (probabilities[a] >= probabilities[b] ? a : b));
  return { folder: { choice, probabilities } };
};

test('Jev walks down the branches it is sure enough of, level by level', async () => {
  const seen = [];
  const reached = await walkFolders(config, folders, 'ramen in tokyo', jev({ Travel: 0.9, Music: 0.1, Japan: 0.7, Budget: 0.3 }, seen));
  // Travel; then both Japan and Budget (>= 0.25); Food is Japan's only child, so no question.
  assert.deepEqual([...reached].sort(), [1, 2, 3, 5]);
  assert.deepEqual(seen, [['f1', 'f4'], ['f2', 'f3']]);
});

test('a weak level still takes its top pick, and Jev down means no walk', async () => {
  const reached = await walkFolders(config, folders, 'x', jev({ Travel: 0.1, Music: 0.2, Japan: 0.1, Budget: 0.1 }));
  assert.deepEqual([...reached], [4]);
  assert.equal(await walkFolders(config, folders, 'x', async () => null), null);
});

test('folder paths, the outline the model files into, and any-word queries', () => {
  assert.deepEqual(folderPath(folders, 5), ['Travel', 'Japan', 'Food']);
  assert.equal(treeOutline(folders), '- Travel: trips\n  - Japan: the Japan trip\n    - Food: where to eat\n  - Budget: money for trips\n- Music: the music bot');
  assert.equal(orQuery('ramen, tokyo!'), 'ramen or tokyo');
});

test('the notes browser shows the tree with counts and lets you open folders and notes', () => {
  const notes = [{ id: 9, folder_id: 5, title: 'Ichiran', description: 'best ramen' }];
  const top = folderView({ folders, notes }).embeds[0].toJSON();
  assert.match(top.description, /📁 \*\*Travel\*\* \(1\)[\s\S]*📄 Ichiran — best ramen/);
  const japan = folderView({ folders, notes }, 2);
  const [menu, up] = japan.components.map((c) => c.toJSON().components[0]);
  assert.deepEqual(menu.options.map((o) => o.value), ['f5']);
  assert.equal(up.custom_id, 'notes:up:1');
  assert.match(folderView({ folders: [], notes: [] }).embeds[0].toJSON().description, /No notes yet/);
});

test('a new note is filed into existing and new folders, with links only to notes it was shown', async () => {
  const created = [];
  const inserts = [];
  db.query = async (_c, text, params) => {
    if (text.startsWith('select id, parent_id')) return { rows: folders };
    if (text.includes('from notes n, websearch_to_tsquery')) return { rows: [{ id: '7', title: 'JR pass', description: 'rail' }] };
    if (text.startsWith('select id from note_folders')) {
      const hit = [...folders, ...created].find((f) => (f.parent_id ?? 0) === (params[0] ?? 0) && f.name.toLowerCase() === params[1].toLowerCase());
      return { rows: hit ? [{ id: String(hit.id) }] : [] };
    }
    if (text.startsWith('insert into note_folders')) return created.push({ id: 100 + created.length, parent_id: params[0], name: params[1], description: params[2] }), { rows: [] };
    if (text.startsWith('insert into notes')) return inserts.push(params), { rows: [{ id: '50' }] };
    if (text.startsWith('insert into note_links')) return inserts.push(params), { rows: [] };
    if (text.includes('as used')) return { rows: [{ used: 0 }] };
    return { rows: [] };
  };
  const answers = [
    { title: 'Kyoto day', description: 'what we do in Kyoto', body: '- temples' },
    { path: ['travel', 'Japan', 'Kyoto'], descriptions: { Kyoto: 'the Kyoto leg' }, links: [7, 99] },
  ];
  const ask = async ({ isValid }) => {
    const value = answers.shift();
    assert.ok(isValid(value));
    return value;
  };
  const m = { content: 'lets do temples', createdAt: new Date('2026-10-11T12:00:00Z'), author: { username: 'oscar' } };
  const out = await saveNote(config, { messages: [m], authorId: 'u1' }, { ask });
  assert.deepEqual(out.path, ['travel', 'Japan', 'Kyoto']);
  assert.deepEqual(created, [{ id: 100, parent_id: 2, name: 'Kyoto', description: 'the Kyoto leg' }]);
  assert.deepEqual(inserts[0], [100, 'Kyoto day', 'what we do in Kyoto', '- temples', 'u1']);
  assert.deepEqual(inserts[1], [50, [7]], 'note 99 was never shown, so it is not linked');
});

test('a note covers the last 10 minutes by default, or as many as asked', async () => {
  // One message every minute for an hour, newest first like Discord.
  const now = Date.now();
  const all = Array.from({ length: 60 }, (_, k) => ({ id: String(1000 - k), content: `m${k}`, createdTimestamp: now - (k + 0.5) * 60_000 }));
  const channel = {
    messages: {
      fetch: async ({ limit, before }) => {
        const page = all.filter((m) => !before || Number(m.id) < Number(before)).slice(0, limit);
        return Object.assign(new Map(page.map((m) => [m.id, m])), { last: () => page.at(-1) });
      },
    },
  };
  const ten = await windowMessages(channel, undefined, null);
  assert.deepEqual(ten.map((m) => m.content), ['m9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0']);
  assert.equal((await windowMessages(channel, undefined, 30)).length, 30);
});

test('a transcript too long for the writer goes through Jev first, and is cut when Jev is down', async () => {
  db.query = async (_c, text) => (text.includes('as used') ? { rows: [{ used: 0 }] } : { rows: [] });
  // 150 lines of ~500 characters: well over the 60k the writer is given.
  const messages = Array.from({ length: 150 }, (_, n) => ({
    content: `${n % 10 === 0 ? 'budget' : 'chatter'} ${n} ${'x'.repeat(480)}`,
    createdAt: new Date('2026-10-11T12:00:00Z'),
    author: { username: 'oscar' },
  }));
  const keepBudget = async (_c, state, questions) =>
    Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: /budget/.test(state[q.slice(5)]) ? 0.9 : 0.1 }]));
  const seen = [];
  const ask = async ({ user }) => (seen.push(user), null); // stop after the writer sees the transcript

  await saveNote(config, { messages, authorId: 'u1', topic: 'budget' }, { ask, decideImpl: keepBudget });
  const kept = seen[0].split('\n');
  assert.equal(kept.length, 15);
  assert.ok(kept.every((l) => / budget \d+ /.test(l)));

  await saveNote(config, { messages, authorId: 'u1' }, { ask, decideImpl: async () => null });
  assert.ok(seen[1].length <= 60_000);
  assert.match(seen[1], /chatter 149 x+$/, 'the newest lines survive the cut');
});

// --- storage budget ----------------------------------------------------------

test('a full section alerts Oscar once, and his cleanup trims it to 90%', async () => {
  resetStorageState();
  const budget = SECTIONS.notes.budget;
  let used = budget + 100;
  const deletes = [];
  db.query = async (_c, text, params) => {
    if (text.includes('as used')) return { rows: [{ used }] };
    if (text.startsWith('delete from notes')) {
      deletes.push(params[0]);
      used = budget * 0.9;
      return { rowCount: 12 };
    }
    if (text.startsWith('delete from note_folders')) return { rowCount: 0 };
    throw new Error(`unexpected query: ${text}`);
  };
  const alerts = [];
  setAlertOwner(async (section, bytes) => alerts.push([section, bytes]));
  try {
    await check(config, 'notes');
    await check(config, 'notes');
    assert.deepEqual(alerts, [['notes', budget + 100]]);
    const result = await cleanup(config, 'notes');
    assert.equal(deletes[0], Math.ceil(budget * 0.1 + 100), 'frees exactly down to 90%');
    assert.deepEqual(result, { deleted: 12, used: budget * 0.9 });
  } finally {
    resetStorageState();
  }
});

test('a long folder listing is split into pages, and every entry gets a menu option', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, folder_id: null, title: `Note ${i + 1}`, description: 'x'.repeat(120) }));
  const view = folderView({ folders: [], notes: many });
  assert.ok(view.rest.length >= 1, 'more than one page');
  const pages = [view.embeds[0], ...view.rest.map((p) => p.embeds[0])].map((e) => e.toJSON());
  for (const p of pages) assert.ok(p.description.length <= 4096);
  const listed = pages.map((p) => p.description).join('\n');
  for (const n of many) assert.match(listed, new RegExp(`📄 ${n.title} —`));
  assert.match(pages.at(-1).footer.text, new RegExp(`page ${pages.length}/${pages.length}`));
  const menus = view.components.map((c) => c.toJSON().components[0]);
  assert.deepEqual(menus.map((m) => m.options.length), [25, 25, 10]);
  assert.equal(new Set(menus.map((m) => m.custom_id)).size, 3, 'menu ids are unique');
  assert.deepEqual(folderView({ folders, notes: [] }).rest, []);
});

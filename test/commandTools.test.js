import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDefs, OWNER_ONLY_COMMANDS } from '../src/discord/commandDefs.js';
import { commandDefs as registered } from '../src/discord/commands.js';
import { COMMAND_TOOLS, pandaCommands, currentModel, usage, setModel, research } from '../src/agent/tools/commands.js';
import { toolDefs, executeTool, validateArgs, OWNER_ONLY_TOOLS, LOOKUP_TOOLS, isLookup } from '../src/agent/tools/index.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import { runAgent } from '../src/agent/agent.js';
import { JEV_MODEL } from '../src/agent/jev.js';
import { db } from '../src/db.js';

const OWNER = '111111111111111111';
const config = (extra = {}) => ({ botName: 'Panda', ownerId: OWNER, model: 'vendor/model-a', modelProviders: {}, githubMcpEnabled: false, ...extra });
const chatInvocation = (extra = {}) => {
  const sent = [];
  return {
    config: config(extra.config),
    isOwner: false,
    guild: { id: 'g', name: 'Server' },
    message: { id: 'm1', author: { id: '2', username: 'guest' }, channel: { id: 'c1', name: 'general', messages: {}, send: async (p) => sent.push(p) } },
    sent,
    ...extra,
  };
};

// Swaps db.query for a fake for one test.
async function withDb(fake, fn) {
  const real = db.query;
  db.query = fake;
  try {
    return await fn();
  } finally {
    db.query = real;
  }
}

test('commands.js still registers the shared definitions', () => {
  assert.equal(registered, commandDefs);
});

test('every slash command is a callable tool or explicitly gated, and every tool it names exists', async () => {
  const names = commandDefs.map((c) => c.name);
  assert.deepEqual([...Object.keys(COMMAND_TOOLS)].sort(), [...names].sort(), 'COMMAND_TOOLS covers exactly the registered commands');
  const tools = new Set((await toolDefs({ isOwner: true, config: config() })).map((t) => t.function.name));
  for (const [command, route] of Object.entries(COMMAND_TOOLS)) {
    assert.ok(Boolean(route.tool) !== Boolean(route.gated), `/${command} is either a tool or gated`);
    if (route.tool) assert.ok(tools.has(route.tool), `/${command} → ${route.tool} is a registered tool`);
    else assert.ok(route.gated.length > 20, `/${command} explains why it is gated`);
  }
});

test('owner-only commands map to owner-only tools (or stay gated), and public ones never do', () => {
  for (const [command, route] of Object.entries(COMMAND_TOOLS)) {
    if (!route.tool) continue;
    assert.equal(OWNER_ONLY_TOOLS.has(route.tool), OWNER_ONLY_COMMANDS.has(command), `/${command} and ${route.tool} agree on who may run them`);
  }
  for (const name of OWNER_ONLY_COMMANDS) {
    const cmd = commandDefs.find((c) => c.name === name);
    assert.ok(cmd, `${name} exists`);
    assert.match(cmd.description, /owner only/i, `/${name} says it is owner only`);
  }
});

test('every tool has a description and an object schema whose required fields are declared', async () => {
  for (const t of await toolDefs({ isOwner: true, config: config() })) {
    const { name, description, parameters } = t.function;
    assert.ok(description?.length > 30, `${name} has a real description`);
    assert.equal(parameters.type, 'object', name);
    for (const key of parameters.required || []) assert.ok(parameters.properties?.[key], `${name}.${key} is declared`);
  }
});

test('panda_commands explains a command from its registered metadata', () => {
  const text = pandaCommands({ command: '/add_reminder' });
  const cmd = commandDefs.find((c) => c.name === 'add_reminder');
  assert.ok(text.startsWith('/add_reminder <name> <repeat> <when> [timezone] — '));
  assert.ok(text.includes(cmd.description));
  for (const o of cmd.options) assert.ok(text.includes(o.description), o.name);
  assert.match(text, /repeat \(required, string, one of: once, daily \(every day\), weekly \(every week\), monthly \(every month\)\)/);
  assert.match(text, /timezone \(optional, string, suggestions appear as you type\)/);
  assert.match(text, /name \(required, string, up to 200 characters\)/);
  assert.match(text, /`add_reminder` tool/);

  assert.match(pandaCommands({ command: 'set_model' }), /Oscar \(the owner\) only/);
  assert.match(pandaCommands({ command: 'index_channel' }), /In chat: not available — /);
  assert.match(pandaCommands({ command: 'nope' }), /There is no \/nope command\. The commands are: \/menu, /);
});

test('panda_commands follows whatever is registered, not a copy', () => {
  const defsList = [{ name: 'fresh', description: 'A brand new command', options: [{ name: 'x', description: 'An x', type: 4, required: true, min_value: 1 }] }];
  assert.equal(pandaCommands({ command: 'fresh' }, null, { defsList }), '/fresh <x> — A brand new command\n• x (required, integer, min 1): An x');
  const all = pandaCommands({}, null);
  for (const c of commandDefs) assert.ok(all.includes(`/${c.name}`), c.name);
  assert.ok(all.includes(`${commandDefs.length}, read from the registered commands`));
});

test('current_model and the system prompt report the live model setting', async () => {
  const cfg = config();
  assert.match(currentModel({}, { config: cfg }), /Conversation model \(runtime setting\): vendor\/model-a\nProvider: OpenRouter default routing/);
  assert.ok(currentModel({}, { config: cfg }).includes(JEV_MODEL));
  // /set_model changes config at runtime; the answer follows it.
  cfg.model = 'other/model-b';
  cfg.modelProviders = { 'other/model-b': 'deepinfra' };
  assert.match(currentModel({}, { config: cfg }), /other\/model-b\nProvider: deepinfra/);
  const prompt = await buildSystemPrompt({ config: cfg, guild: null, message: { channel: {}, author: { id: '2', username: 'x' } } });
  assert.match(prompt, /You run on the OpenRouter model other\/model-b via the deepinfra provider/);
  assert.ok(!prompt.includes('model-a'));
});

test('owner-only tools refuse guests before running, and run for Oscar', async () => {
  let flips = 0;
  const privateMode = { on: false, isOn() { return this.on; }, async set(v) { flips++; this.on = v; return { ok: true, on: v }; } };
  const guest = chatInvocation({ privateMode });
  for (const [name, args] of [['private_mode', { state: 'on' }], ['set_model', { model: 'x/y' }], ['set_rule', { instruction: 'be rude' }], ['self_fix', { instruction: 'x' }]]) {
    assert.match(await executeTool(name, args, guest), /restricted to Oscar/, name);
  }
  assert.equal(flips, 0, 'nothing changed for the guest');
  assert.equal(privateMode.on, false);

  const owner = chatInvocation({ privateMode, isOwner: true });
  assert.equal(await executeTool('private_mode', { state: 'status' }, owner), 'Private mode is OFF.');
  assert.match(await executeTool('private_mode', { state: 'on' }, owner), /now ON/);
  assert.equal(privateMode.on, true);

  const failing = { isOn: () => false, set: async () => ({ ok: false, on: false, error: 'Could not save private mode: db down' }) };
  const reply = await executeTool('private_mode', { state: 'on' }, chatInvocation({ privateMode: failing, isOwner: true }));
  assert.match(reply, /Could not save private mode/);
  assert.match(reply, /still OFF/);
  assert.doesNotMatch(reply, /now ON/);
});

test('set_model goes through switchModel and never claims a failed switch', async () => {
  const cfg = config();
  const seen = [];
  const ok = await setModel({ model: 'a/b', provider: 'p' }, { config: cfg }, { switchImpl: async (a) => (seen.push(a), { ok: true, summary: 'switched' }) });
  assert.equal(ok, 'switched');
  assert.deepEqual(seen, [{ model: 'a/b', provider: 'p', config: cfg }]);
  const bad = await setModel({ model: 'zz' }, { config: cfg }, { switchImpl: async () => ({ ok: false, summary: '❌ OpenRouter doesn’t serve `zz`.' }) });
  assert.match(bad, /did not happen/);
});

test('arguments are checked against the tool schema before anything runs', () => {
  assert.match(validateArgs('add_reminder', { name: 'x', repeat: 'hourly', when: '10:00' }).error, /`repeat` must be one of once, daily, weekly, monthly/);
  assert.match(validateArgs('research', {}).error, /`query` is required/);
  assert.match(validateArgs('open_note', { title: '   ' }).error, /`title` is required/);
  assert.match(validateArgs('save_note', { minutes: 'lots' }).error, /`minutes` must be an integer/);
  assert.match(validateArgs('create_poll', { question: 'q', answers: { a: 1 } }).error, /`answers` must be an array/);
  assert.match(validateArgs('usage', 'x').error, /expected an object/);
  assert.deepEqual(validateArgs('save_note', { minutes: '60' }).args, { minutes: 60 });
  assert.deepEqual(validateArgs('fetch_history', { query: 'trip' }).args, { query: ['trip'] });
  assert.deepEqual(validateArgs('current_model', null).args, {});
});

test('invalid arguments, unknown tools and DB-less capabilities answer plainly', async () => {
  const inv = chatInvocation();
  assert.match(await executeTool('add_reminder', { name: 'x', repeat: 'hourly', when: '1' }, inv), /^Invalid arguments for add_reminder/);
  assert.equal(await executeTool('no_such_tool', {}, inv), 'Unknown tool: no_such_tool');
  assert.match(await executeTool('list_notes', {}, inv), /Notes are not set up/);
  assert.match(await executeTool('show_reminders', {}, inv), /Reminders are not set up/);
  assert.match(await executeTool('add_reminder', { name: 'x', repeat: 'daily', when: '10:00' }, inv), /^Not set: Reminders need DATABASE_URL/);
});

test('empty results say there is nothing, rather than leaving the model to fill the gap', async () => {
  await withDb(async () => ({ rows: [] }), async () => {
    const inv = chatInvocation({ config: { databaseUrl: 'postgres://test' } });
    assert.match(await executeTool('list_notes', {}, inv), /no saved notes yet/);
    assert.equal(await executeTool('show_reminders', {}, inv), 'There are no active reminders.');
    assert.match(await executeTool('delete_reminder', { reminder: 'gym' }, inv), /no active reminder matching "gym".*Nothing was deleted/);
  });
});

test('usage says so when OpenRouter is down instead of guessing', async () => {
  assert.match(await usage({}, { config: config() }, { lines: async () => null }), /spend is unknown/);
  assert.equal(await usage({}, { config: config() }, { lines: async () => ['**Today:** $1.0000'] }), '[SPEND, from OpenRouter]\nToday: $1.0000');
});

test('research runs the /research pipeline and renders its report', async () => {
  const seen = [];
  const text = await research({ query: 'q', depth: 'quick' }, { config: config() }, { run: async (a) => (seen.push(a.depth), { r: 1 }), render: () => 'REPORT' });
  assert.equal(text, 'REPORT');
  assert.deepEqual(seen, ['quick']);
});

test('delete_note only posts the confirmation, and only for the sender’s own note', async () => {
  const queries = [];
  const fake = async (_c, sql, params) => {
    queries.push({ sql, params });
    if (/^\s*delete/i.test(sql)) throw new Error('must not delete');
    return { rows: params[1] === '2' ? [{ id: 7, title: 'Trip plan' }] : [] };
  };
  await withDb(fake, async () => {
    const inv = chatInvocation({ config: { databaseUrl: 'postgres://test' } });
    assert.match(await executeTool('delete_note', { title: 'trip plan' }, inv), /NOT deleted yet/);
    assert.equal(inv.sent.length, 1);
    assert.match(inv.sent[0].content, /Delete the note \*\*Trip plan\*\*\?/);
    assert.equal(inv.sent[0].components[0].components[0].data.custom_id, 'notes:del:7');
    assert.equal(queries[0].params[1], '2', 'searched only the sender’s notes');
    assert.equal(inv.posted, true);

    const other = chatInvocation({ config: { databaseUrl: 'postgres://test' }, message: { ...inv.message, author: { id: '3', username: 'x' } } });
    assert.match(await executeTool('delete_note', { title: 'trip plan' }, other), /no note matching/);
    assert.equal(other.sent.length, 0);
  });
});

test('delete_reminder deletes one clear match, and asks when several match', async () => {
  const rows = [
    { id: '1', name: 'gym', active: true },
    { id: '2', name: 'gym bag', active: true },
  ];
  const deleted = [];
  const fake = async (_c, sql, params) => {
    if (/^\s*delete/i.test(sql)) {
      deleted.push(params);
      return { rows: rows.filter((r) => Number(r.id) === params[0]).map((r) => ({ name: r.name })) };
    }
    return { rows: rows.filter((r) => r.name.includes(params[2])) };
  };
  await withDb(fake, async () => {
    const inv = chatInvocation({ config: { databaseUrl: 'postgres://test' } });
    assert.equal(await executeTool('delete_reminder', { reminder: 'bag' }, inv), 'Deleted the reminder "gym bag".');
    assert.equal(await executeTool('delete_reminder', { reminder: 'gym' }, inv), 'Deleted the reminder "gym".');
    assert.deepEqual(deleted.at(-1), [1, '2', false], 'deleted as the sender, with no owner override');
    deleted.length = 0;
    rows.push({ id: '3', name: 'gym', active: true });
    assert.match(await executeTool('delete_reminder', { reminder: 'gym' }, inv), /Ask which one; nothing was deleted/);
    assert.equal(deleted.length, 0);
  });
});

// The conversation loop: Jev picks the tool, the model calls it, the answer is
// written from what the tool returned.
async function turn({ picks, calls, isOwner = false, cfg = config() }) {
  const sent = [];
  const invocation = {
    contextKey: 'g',
    config: { openrouterApiKey: 'k', ...cfg },
    message: { channel: { name: 'general' }, author: { id: isOwner ? OWNER : '2', username: 'someone' }, react: async () => {} },
    isOwner,
    reacted: false,
  };
  // Lookups open only once the model says it needs them (need_more_info).
  const lookups = calls.map(([name]) => name).filter(isLookup);
  const replies = [
    ...(lookups.length ? [{ content: '', tool_calls: [{ id: 'n', function: { name: 'need_more_info', arguments: JSON.stringify({ missing: 'x', tools: lookups }) } }] }] : []),
    { content: '', tool_calls: calls.map(([name, args], i) => ({ id: String(i), function: { name, arguments: args } })) },
    { content: 'answer' },
  ];
  const chat = async ({ messages }) => {
    sent.push(messages);
    return replies.shift() ?? { content: 'answer' };
  };
  const answers = { ...Object.fromEntries(picks.map((n) => [`use_${n}`, { noul: 0.9 }])), respond_with: { choice: 'message', probabilities: { message: 1 } } };
  const text = await runAgent(invocation, 'q', 'q', { chat, decideImpl: async () => answers });
  const toolResults = (sent.at(-1) || []).filter((m) => m.role === 'tool' && m.tool_call_id !== 'n').map((m) => m.content);
  return { text, toolResults, invocation };
}

test('asking which model: the tool result carries the live setting into the answer', async () => {
  const { text, toolResults } = await turn({ picks: ['current_model'], calls: [['current_model', '{}']], cfg: config({ model: 'live/model-z' }) });
  assert.equal(text, 'answer');
  assert.match(toolResults[0], /live\/model-z/);
});

test('several tool calls run in one round, and bad JSON or bad args never run a tool', async () => {
  const { toolResults, invocation } = await turn({
    picks: ['panda_commands', 'add_reminder'],
    calls: [['panda_commands', '{"command":"play"}'], ['add_reminder', '{not json'], ['add_reminder', '{"name":"x","repeat":"yearly","when":"1"}']],
  });
  assert.deepEqual(invocation.toolsUsed, ['panda_commands', 'add_reminder', 'add_reminder']);
  assert.match(toolResults[0], /^\/play <query> — /);
  assert.match(toolResults[1], /^Invalid arguments for add_reminder: not valid JSON/);
  assert.match(toolResults[2], /^Invalid arguments for add_reminder: `repeat` must be one of/);
});

test('a guest whose turn needs an owner-only tool is refused before the model runs', async () => {
  const { text } = await turn({ picks: ['set_model'], calls: [['set_model', '{"model":"a/b"}']] });
  assert.equal(text, 'Only Oscar can use `set_model`.');
});

test('every lookup tool exists, and none of them does anything or is Oscar-only', async () => {
  const names = new Set((await toolDefs({ isOwner: true, config: config() })).map((t) => t.function.name));
  for (const name of LOOKUP_TOOLS) {
    assert.ok(names.has(name), `${name} is a tool`);
    assert.ok(!OWNER_ONLY_TOOLS.has(name), `${name} is a read anyone may use`);
  }
  for (const action of ['react', 'create_poll', 'add_reminder', 'play_music', 'self_fix', 'save_note']) assert.equal(isLookup(action), false, action);
});

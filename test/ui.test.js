import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoll, sendCard, clickAsMessage, UI_PREFIX } from '../src/agent/tools/ui.js';
import { createInteractionHandler } from '../src/discord/commands.js';
import { createMessageHandler } from '../src/discord/messageHandler.js';
import { runAgent } from '../src/agent/agent.js';
import { config as botConfig } from '../src/config.js';

// A channel that records what is sent to it, or fails like Discord would.
function channel({ fail = null } = {}) {
  const sent = [];
  return {
    sent,
    send: async (payload) => {
      if (fail) throw new Error(fail);
      sent.push(payload);
      return { id: 'm1', ...payload };
    },
  };
}
const inv = (ch) => ({ message: { channel: ch }, posted: false });

test('create_poll posts a native poll and counts as a response', async () => {
  const ch = channel();
  const invocation = inv(ch);
  const out = await createPoll({ question: 'Lunch?', answers: ['Pizza', ' Sushi ', ''], hours: 9999, multiple: true }, invocation);
  assert.match(out, /Poll posted/);
  assert.deepEqual(ch.sent[0].poll, {
    question: { text: 'Lunch?' },
    answers: [{ text: 'Pizza' }, { text: 'Sushi' }],
    duration: 768,
    allowMultiselect: true,
  });
  assert.equal(invocation.posted, true);
});

test('create_poll refuses bad input and passes Discord errors back', async () => {
  const ch = channel();
  assert.match(await createPoll({ question: 'Lunch?', answers: ['only one'] }, inv(ch)), /2 to 10 answers/);
  assert.match(await createPoll({ question: '', answers: ['a', 'b'] }, inv(ch)), /2 to 10 answers/);
  assert.equal(ch.sent.length, 0);
  const missing = inv(channel({ fail: 'Missing Permissions' }));
  assert.match(await createPoll({ question: 'Q', answers: ['a', 'b'] }, missing), /rejected the poll: Missing Permissions/);
  assert.equal(missing.posted, false);
});

test('send_card posts an embed with link buttons, clickable buttons and a dropdown', async () => {
  const ch = channel();
  const invocation = inv(ch);
  const out = await sendCard(
    {
      title: 'Ramen near you',
      description: 'Three picks',
      color: '#5865F2',
      fields: [{ name: 'Best', value: 'Kinton', inline: true }],
      buttons: [{ label: 'Map', url: 'https://maps.example.com' }, { label: 'More like this' }],
      menu: { placeholder: 'Pick one', options: ['Kinton', 'Sansotei'] },
    },
    invocation,
  );
  assert.match(out, /Card posted\. A click will come back/);
  const { embeds, components } = ch.sent[0];
  assert.equal(embeds[0].title, 'Ramen near you');
  assert.equal(embeds[0].color, 0x5865f2);
  assert.deepEqual(embeds[0].fields, [{ name: 'Best', value: 'Kinton', inline: true }]);
  const [link, click] = components[0].components;
  assert.equal(link.url, 'https://maps.example.com');
  assert.equal(click.custom_id, `${UI_PREFIX}b1`);
  const menu = components[1].components[0];
  assert.equal(menu.custom_id, `${UI_PREFIX}menu`);
  assert.deepEqual(menu.options.map((o) => [o.label, o.value]), [['Kinton', '0'], ['Sansotei', '1']]);
  assert.equal(invocation.posted, true);
});

test('send_card refuses what Discord would reject, before sending anything', async () => {
  const ch = channel();
  assert.match(await sendCard({}, inv(ch)), /needs a title/);
  assert.match(await sendCard({ title: 't', buttons: [{ label: 'x', url: 'javascript:alert(1)' }] }, inv(ch)), /http\(s\) url/);
  assert.match(await sendCard({ title: 't', buttons: Array.from({ length: 6 }, (_, i) => ({ label: `b${i}` })) }, inv(ch)), /at most 5/);
  assert.match(await sendCard({ title: 't', menu: { options: ['one'] } }, inv(ch)), /2 to 25 choices/);
  assert.match(await sendCard({ title: 'x'.repeat(300) }, inv(ch)), /rejected the card/);
  assert.equal(ch.sent.length, 0);
});

test('a card and a poll never carry the bot\'s secrets', async () => {
  const saved = botConfig.openrouterApiKey;
  botConfig.openrouterApiKey = 'sk-or-v1-secretvalue';
  try {
    const ch = channel();
    await sendCard({ title: 'key', description: 'it is sk-or-v1-secretvalue' }, inv(ch));
    await createPoll({ question: 'sk-or-v1-secretvalue?', answers: ['a', 'b'] }, inv(ch));
    assert.ok(!JSON.stringify(ch.sent).includes('sk-or-v1-secretvalue'));
    assert.match(JSON.stringify(ch.sent), /\[redacted\]/);
  } finally {
    botConfig.openrouterApiKey = saved;
  }
});

test('posting a card and saying nothing more sends no placeholder text', async () => {
  const ch = channel();
  const invocation = {
    contextKey: 'g',
    config: { openrouterApiKey: 'k', botName: 'Panda', model: 'm', ownerId: '1' },
    message: { channel: Object.assign(ch, { name: 'general' }), author: { id: '2', username: 'someone' } },
    isOwner: false,
  };
  const replies = [
    { content: '', tool_calls: [{ id: 't', function: { name: 'send_card', arguments: JSON.stringify({ title: 'Hi' }) } }] },
    { content: '' },
    { content: '' },
  ];
  assert.equal(await runAgent(invocation, 'q', 'q', { chat: async () => replies.shift(), decideImpl: async () => ({ use_send_card: { noul: 0.9 } }) }), '');
  assert.equal(ch.sent.length, 1);
});

// --- clicks ------------------------------------------------------------------

const card = { id: '555', author: { id: 'bot', username: 'Panda' }, content: '', embeds: [{ title: 'Ramen near you' }], reacted: [], react(e) { this.reacted.push(e); } };
function click({ menu = false, customId = menu ? 'ui:menu' : 'ui:b1', user = { id: '2', username: 'someone', displayName: 'Someone' } } = {}) {
  const calls = [];
  return {
    calls,
    id: '777',
    customId,
    channelId: 'c1',
    channel: { id: 'c1', name: 'general', sendTyping: async () => {}, send: async (p) => (calls.push(['send', p]), { id: 's1', ...p }) },
    guild: { id: 'g1', name: 'Guild' },
    guildId: 'g1',
    member: { displayName: user.displayName },
    user,
    createdTimestamp: Date.now(),
    message: card,
    values: menu ? ['1'] : undefined,
    component: menu ? { options: [{ label: 'Kinton', value: '0' }, { label: 'Sansotei', value: '1' }] } : { label: 'More like this' },
    isButton: () => !menu,
    isStringSelectMenu: () => menu,
    deferUpdate: async () => calls.push(['deferUpdate']),
    followUp: async (p) => (calls.push(['followUp', p]), { id: 'f1', content: p.content }),
  };
}

test('a click becomes a message from the clicker, replying to the card', async () => {
  const msg = clickAsMessage(click());
  assert.equal(msg.content, '[clicked "More like this"]');
  assert.equal(msg.author.id, '2');
  assert.equal(await msg.fetchReference(), card);
  assert.equal(clickAsMessage(click({ menu: true })).content, '[clicked "Sansotei"]');
});

test('only Panda\'s own buttons and menus are routed, acknowledged before the turn starts', async () => {
  const routed = [];
  const handler = createInteractionHandler({ client: {}, config: { ownerId: '1' }, onMessage: async (m) => routed.push(m) });
  const ui = click();
  await handler(ui);
  assert.deepEqual(ui.calls[0], ['deferUpdate']);
  assert.equal(routed[0].content, '[clicked "More like this"]');

  const other = click({ customId: 'something-else' });
  await handler(Object.assign(other, { isButton: () => false, isStringSelectMenu: () => false, isAutocomplete: () => false, isChatInputCommand: () => false }));
  assert.equal(routed.length, 1);
  assert.equal(other.calls.length, 0);
});

test('a click runs through the real message handler as a direct turn from the clicker', async () => {
  const seen = [];
  const handler = createMessageHandler({
    client: { user: { id: 'bot' } },
    config: { ownerId: '2', allowBots: false, dmEnabled: true },
    player: null,
    privateMode: { isOn: () => false },
    runAgentImpl: async (invocation, userContent, turnText) => {
      seen.push({ invocation, userContent, turnText });
      return 'Here are three more.';
    },
  });
  const ui = click();
  // What was said before the click, newest first as Discord pages it.
  const earlier = [
    { id: '776', author: { id: 'bot', username: 'Panda' }, content: 'Here are some ramen spots.' },
    { id: '775', author: { id: '3', username: 'rice' }, content: 'any ramen near here?' },
  ];
  const page = Object.assign(new Map(earlier.map((m) => [m.id, m])), { last: () => earlier.at(-1) });
  ui.channel.messages = { fetch: async ({ before }) => (before === '777' ? page : new Map()) };
  await handler(clickAsMessage(ui));
  for (let i = 0; i < 50 && !ui.calls.some(([k]) => k === 'followUp'); i++) await new Promise((r) => setTimeout(r, 100));

  const [{ invocation, userContent, turnText }] = seen;
  const recent = 'rice (@rice, id:3): any ramen near here?\n(you) Panda (@Panda, id:bot): Here are some ramen spots.';
  assert.equal(invocation.recent, recent, 'the messages just before the turn come with it, oldest first');
  assert.ok(userContent.startsWith('[RECENT MESSAGES') && userContent.includes(recent));
  assert.ok(!turnText.includes('ramen spots'), 'Jev gets them separately from the turn');
  assert.equal(invocation.isOwner, true, 'owner checks use the clicker, not the card');
  assert.ok(userContent.includes('Someone pinged you'), 'a click on Panda\'s card is a direct turn');
  assert.match(turnText, /Someone \(@someone, id:2\) \(replying to message 555 from @Panda \(id:bot\): "Ramen near you"\): \[clicked "More like this"\]/);
  assert.deepEqual(ui.calls.find(([k]) => k === 'followUp')[1].content, 'Here are three more.');
});

test('the reply starts with the tools the turn used, and has no line when it used none', async () => {
  for (const [toolsUsed, expected] of [
    [['web_search', 'web_search', 'send_card'], '-# 🔧 web_search ×2 · send_card\nHere you go.'],
    [[], 'Here you go.'],
  ]) {
    const handler = createMessageHandler({
      client: { user: { id: 'bot' } },
      config: { ownerId: '1', allowBots: false, dmEnabled: true },
      player: null,
      privateMode: { isOn: () => false },
      runAgentImpl: async (invocation) => {
        invocation.toolsUsed.push(...toolsUsed);
        return 'Here you go.';
      },
    });
    const ui = click();
    await handler(clickAsMessage(ui));
    for (let i = 0; i < 50 && !ui.calls.some(([k]) => k === 'followUp'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(ui.calls.find(([k]) => k === 'followUp')[1].content, expected);
  }
});

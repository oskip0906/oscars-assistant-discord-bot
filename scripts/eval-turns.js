// Live turn evaluation: real model and Jev through runAgent, no Discord.
//
//   node scripts/eval-turns.js [--runs 5] [--cases photo,receipt] [--json out.json]
//
// Needs OPENROUTER_API_KEY (.env). Uses config.model, or EVAL_MODEL. The persona
// (identity.md, soul.md) is only loaded when DATABASE_URL is set; tools run for
// real, so web_search needs SearXNG at SEARXNG_URL or it reports a failure.
//
// Each case is one ping from a guest, composed as messageHandler does (recent
// messages, the turn, labeled attachments), and checked for what matters: an
// image or chat answered in one model call with no tools, a live fact looked
// up. The model calls go through this script's own OpenRouter call (the payload
// runAgent builds, unchanged), so token counts are measured the same way on any
// version of the bot. Prints per-case median / p95 latency, model calls, prompt
// tokens and pass rate. Answers are judged by a loose keyword check only.
import { runAgent } from '../src/agent/agent.js';
import { attachmentParts } from '../src/discord/attachments.js';
import { modelInputs } from '../src/discord/model.js';
import { config } from '../src/config.js';

const commons = (path) => `https://upload.wikimedia.org/wikipedia/commons/${path}`;
const image = (name, url, size = 300_000) => ({ id: name, name, contentType: name.endsWith('.png') ? 'image/png' : 'image/jpeg', size, url, sender: 'Rice (@rice)' });
const LIVE_TOOLS = ['web_search', 'news_search', 'web_fetch', 'wiki_search'];
// Answer first: a turn that looks something up spends one call saying so (need_more_info).

const CASES = {
  photo: {
    text: 'what animal is this and what is it standing on?',
    attachments: [image('cat.jpg', commons('thumb/b/b6/Felis_catus-cat_on_snow.jpg/1280px-Felis_catus-cat_on_snow.jpg'))],
    expect: { maxCalls: 1, tools: 0, answer: /cat/i },
  },
  screenshot: {
    text: 'what does this screenshot say went wrong?',
    attachments: [image('error.png', commons('5/5c/Firefox_screenshot-404_error_in_Wikipedia.png'))],
    expect: { maxCalls: 1, tools: 0, answer: /404|not (be )?found|doesn.t exist|does not exist|no page/i },
  },
  skyline: {
    text: 'which city is this?',
    attachments: [image('skyline.jpg', commons('thumb/1/12/Toronto_-_ON_-_Skyline10.jpg/1280px-Toronto_-_ON_-_Skyline10.jpg'))],
    expect: { maxCalls: 1, tools: 0, answer: /toronto/i },
  },
  receipt: {
    text: 'whats the total on this receipt?',
    attachments: [image('receipt.jpg', commons('thumb/b/b3/Sahan_Supermarket_receipt%2C_Hillegersberg%2C_Rotterdam_%282021%29_02.jpg/1280px-Sahan_Supermarket_receipt%2C_Hillegersberg%2C_Rotterdam_%282021%29_02.jpg'))],
    expect: { maxCalls: 1, tools: 0, answer: /\d+[.,]\d{2}/ },
  },
  'live-fact': {
    text: "what's the price of bitcoin in USD right now?",
    expect: { live: true },
  },
  chat: {
    text: 'what time is the party again?',
    recent: "Ana (@ana, id:3): party's at 7pm at my place saturday, bring snacks\nRice (@rice, id:2): bet",
    expect: { maxCalls: 1, tools: 0, answer: /7/ },
  },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const runs = Number(arg('runs', 5));
const cases = arg('cases', Object.keys(CASES).join(',')).split(',');
const model = process.env.EVAL_MODEL || config.model;

// runAgent's model call, made here so usage is read the same way on every version.
async function chat({ apiKey, model: id, messages, tools, toolChoice }) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: id, messages, ...(tools?.length ? { tools, tool_choice: toolChoice } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (data.error || !data.choices?.[0]?.message) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return { ...data.choices[0].message, usage: data.usage };
}

async function runCase(name, spec) {
  const usage = { calls: 0, prompt: 0, firstTools: null };
  const counted = async (req) => {
    const msg = await chat(req);
    usage.calls++;
    usage.prompt += msg.usage?.prompt_tokens ?? 0;
    usage.firstTools ??= req.tools?.length ?? 0;
    return msg;
  };
  const invocation = {
    config: { ...config, model },
    contextKey: `eval:${name}`,
    message: { id: `eval-${name}-${Math.random()}`, channel: { name: 'eval', send: async () => ({}) }, author: { id: '2', username: 'rice', displayName: 'Rice' }, react: async () => {} },
    guild: null,
    client: { user: { id: 'bot', username: 'Panda' } },
    isOwner: false,
    direct: true,
    privateMode: { isOn: () => false },
    recent: spec.recent ?? '',
    reacted: false,
    posted: false,
    toolsUsed: [],
    embeds: [],
    // The links behind the [ATTACHMENTS] numbers, as messageHandler sets them.
    attachmentUrls: (spec.attachments ?? []).map((a) => a.url),
  };
  const turn = `Rice (@rice, id:2): @Panda (id:bot) ${spec.text}`;
  const combined = [
    ...(spec.recent ? ['[RECENT MESSAGES — the messages just before the turn, oldest first. Supporting background only.]', spec.recent, ''] : []),
    '[RESPOND TO THIS — Rice pinged you. This matters most: it is your actual task. Answer what is actually said here.]',
    turn,
  ].join('\n');
  const start = Date.now();
  const media = spec.attachments ? await attachmentParts(spec.attachments, await modelInputs(invocation.config)) : [];
  const reply = await runAgent(invocation, media.length ? [{ type: 'text', text: combined }, ...media] : combined, turn, { chat: counted });
  const ms = Date.now() - start;
  const tools = invocation.toolsUsed.filter((t) => t !== 'react');
  const e = spec.expect;
  const pass = e.live
    ? tools.some((t) => LIVE_TOOLS.includes(t))
    : usage.calls <= e.maxCalls && tools.length === e.tools && e.answer.test(reply);
  return { ms, calls: usage.calls, prompt: usage.prompt, firstTools: usage.firstTools, tools, pass, reply: String(reply).slice(0, 160) };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

if (!config.openrouterApiKey) {
  console.error('OPENROUTER_API_KEY is not set.');
  process.exit(1);
}
console.log(`model ${model}, ${runs} run(s) per case\n`);
const results = {};
for (const name of cases) {
  results[name] = [];
  for (let i = 0; i < runs; i++) {
    try {
      results[name].push(await runCase(name, CASES[name]));
    } catch (err) {
      results[name].push({ error: String(err.message || err).slice(0, 200), pass: false });
    }
    const r = results[name].at(-1);
    console.log(`${name} #${i + 1}: ${r.error ? `ERROR ${r.error}` : `${r.pass ? 'pass' : 'FAIL'} ${r.ms}ms, ${r.calls} call(s), ${r.prompt} prompt tokens, ${r.firstTools} tools offered, used [${r.tools}] → ${r.reply.replace(/\s+/g, ' ')}`}`);
  }
}

console.log('\ncase        pass   median ms   p95 ms   calls   prompt tok   tools offered   tool rate');
for (const [name, rs] of Object.entries(results)) {
  const ok = rs.filter((r) => !r.error);
  const avg = (key) => (ok.length ? (ok.reduce((s, r) => s + r[key], 0) / ok.length).toFixed(1) : '-');
  console.log(
    [
      name.padEnd(11),
      `${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(6),
      String(ok.length ? pct(ok.map((r) => r.ms), 50) : '-').padStart(9),
      String(ok.length ? pct(ok.map((r) => r.ms), 95) : '-').padStart(8),
      avg('calls').padStart(7),
      avg('prompt').padStart(12),
      avg('firstTools').padStart(15),
      `${ok.filter((r) => r.tools.length).length}/${ok.length}`.padStart(11),
    ].join('  '),
  );
}
const out = arg('json');
if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify({ model, runs, results }, null, 2));

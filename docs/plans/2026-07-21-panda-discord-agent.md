# Panda Discord Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A from-scratch Discord AI agent ("Panda") — not OpenClaw — that chats via OpenRouter tool-calling with per-server memory, plays music, searches web/images, reads Oscar's GitHub vault, drives Claude Code on the host, and can fix its own source.

**Architecture:** A single Node.js (ESM) process built on discord.js v14. Inbound mentions/replies/DMs are wrapped in a sender-attributed envelope and fed to an OpenRouter chat-completions tool-calling loop; each "skill" is an OpenAI-format tool with a local executor that receives the live Discord invocation (message, guild, member, player). Context is a per-guild JSON transcript on disk. Music is discord-player v7 (youtubei extractor), driven both by slash commands and by the AI `play_music` tool. `prompt_claude`/`self_fix` shell out to the host `claude` CLI with `--dangerously-skip-permissions`; a `run.sh` supervisor loop restarts the process on exit code 42 so `self_fix` changes go live.

**Tech Stack:** Node ≥ 20 (host has v24.18), discord.js ^14, discord-player ^7 + @discord-player/extractor + discord-player-youtubei + mediaplex + ffmpeg-static, duck-duck-scrape (web + image search, no API key), dotenv. OpenRouter and GitHub are called with plain `fetch` (Node global).

## Global Constraints

- Project root: `/Users/oscarpang/panda-bot` (outside `~/openclaw-docker`, per spec).
- ESM everywhere (`"type": "module"`); no build step; no TypeScript.
- Secrets live only in `.env` (mode 600, gitignored). Never log or reply with secret values. `.env` is copied from openclaw config: Discord bot token (`channels.discord.token`), GitHub fine-grained PAT (`state/secrets/github-vault.token`), OpenRouter key.
- Owner: Oscar — Discord `oskip123`, id `767525911695851550`. `prompt_claude`, `self_fix`, `clear_all_context` are owner-only at the executor level (not just prompt level).
- Context separation is **per server** (guild id), not per channel. DMs use `dm:<userId>` keys.
- Bot identity: **Panda 🐼** (from openclaw workspace `IDENTITY.md`). Persona files loaded from `context/` into the system prompt: `IDENTITY.md`, `SOUL.md`, `USER.md`, plus `context/memory/*.md` (capped). `AGENTS.md`/`TOOLS.md` are kept on disk for reference but NOT loaded (openclaw-specific mechanics would mislead the model).
- Every model-visible inbound line carries the sender's numeric id inline (`Name (@username, id:NNN)`), and inbound `<@NNN>` mentions are rewritten `@Name (id:NNN)` — conventions proven on the openclaw box (bots guessed/hallucinated ids without them).
- Discord replies ≤ 2000 chars per message → chunk on newline boundaries; `allowedMentions: { parse: ['users'] }` (never everyone/roles).
- Default model: `anthropic/claude-sonnet-4.5` via OpenRouter (env-overridable). Tool loop cap: `MAX_TOOL_ITERATIONS` (default 12).

## Environment (.env)

| Var | Value/Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | (copied) | Bot gateway token — same bot account as openclaw's Panda |
| `OPENROUTER_API_KEY` | (copied) | LLM access |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4.5` | tool-calling model |
| `OWNER_DISCORD_ID` | `767525911695851550` | gates power tools |
| `GITHUB_PAT` | (copied) | vault_fetch + github_api |
| `VAULT_REPO` | `oskip0906/oskip-vault` | Oscar's vault repo |
| `CLAUDE_BIN` | `/opt/homebrew/bin/claude` | claude CLI path |
| `BOT_NAME` | `Panda` | display name |
| `ALLOW_BOTS` | `true` | other bots may trigger Panda (rate-limited) |
| `DM_ENABLED` | `true` | respond in DMs |
| `MAX_TOOL_ITERATIONS` | `12` | agent loop cap |
| `BRAVE_API_KEY` | empty | optional better web search; DDG fallback |

## File Structure

```
panda-bot/
├── package.json            ESM, start/test scripts
├── .env                    secrets (600, gitignored)
├── .env.example            placeholders
├── .gitignore              .env, data/, node_modules/
├── run.sh                  supervisor: restart on exit 42 (self_fix), 3s backoff on crash
├── README.md               setup, commands, skills, caveats (openclaw must be stopped)
├── context/                persona + memory md copied from openclaw workspace
├── data/context/           per-guild transcripts <guildId>.json (runtime)
├── docs/plans/             this plan
├── src/
│   ├── index.js            boot: config→client(+intent fallback)→player→handlers→login
│   ├── config.js           env load/validate, paths
│   ├── agent/
│   │   ├── openrouter.js   chatCompletion() with retry on 429/5xx
│   │   ├── agent.js        runAgent() tool loop
│   │   ├── contextStore.js ContextStore class + trimToBoundary()
│   │   ├── systemPrompt.js buildSystemPrompt() from context/ md files
│   │   └── tools/
│   │       ├── index.js    toolDefs() + executeTool() dispatch + owner gating
│   │       ├── discord.js  get_user_id, get_message_sender
│   │       ├── search.js   web_search (Brave→DDG), image_search (DDG images)
│   │       ├── github.js   vault_fetch, github_api
│   │       ├── context.js  clear_context, clear_all_context
│   │       ├── claude.js   runClaude(), prompt_claude, self_fix
│   │       └── music.js    play_music AI tool (wraps music/actions.js)
│   ├── discord/
│   │   ├── messageHandler.js  trigger detect, envelope, typing, chunked reply, restart hook
│   │   ├── envelope.js        formatEnvelope() (exported for tests)
│   │   ├── chunk.js           chunkMessage() (exported for tests)
│   │   ├── commands.js        slash defs + interaction dispatch
│   │   └── menu.js            /menu rich embed (Egg-Man style)
│   └── music/
│       ├── player.js       createPlayer(): discord-player + extractors + events
│       └── actions.js      playQuery/skip/pause/resume/stop/queueInfo helpers
└── test/
    ├── contextStore.test.js
    ├── chunk.test.js
    └── envelope.test.js
```

---

### Task 1: Scaffold + secrets + context files

**Files:** Create tree above; write `.env` (extract Discord token via `jq` from `state/openclaw.json`, PAT from `state/secrets/github-vault.token`, OpenRouter key recovered from the openclaw agent sqlite — plaintext `sk-or-v1-…` strings); copy `IDENTITY/SOUL/USER/AGENTS/TOOLS.md` + `memory/*.md` into `context/`; `git init`; `npm install discord.js discord-player @discord-player/extractor discord-player-youtubei mediaplex ffmpeg-static duck-duck-scrape dotenv sodium-native`.

- [x] Steps executed via shell (values never echoed; only lengths printed: token=72, pat=93, key=73).

### Task 2: config.js

**Produces:** `config` object `{ discordToken, openrouterApiKey, model, ownerId, githubPat, vaultRepo, claudeBin, botName, allowBots, dmEnabled, maxToolIterations, braveApiKey, projectRoot, dataDir, contextDir, contextFilesDir }`. Throws at boot on missing `DISCORD_TOKEN`/`OPENROUTER_API_KEY`.

### Task 3: contextStore.js (+ tests)

**Produces:**
```js
export class ContextStore {
  constructor(dir)
  get(key): Message[]            // lazy-load from <dir>/<sanitized key>.json
  append(key, msgs): void        // concat, trimToBoundary(60), persist
  clear(key): void               // wipe one server
  clearAll(): void               // wipe every stored context
}
export function trimToBoundary(arr, max) // trim front to a role:'user' boundary so
                                         // assistant tool_calls never lose their tool results
```
**Test:** `test/contextStore.test.js` — append+get roundtrip via tmp dir; trim keeps ≤max and starts on `user`; clear/clearAll remove files.

### Task 4: openrouter.js + agent.js

**Produces:**
```js
// openrouter.js
export async function chatCompletion({ apiKey, model, messages, tools }) // → assistant message
// retries 429/5xx x3 with backoff; throws Error with OpenRouter error message otherwise

// agent.js
export async function runAgent(invocation, userContent) // → final reply text
```
`invocation = { message, guild, member, client, player, contextStore, config, contextKey, isOwner, contextCleared:false, requestRestart:false }` — built by messageHandler, threaded into every tool executor.

Loop: system + stored history + new user msg → chatCompletion(tools) → if `tool_calls`: execute each sequentially, push `role:'tool'` results (truncated 12k), repeat (cap `maxToolIterations`) → final text. Persist `[user, ...assistant/tool…, assistant]` unless `invocation.contextCleared`.

### Task 5: systemPrompt.js

Builds: Panda identity/personality; "you live on Discord" formatting rules (Discord markdown, `<@id>` to ping, never raw `(id:NNN)` echoes, ≤2000 chars, no @everyone); skill guidance (music requests → `play_music`; image requests → `image_search`; questions about Oscar → `vault_fetch` FIRST, never from memory — porting TOOLS.md's non-negotiable; web facts → `web_search` and include links; owner-only tool list); appended persona files (`IDENTITY.md`, `SOUL.md`, `USER.md` full; `memory/*.md` capped 6k each / 20k total) with a note that legacy openclaw paths in them are historical.

### Task 6: tools (defs + executors)

`tools/index.js` produces OpenAI-format defs and `executeTool(name, args, invocation)`; unknown tool → error string; owner-only set `{prompt_claude, self_fix, clear_all_context}` returns a refusal string for non-owners.

| Tool | Args | Executor behavior |
|---|---|---|
| `get_user_id` | `name` | `guild.members.search({query,limit:10})` REST; fallback cache scan (users+bots, username/displayName substring); returns `id`, `username`, `displayName`, `bot` per match + "ping with <@id>" |
| `get_message_sender` | — | current envelope sender: id/username/displayName/isOwner (also always inline in the envelope) |
| `web_search` | `query`, `count≤8` | Brave API if key else `duck-duck-scrape` `search()`; returns numbered title/url/snippet lines; model instructed to cite links |
| `image_search` | `query`, `count≤5` | `duck-duck-scrape` `searchImages()`; returns direct image URLs (Discord auto-embeds) |
| `vault_fetch` | `path?`, `query?` | GitHub contents API on `VAULT_REPO`: no args→root listing; dir→listing; file→decoded content (8k cap); `query`→recursive tree filter → matching paths |
| `github_api` | `method`, `endpoint`, `body?` | authenticated `fetch` to `api.github.com` as oskip0906; JSON result truncated 6k; general-purpose GitHub integration |
| `clear_context` | — | `contextStore.clear(contextKey)`; sets `invocation.contextCleared` so the in-flight exchange is not re-persisted |
| `clear_all_context` | — | owner-only; `contextStore.clearAll()` |
| `prompt_claude` | `prompt`, `directory?` | owner-only; posts "🔧 working" to channel; `execFile(claudeBin, ['-p',prompt,'--dangerously-skip-permissions','--output-format','text'])`, cwd=directory\|\|$HOME, 10-min timeout, 32MB buffer, PATH prepended with /opt/homebrew/bin; resolves (never rejects) with output tail ≤6k |
| `self_fix` | `instruction` | owner-only; `prompt_claude` with cwd=projectRoot and a wrapper prompt (don't touch .env/data, `node --check` changed files, keep bootable); sets `invocation.requestRestart` → handler exits 42 after replying; run.sh restarts with new code |
| `play_music` | `action: play\|skip\|pause\|resume\|stop\|queue\|nowplaying`, `query?` | wraps `music/actions.js` with the invoking member's voice channel; friendly status strings ("not in a voice channel", "Queued: …") |
| `react` | `emoji` | `message.react(emoji)` on the current message; sets `invocation.reacted`. Model may then return empty text (reaction-only). |

### Private mode + reactions (added post-plan)

- `src/privateMode.js` — `PrivateMode` class over a plain-text flag file `data/private-mode.flag` (`ON`/`OFF`, survives restarts/self-fix) + exported `PRIVATE_MESSAGE = "I am in a private conversation with Oscar right now."`.
- `messageHandler.js` — when `privateMode.isOn()` and sender ≠ owner: reply with the hardcoded `PRIVATE_MESSAGE` (bots get silence, no reply) and **return before any model call**. Owner is unaffected. `invocation.reacted` lets a reaction-only turn send no message.
- `commands.js` — `/private on|off|status` (owner-only in code); private mode also blocks non-owner slash interactions with an ephemeral `PRIVATE_MESSAGE` (except `/private` itself).
- `agent.js` — final response may be empty string when the model already reacted; handler sends nothing in that case.
- `systemPrompt.js` — "React, reply, or both" guidance + a private-mode banner when it's on.

### Task 7: music/player.js + actions.js

`createPlayer(client)`: `new Player(client)` → `loadMulti(DefaultExtractors)` → `register(YoutubeiExtractor)`; events `playerStart`/`emptyQueue` post to `queue.metadata.channel`; error events logged, never crash. `actions.js` helpers shared by slash + AI tool: `playQuery(player, voiceChannel, textChannel, query, requestedBy)` (nodeOptions: volume 60, leaveOnEmpty/End with cooldowns), `skip/pause/resume/stop/queueInfo(player, guildId)`.

### Task 8: discord layer

- `envelope.js` — `formatEnvelope(message)`: `Display (@username, id:NNN)[ replying to @X (id:MMM): "quote≤180"]: content` with `<@NNN>` rewritten `@Name (id:NNN)`, attachments appended as `[attachment: name url]`.
- `chunk.js` — `chunkMessage(text, 2000)` split on newline else hard split; drops empty chunks.
- `messageHandler.js` — trigger = mention OR reply-to-bot OR DM (if enabled); ignores own messages; bot senders allowed but rate-limited (≥20s gap per channel between bot-triggered replies — loop protection); typing indicator every 8s; runAgent; chunked reply; on `requestRestart` → flush + `process.exit(42)` after 1.5s.
- `commands.js` — slash defs `/menu /play /skip /pause /resume /stop /queue /clear /clearall`; registered per-guild on ready + guildCreate (instant, no global propagation delay); music handlers defer then act; `/clear` clears guild context; `/clearall` owner-check.
- `menu.js` — Egg-Man-styled `EmbedBuilder`: violet accent, "Hello my friend! 🐼" title, bot avatar thumbnail, bold category fields with inline-code command names (Music / AI skills / Context / Owner power tools), footer.
- `index.js` — build client with intents `[Guilds, GuildMessages, MessageContent, GuildVoiceStates, DirectMessages, GuildMembers]` + `Partials.Channel`; if login throws "disallowed intents", rebuild without `GuildMembers` and warn (member search degrades to cache); wire player, handlers, SIGINT/SIGTERM graceful shutdown.
- `run.sh` — `while :; do node src/index.js; code=$?; [ 0 ] break; [ 42 ] continue (self-fix restart); else sleep 3; done`.

### Task 9: Verification

- [ ] `npm test` — 3 suites pass.
- [ ] `node --check` every `src/**/*.js`.
- [ ] Smoke: launch for ~20s → expect "Logged in as …" + "Registered N slash commands in M guilds" → SIGTERM.
- [ ] Ultracode adversarial review Workflow (correctness / discord-api / security lenses, refute-style verification) → fix confirmed findings → re-run tests.

### Known caveats (documented in README)

1. Same bot token as the running openclaw container → both answer while both run; **stop openclaw** (`docker compose -f ~/openclaw-docker/docker-compose.yml stop`) before running Panda for real.
2. Guild slash registration replaces openclaw's deployed commands for the app; openclaw's `command-deploy-cache.json` may need clearing if reverting.
3. `GuildMembers` is a privileged intent — enable "Server Members Intent" in the Developer Portal for full `get_user_id`; bot works without it (fallback).
4. YouTube streaming via youtubei breaks periodically upstream — that's what `self_fix` is for.

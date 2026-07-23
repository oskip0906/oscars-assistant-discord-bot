# panda-bot 🐼

Oscar's Discord AI agent, rebuilt **fully from scratch** (no OpenClaw). Plain Node.js +
discord.js v14 + an OpenRouter tool-calling loop. Persona and memories carried over from
the openclaw workspace (`context/`).

## Search backend (SearXNG — no rate limits)

Web/image search runs against a private, self-hosted [SearXNG](https://github.com/searxng/searxng)
metasearch instance in `searxng/` (Docker, bound to `127.0.0.1:8888`, bot-limiter
disabled → no external rate limits). Start it once and it stays up:

```bash
cd searxng
cp config/settings.example.yml config/settings.yml   # first time: create local config
# then set a real secret_key: openssl rand -hex 32  →  paste into config/settings.yml
docker compose up -d      # start the search backend
docker compose logs -f searxng          # (optional) watch it
docker compose down                     # stop it
```

The bot reads `SEARXNG_URL` (default `http://127.0.0.1:8888`). If the container is
down, `web_search` automatically falls back to Brave (if `BRAVE_API_KEY` is set) →
Jina-reads-DDG → direct DuckDuckGo, so search still works — just without the
rate-limit-free guarantee.

## Run

```bash
./run.sh        # supervised: restarts on crash and on self_fix (exit 42)
# or
npm start       # single run
npm test        # unit tests (context store, chunker, envelope)
```

> **⚠️ Stop the openclaw container first** — it uses the SAME bot token, so both agents
> answer every mention while both run:
> `docker compose -f ~/openclaw-docker/docker-compose.yml stop`

## How it works

- Mention @Panda, reply to it, or DM it → the message (with sender name + id inline) goes
  to OpenRouter (`OPENROUTER_MODEL`, default `anthropic/claude-sonnet-4.5`) with a tool
  belt; the model calls tools until it has an answer.
- **Context is per server** (all channels share one transcript; other servers are
  isolated; DMs are per user). Stored in `data/context/<guildId>.json`, trimmed to the
  last ~60 messages at user-message boundaries.
- **Always responds:** every message that mentions Panda or replies to it — from a user
  **or** a bot — gets a response, and it's never nothing (reaction or text). The model
  decides text / reaction / both (`react` tool); if it somehow produces neither, the
  handler falls back to a 👀 reaction so Panda is never silent.
- **3-second input debounce (fixed window) + queue:** the first triggering message from a
  sender opens a 3s collection batch for them. Everything that sender says during those
  3s is concatenated into one input (the timer does **not** reset). Triggers from other
  senders during that time are **queued, not dropped** — each opens its own 3s batch at
  the back of the channel's FIFO and is processed when its turn comes. Batches run
  strictly one at a time per channel, in arrival order, and never before their own 3s
  collection has elapsed — this paces bot↔bot ping loops (replaced the old 20s bot
  cooldown).
- **Private mode:** `/private on` (Oscar only) makes Panda respond to Oscar and nobody
  else. Everyone else who mentions/DMs it gets the exact string
  *"I am in a private conversation with Oscar right now."* — and **the model is never
  called for them** (no tokens, no context). The state is a flag file
  (`data/private-mode.flag`) so it survives restarts and self-fixes. `/private off`
  re-opens; `/private status` reports.

## Skills (AI tools)

| Tool | What it does |
|---|---|
| `get_user_id` | find a member/bot id by name → ping with `<@id>` |
| `get_message_sender` | id/name of whoever sent the current message (also inline in every envelope) |
| `web_search` | self-hosted **SearXNG** (no rate limits) → Brave (if key) → Jina/DDG → DDG; cites links |
| `web_fetch` | reads a full page as clean markdown via Jina Reader (`r.jina.ai`) |
| `image_search` | SearXNG images → DuckDuckGo fallback; returns direct URLs Discord embeds |
| `vault_fetch` | reads Oscar's private `oskip-vault` GitHub repo (list/read/search paths) |
| `github_api` | any GitHub REST endpoint, authenticated as oskip0906 |
| `clear_context` | wipe THIS server's memory |
| `clear_all_context` | wipe ALL memory *(owner only)* |
| `prompt_claude` | run Claude Code on the Mac with `--dangerously-skip-permissions` *(owner only)* |
| `self_fix` | Claude Code edits panda-bot's own source, then the bot restarts (exit 42 → run.sh reloads) *(owner only)* |
| `play_music` | AI-routed music: "play X", skip, pause, resume, stop, queue |
| `react` | react to the current message with an emoji (model decides react vs text vs both) |

## Slash commands

`/menu` (rich embed of everything) · `/play` `/skip` `/pause` `/resume` `/stop` `/queue` ·
`/clear` · `/clearall` (owner) · `/private on|off|status` (owner) · `/usage` (money spent,
live from OpenRouter: the bot's own API key via `GET /api/v1/key` — today/week/month/
all-time + monthly budget — plus whole-account credits via `GET /api/v1/credits`; no
local tracking, key name never shown)

Commands are registered **per guild** on startup (instant availability).

## Caveats

1. **Same token as openclaw** — stop that container before running (see above). Panda's
   guild slash commands also replace openclaw's registered commands; openclaw's
   `state/discord/command-deploy-cache.json` may need clearing if you ever switch back.
2. **Privileged intents** — "Message Content" must be ON in the Developer Portal (it
   already is, openclaw needed it). "Server Members Intent" is optional: without it the
   bot auto-retries login without `GuildMembers` and `get_user_id` degrades to cache
   search.
3. **YouTube playback** (`discord-player-youtubei`) breaks upstream periodically. Two
   things keep it working, both already applied:
   - `youtubei.js` is pinned to `^17` via an npm **override** in `package.json` (the
     wrapper still declares `^16`, but 16.x can no longer extract YouTube's signature
     decipher function — the `Failed to extract signature/n decipher function` errors).
     When it breaks again: `npm i youtubei.js@latest` and bump the override.
   - The extractor is registered with `generateWithPoToken: true` (in
     `src/music/player.js`) — YouTube gates stream URLs behind a proof-of-origin token;
     without it you get `No valid URL to decipher`.
   `self_fix` can do the bump for you: "@Panda self_fix: update youtubei.js and fix
   YouTube playback".
4. Secrets live only in `.env` (chmod 600, gitignored) — migrated from
   `~/openclaw-docker` (Discord token, OpenRouter key, GitHub PAT).

## Layout

See [docs/plans/2026-07-21-panda-discord-agent.md](docs/plans/2026-07-21-panda-discord-agent.md)
for the full implementation plan and architecture.

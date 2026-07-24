# panda-bot 🐼

Oscar's Discord AI agent, built **from scratch**: plain Node.js + discord.js v14 + an
OpenRouter tool-calling loop. Per-server memory, music, self-hosted web/image search,
GitHub vault integration, self-fixing via Claude Code, private mode, and emoji reactions.

## Quick start (local)

```bash
cp .env.example .env        # fill in your tokens/keys
cd searxng && cp config/settings.example.yml config/settings.yml
#   set a secret: openssl rand -hex 32  →  paste into config/settings.yml
docker compose up -d        # start the search backend
cd ..
npm install
./run.sh                    # supervised: restarts on crash and on self_fix (exit 42)
# or: npm start (single run) · npm test (unit tests)
```

## Deploy with Docker (CI/CD → Docker Hub)

Every push to the **`main`** branch builds the bot into a Docker image and publishes it to
Docker Hub via GitHub Actions (`.github/workflows/docker.yml`). The full stack (bot +
SearXNG) runs from [`docker-compose.deploy.yml`](docker-compose.deploy.yml).

**One-time setup** — add these as GitHub repo secrets (Settings → Secrets and variables →
Actions), so CI can push:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `DOCKERHUB_TOKEN` | a Docker Hub access token (Account Settings → Security) |

The image is published as `<DOCKERHUB_USERNAME>/oscars-assistant-discord-bot` tagged
`latest` and the commit SHA.

**Run the published stack** on any Docker host:

```bash
cp .env.example .env                       # fill in real secrets on the server
export DOCKERHUB_USERNAME=youruser
docker compose -f docker-compose.deploy.yml up -d
```

This starts SearXNG and the bot together on a private network; the bot reaches search at
`http://searxng:8080` (wired automatically). Bot state persists in the `panda-data` volume.

> Note: `prompt_claude` / `self_fix` shell out to the `claude` CLI, which isn't present in
> the container — those two owner tools only work when running on a machine with Claude
> Code installed. Everything else runs fine containerized.

## Search backend (SearXNG — no rate limits)

Web/image search runs against a private, self-hosted
[SearXNG](https://github.com/searxng/searxng) metasearch instance in `searxng/`
(bot-limiter disabled → no external rate limits). The bot reads `SEARXNG_URL`
(default `http://127.0.0.1:8888` locally, `http://searxng:8080` in the deploy compose).
If it's down, `web_search` falls back to Brave (if `BRAVE_API_KEY` is set) →
Jina-reads-DDG → direct DuckDuckGo, so search still works.

## How it works

- Mention @Panda, reply to it, or DM it → the message (with sender name + id inline) goes
  to OpenRouter (`OPENROUTER_MODEL`, default `google/gemini-2.5-flash`) with a tool belt;
  the model calls tools until it has an answer.
- **Context is per server** (all channels share one transcript; other servers are
  isolated; DMs are per user). Stored in `data/context/<guildId>.json`, trimmed to the
  last ~60 messages at user-message boundaries.
- **Always responds:** every message that mentions Panda or replies to it — from a user
  **or** a bot — gets a response, never nothing. The model decides text / reaction / both
  (`react` tool); if it produces neither, the handler falls back to a 👀 reaction.
- **3-second input debounce (fixed window) + queue:** the first triggering message from a
  sender opens a 3s collection batch for them. Everything that sender says during those 3s
  is concatenated into one input (the timer does **not** reset). Triggers from other
  senders during that time are **queued, not dropped** — each opens its own 3s batch at the
  back of the channel's FIFO. Batches run one at a time per channel, in arrival order —
  this paces bot↔bot ping loops.
- **Private mode:** `/private on` (Oscar only) makes Panda respond to Oscar and nobody
  else. Everyone else who mentions/DMs it gets *"I am in a private conversation with Oscar
  right now."* — and **the model is never called for them**. The state is a flag file
  (`data/private-mode.flag`) that survives restarts. `/private off` re-opens.

## Skills (AI tools)

| Tool | What it does |
|---|---|
| `get_user_id` | find a member/bot id by name → ping with `<@id>` |
| `get_message_sender` | id/name of whoever sent the current message |
| `web_search` | self-hosted **SearXNG** → Brave (if key) → Jina/DDG → DDG; cites links |
| `web_fetch` | reads a full page as clean markdown via Jina Reader (`r.jina.ai`) |
| `image_search` | SearXNG images → DuckDuckGo fallback; returns direct URLs Discord embeds |
| `vault_fetch` | reads Oscar's private vault GitHub repo (list/read/search paths) |
| `github` | any GitHub REST endpoint, authenticated as the configured user *(owner only)* |
| `clear_context` | wipe THIS server's memory |
| `clear_all_context` | wipe ALL memory *(owner only)* |
| `prompt_claude` | run Claude Code on the host with `--dangerously-skip-permissions` *(owner only)* |
| `self_fix` | Claude Code edits the bot's own source, then it restarts (exit 42 → run.sh reloads) *(owner only)* |
| `play_music` | AI-routed music: "play X", skip, pause, resume, stop, queue |
| `react` | react to the current message with an emoji (model decides react vs text vs both) |

## Slash commands

`/menu` · `/usage` · `/model` · `/play` `/skip` `/pause` `/resume` `/stop` `/queue` ·
`/web_search` `/web_fetch` `/image_search` `/vault_fetch` · `/clear` · `/clearall` (owner) ·
`/github` (owner) · `/claude` (owner) · `/self_fix` (owner) · `/private on|off|status` (owner)

Registered **per guild** on startup (instant availability).

## Caveats

1. **Privileged intents** — "Message Content" must be ON in the Discord Developer Portal.
   "Server Members Intent" is optional: without it the bot auto-retries login without
   `GuildMembers` and `get_user_id` degrades to cache search.
2. **YouTube playback** — audio is streamed via **yt-dlp** (`youtube-dl-exec`), not
   youtubei.js. youtubei is kept only for search/metadata; its streaming path is broken
   upstream (returns "streaming data not available") and even when it worked, YouTube
   throttled and reset the WEB stream mid-song (`ECONNRESET` → no sound). yt-dlp resolves
   and pipes the audio itself, reliably, via discord-player's `onBeforeCreateStream` hook
   (`src/music/player.js`).
   - **Cookies are required for reliable playback.** YouTube bot-walls unauthenticated
     extraction under load ("Sign in to confirm you're not a bot"). Export your
     `youtube.com` cookies to a Netscape `cookies.txt` (browser extension *Get cookies.txt
     LOCALLY*) and set `YT_COOKIES_FILE=/path/to/cookies.txt`. For local runs you can
     instead set `YT_COOKIES_FROM_BROWSER=chrome`. Without cookies, many videos still play
     but some fail with a "skipping" message.
3. Secrets live only in `.env` (gitignored). Never commit them.

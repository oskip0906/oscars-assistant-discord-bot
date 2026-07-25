# panda-bot 🐼

Oscar's Discord AI agent, built **from scratch**: plain Node.js + discord.js v14 + an
**OpenRouter** tool-calling loop. Per-server memory, music, self-hosted web/image search,
GitHub vault integration, self-fixing source code, private mode, and emoji reactions.

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

Every push to **`main`** builds the bot into a Docker image and publishes it to Docker Hub
via GitHub Actions (`.github/workflows/docker.yml`). The full stack (bot + SearXNG) runs
from [`docker-compose.deploy.yml`](docker-compose.deploy.yml).

**One-time setup** — add these as GitHub repo secrets (Settings → Secrets and variables →
Actions):

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

> Note: `self_fix` shells out to the `claude` CLI, which isn't in the container — it only
> works on a machine with Claude Code installed. Everything else runs fine containerized.

## Search backend (SearXNG — no rate limits)

Web/image search runs against a private, self-hosted
[SearXNG](https://github.com/searxng/searxng) metasearch instance in `searxng/`
(bot-limiter disabled → no external rate limits). The bot reads `SEARXNG_URL`
(default `http://127.0.0.1:8888` locally, `http://searxng:8080` in the deploy compose).
If it's down, `web_search` falls back to Brave (if `BRAVE_API_KEY` is set) →
Jina-reads-DDG → direct DuckDuckGo.

## How it works

- Mention @Panda or reply to it → the message (with sender name + id inline) goes to
  **OpenRouter** (`OPENROUTER_MODEL`, default `google/gemini-2.5-flash`) with a tool belt;
  the model calls tools until it has an answer. (DMs are ignored by default.)
- **Context is per server** (all channels share one transcript; other servers are
  isolated). Stored in `data/context/<guildId>.json`, trimmed to the last ~60 messages.
- **Always responds:** every message that mentions Panda or replies to it — from a user
  **or** a bot — gets a response. The model decides text / reaction / both (`react` tool);
  if it produces neither, the handler falls back to a 👀 reaction.
- **3-second input debounce + queue:** the first triggering message from a sender opens a
  3s collection batch; everything they say during those 3s is concatenated into one input
  (the timer does **not** reset). Triggers from other senders are queued, not dropped, and
  batches run one at a time per channel in arrival order — this paces bot↔bot ping loops.
- **Private mode:** `/private on` (Oscar only) makes Panda respond to Oscar and nobody
  else; everyone else gets *"I am in a private conversation with Oscar right now."* and the
  model is never called for them. State is a flag file (`data/private-mode.flag`) that
  survives restarts. `/private off` re-opens.
- **Self-fix mode:** while a `self_fix` is running the bot answers **nobody** through the
  model — triggering messages get a single hardcoded "I'm rebuilding myself, back soon"
  reply with no AI processing. The lock is in-memory and self-releases after 15 min.

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
| `clear_context` / `clear_all_context` | wipe this server's memory / ALL memory *(all owner)* |
| `git_push` | commit & push local source to GitHub via real git *(owner only)* |
| `self_fix` | rewrite the bot's own source, then verify → push → restart *(owner only)* |
| `play_music` | AI-routed music: "play X", skip, pause, resume, stop, queue |
| `react` | react to the current message with an emoji |

**`self_fix`** hands the instruction to Claude Code inside the project folder, which reads
and edits the files. Each round is supervised by the **OpenRouter model** (it decides
whether Claude finished or needs an answer, and replies unattended so nobody has to babysit
it). When done, the change is syntax/import-checked, committed, **automatically pushed to
GitHub** (`git_push`), and the bot restarts (exit 42 → `run.sh` reloads) to apply it.

## Slash commands

`/menu` · `/usage` · `/model` · `/play` `/skip` `/pause` `/resume` `/stop` `/queue` ·
`/web_search` `/web_fetch` `/image_search` `/vault_fetch` · `/clear` · `/clearall` (owner) ·
`/github` (owner) · `/self_fix` (owner) · `/git_push` (owner) · `/private on|off|status` (owner)

`/web_search`, `/web_fetch`, `/image_search`, `/vault_fetch`, and `/github` each take a
**single free-text field** in the Discord UI (query / url / body) — no fiddly structured
parameters. Registered **per guild** on startup (instant availability).

## Caveats

1. **Privileged intents** — "Message Content" must be ON in the Discord Developer Portal.
   "Server Members Intent" is optional: without it the bot auto-retries login without
   `GuildMembers` and `get_user_id` degrades to cache search.
2. **YouTube playback** — audio is streamed via **yt-dlp** (`youtube-dl-exec`), not
   youtubei.js, whose streaming path is broken upstream. youtubei.js is kept only for
   search/metadata, and its noisy parser errors (YouTube constantly ships new renderer
   types like `HorizontalShelfView` that the pinned release doesn't know about, spamming
   `InnertubeError: … not found!`) are silenced by muting its logger in
   `src/music/player.js`. Two things keep yt-dlp reliable, both wired in:
     - `--js-runtimes node` — solves YouTube's signature/nsig JS challenges using the Node
       binary the bot already runs on (no deno/extra install).
     - **Cookies** — YouTube bot-walls unauthenticated extraction under load. The bot uses a
       cookies file (`YT_COOKIES_FILE`), stable and Docker-friendly. Regenerate it with:
       ```bash
       npm run yt-cookies      # writes ./cookies.txt from Chrome
       ```
       Cookies expire eventually; re-run if playback starts failing.
3. Secrets live only in `.env` (gitignored). Never commit them.
```

# panda-bot 🐼

Oscar's Discord AI agent, built **from scratch**: plain Node.js + discord.js v14 + an
**OpenRouter** tool-calling loop. Per-server memory, music, self-hosted web/image search,
GitHub vault integration, self-fixing source code, private mode, and emoji reactions.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## Quick start (local)

```bash
cp .env.example .env        # fill in your tokens/keys
cd searxng && cp config/settings.example.yml config/settings.yml
#   set a secret: openssl rand -hex 32  →  paste into config/settings.yml
docker compose up -d        # start the search backend
cd ..
npm install
./run.sh                    # or npm start — generates the gitignored start.sh
                            # supervisor, which pulls main before every boot
# or: npm run start:once (one run, no pull/restart loop) · npm test (unit tests)
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
> works on a machine with Claude Code installed. The container also runs `node src/index.js`
> directly rather than `run.sh`, since there's no git checkout to pull into; restarts are the
> orchestrator's job there. Everything else runs fine containerized.

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
| `self_fix` | rewrite the bot's own source, then verify → PR → merge → pull → restart *(owner only)* |
| `play_music` | AI-routed music: "play X", skip, pause, resume, stop, queue |
| `react` | react to the current message with an emoji |

**`self_fix`** hands the instruction to Claude Code inside the project folder, which reads
and edits the files. Each round is supervised by the **OpenRouter model** (it decides
whether Claude finished or needs an answer, and replies unattended so nobody has to babysit
it). When done, the change is syntax/import-checked and then shipped **through GitHub, never
through the local checkout**: the edits are uploaded as a pull request against `main`,
auto-merged (squash), and pulled back down so this machine matches the remote exactly. Then
the bot exits 42 and `start.sh` pulls once more and reboots into the merged code. If the PR
fails to open or merge, nothing is pulled and the bot does **not** restart.

### Start scripts

`run.sh` is the entry point; on an unsupervised launch it generates **`start.sh`** (gitignored)
and hands over to it. `start.sh` is the long-lived supervisor: it runs `git pull --ff-only
origin main` before every boot, then `run.sh` runs the bot once and passes node's exit code
back up (0 = stop, 42 = self-fix restart, anything else = crash, retry in 3s). The supervisor
has to be gitignored because bash reads a script as it executes it — a `git pull` rewriting
the running loop mid-flight would corrupt it. Edit the template in `run.sh`; bump its version
marker to have an existing `start.sh` regenerated.

## Slash commands

`/menu` · `/usage` · `/model` · `/play` `/skip` `/pause` `/resume` `/stop` `/queue` ·
`/web_search` `/web_fetch` `/image_search` `/vault_fetch` · `/clear` · `/clearall` (owner) ·
`/github` (owner) · `/self_fix` (owner) · `/git_push` (owner) · `/private on|off|status` (owner)

`/web_search`, `/web_fetch`, `/image_search`, `/vault_fetch`, and `/github` each take a
**single free-text field** in the Discord UI (query / url / body) — no fiddly structured
parameters. Registered **per guild** on startup (instant availability).

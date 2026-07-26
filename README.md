# panda-bot 🐼

Oscar's Discord AI agent, built from scratch with Node.js + discord.js v14 and an OpenRouter tool-calling loop. It has per-server memory, music playback, web/image search, GitHub vault integration, self-fixing source code, private mode, and emoji reactions.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- Respond to mentions and replies with AI (OpenRouter).
- Play music in voice channels (via slash commands or chat).
- Search the web and images (self-hosted SearXNG, with fallbacks).
- Read Oscar's private knowledge vault (GitHub).
- Self-fix its own source code via remote GitHub Actions sandbox (owner only).
- Private mode: only respond to Oscar.
- Per-server conversation memory.

## Skills (AI tools)

| Tool | Description |
|------|-------------|
| `get_user_id` | Find a member/bot id by name |
| `get_message_sender` | Get sender info of current message |
| `web_search` | Search the web (SearXNG → Brave → Jina/DDG → DDG) |
| `web_fetch` | Read a full web page as markdown |
| `image_search` | Search for images |
| `vault_fetch` | Read Oscar's private vault |
| `github` | GitHub REST API (owner only) |
| `create_pr` | Open a development PR on any repo (owner only) |
| `clear_context` / `clear_all_context` | Wipe memory for this server / all servers |
| `self_fix` | Self-fix source code via remote sandbox (owner only) |
| `play_music` | Control music playback |
| `react` | React to a message with an emoji |

## Slash Commands

- `/menu` — Show everything Panda can do
- `/usage` — Show how much money Panda has spent
- `/model` — Show which AI model Panda is running on
- `/play <song>` — Play a song or add it to the queue
- `/skip` — Skip the current track
- `/pause` — Pause playback
- `/resume` — Resume playback
- `/stop` — Stop playback and clear the queue
- `/queue` — Show the current queue
- `/web_search <query>` — Search the web and get cited links
- `/web_fetch <url>` — Fetch and read the full content of a web page
- `/image_search <query>` — Search for images
- `/vault_fetch <query>` — Read Oscar’s knowledge vault
- `/clear` — Erase Panda’s memory of this server
- `/clearall` (owner) — Erase ALL of Panda’s memory
- `/github` (owner) — Call the GitHub API (writes/private repos are owner only)
- `/self_fix <instruction>` (owner) — Patch Panda’s own source code and restart
- `/run_dev <instruction> [repo]` (owner) — Run an approved remote development task and open a PR
- `/set_dev_model <model>` (owner) — Set the OpenRouter model used for development tasks
- `/switch_model <model>` (owner) — Switch Panda to another OpenRouter model and restart
- `/private on|off|status` (owner) — Turn private mode on, off, or check status
- `/set_rule <rule>` (owner) — Set a rule that Panda always follows
- `/toggle_response <user_id>` (owner) — Toggle whether Panda responds to a specific user

## CI/CD and secrets

Every push to `main` builds a Docker image and publishes it to Docker Hub via GitHub Actions (`.github/workflows/docker.yml`). The full stack (bot + SearXNG) runs from `docker-compose.deploy.yml`.

**Required GitHub repo secrets** for the CI/CD pipeline:

| Secret | Description |
|--------|-------------|
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token |

The image is published as `<username>/oscars-assistant-discord-bot` with tags `latest` and the commit SHA.

For local development, copy `.env.example` to `.env` and fill in the required tokens (see the example file). The bot also needs a SearXNG instance; a local Docker Compose setup is provided.

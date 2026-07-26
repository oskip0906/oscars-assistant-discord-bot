# panda-bot 🐼

Oscar's Discord AI agent, built from scratch with Node.js + discord.js v14 and an OpenRouter tool-calling loop. It has per-server memory, music playback, web/image search, GitHub vault integration, self-fixing source code, private mode, and emoji reactions.

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

## Slash commands

`/menu` · `/usage` · `/model` · `/play` `/skip` `/pause` `/resume` `/stop` `/queue` · `/web_search` `/web_fetch` `/image_search` `/vault_fetch` · `/clear` · `/clearall` (owner) · `/github` (owner) · `/self_fix` (owner) · `/run_dev` (owner) · `/set_dev_model` (owner) · `/switch_model` (owner) · `/private on|off|status` (owner) · `/set_rule` (owner) · `/toggle_response` (owner)

## CI/CD and secrets

Every push to `main` builds a Docker image and publishes it to Docker Hub via GitHub Actions (`.github/workflows/docker.yml`). The full stack (bot + SearXNG) runs from `docker-compose.deploy.yml`.

**Required GitHub repo secrets** for the CI/CD pipeline:

| Secret | Description |
|--------|-------------|
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token |

The image is published as `<username>/oscars-assistant-discord-bot` with tags `latest` and the commit SHA.

For local development, copy `.env.example` to `.env` and fill in the required tokens (see the example file). The bot also needs a SearXNG instance; a local Docker Compose setup is provided.

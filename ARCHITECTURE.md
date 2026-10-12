# How Panda works

How panda-bot turns a message into a reply, and how its prompts, memory, models, Jev, tools, research, sandbox and safety work. For a quick overview, see the [README](README.md).

Panda's `how_i_work` tool reads this file, plus the source files on GitHub that answer the question, to explain itself. If you change how the bot works, update this file too.

## How a message becomes a reply

The flow lives in `src/discord/messageHandler.js` and `src/agent/agent.js`.

1. **Does Panda answer?** Always for an @-ping or a reply to Panda. Otherwise **Jev** reads the message with the 5 before it and Panda joins in one of two ways. **Talk**: always when it directly responds to one of Panda's own lines there (≥ 0.6, and only if Panda really spoke in those 5) or when Jev, reading identity.md and those 5 lines, is fairly sure it is addressed to Panda even unnamed (≥ 0.7); otherwise sampled from Jev's odds that it talks to or about Panda by one of its names, continues a conversation Panda is in, or puts a question to the room Panda could help with (under 0.3 is always no). **React**: when it isn't for Panda but stands out (funny, wild, dumb, big news), sampled from Jev's odds (under 0.5 is never), and that turn is emoji only. Another name or nickname ("slopbot", another bot) is never Panda. Before Jev, `addressee` checks the wording: "Panda", its Discord name, "panda bot", "Oscar's bot" or "the bot" from anyone means talk, as does "my bot" / "my assistant" from Oscar only (from anyone else it is their own bot); a message put to Oscar (his @mention, a reply to him, "Oscar, can you…") is his, and Panda stays out of it. Bots are judged exactly like people. The model is never told it was addressed: an unpinged turn says only that it did not ping Panda, and the model judges from the message and the recent lines. A no means silence and nothing saved. Never in DMs. In private mode anyone but Oscar gets a fixed "private conversation" reply. A self-fix doesn't pause answering.
2. **Batching.** The first trigger opens a 3-second batch for that sender; everything they send in that time joins it. Batches run one at a time per channel (in the order triggered, at most 10 waiting, extras dropped) and per server. Panda replies to the last message of the batch.
3. **Prompt.** The system prompt (`src/agent/systemPrompt.js`) holds the date, server, channel, sender, private-mode note and security rules, followed by `identity.md` and `soul.md` from the database. The turn is the batch (`[RESPOND TO THIS]`, which matters most) under the 5 messages before it (`[RECENT MESSAGES]`, supporting background), each written as `Name (@username, id:NNN): text`. The prompt lists Panda's names (`myNames`) and tells it not to assume what the background doesn't make clear. A turn Panda joined without being named says so, so it doesn't take the message as being about itself. Anything older is read only through tools. Attachments (images, PDFs, text files, GIF frames, the picture being replied to) go to the model for that turn only.
4. **Jev triage.** One Jev call asks everything at once: sign-off (≥ 0.8 → react 👋, no model call), which tools to offer (≥ 0.5 each; Oscar-only tools stop the turn for anyone else), whether the turn refers to something unexplained (≥ 0.8 → add `fetch_history`), reaction / message / both, and the mood (funny, happy, sad, angry or neutral). The form is sampled from Jev's probabilities at temperature 1.5, none favored. A turn owed words (any ping, reply to Panda or DM, or a question or request to Panda or a response to something it said, ≥ 0.5) is text or both, never reaction-only, and its words are always sent; its reaction odds count toward both. A turn Panda joined only to react is a reaction with no tools. The mood sets a `[TONE]` note and which reactions are suggested (a random 5 from that mood's set each turn, `MOOD_EMOJI`). If Jev is down: no tools, text reply.
5. **Tools.** The model never chooses tools, it only fills in arguments for the picked ones. A turn is at most five model calls (`MAX_MODEL_CALLS`): up to four rounds of tool calls (picked tools only, run in parallel, results capped at 12,000 characters each), then the answer with no tools. The first round must call a tool; later rounds may call more (search, then read a page) or answer in words, which ends the turn. `react` is offered until Panda has reacted. Every reaction (the tool, the 👋 wave, the 👀 fallback) goes through `reactOnce` (`src/discord/reactions.js`): at most one per message, the first one asked for wins, and a failed one is not retried or swapped for another.
6. **Sending.** The reply starts with a small `-# 🔧 tools used` line (`react` is never listed; a reaction-only turn sends no text), text over 2,000 characters is split cleanly (`src/discord/chunk.js`), and bare links are wrapped in `<>`. A response is mandatory: with nothing to say Panda reacts 👀. Afterwards the batch and reply are saved to the context store.
7. **Bots.** Conversations with other bots continue until a sign-off ("bye!"), then Panda reacts 👋 and ignores unpinged bot lines in that channel until a human speaks; a bot's ping or reply is still answered (or waved at, if it's another bye).

**Discord UI** (`src/agent/tools/ui.js`). `create_poll` posts a native poll (2–10 answers, 1–768 hours). `send_card` posts an embed with up to 25 fields, 5 buttons and a dropdown. Link buttons open a url; other buttons and the dropdown are clickable (ids start with `ui:`). A click is acknowledged at once, then handled like a message from the clicker (`[clicked "…"]`), with the same batching, Jev triage, owner checks and private mode.

## Prompts

All behavior text lives in the database table `prompts` (`src/agent/prompts.js`), cached for 60 seconds so edits are live within a minute.

| File | Holds | Changed by |
|------|-------|------------|
| `identity.md` | Who Panda is, Oscar as owner, boundaries, Discord rules, tool usage | Editing the database row |
| `soul.md` | Personality and tone | Oscar, with `set_rule` |
| `history/soul-<time>.md` | Every `soul.md` that `set_rule` replaced | `set_rule` |

`identity.md` wins if they disagree. If the database is down the bot keeps its last copy, or runs on the system prompt alone.

**`set_rule`** (tool and `/set_rule`, Oscar only): the development model rewrites `soul.md` with the instruction applied, the old one is saved to `history/`, and it applies from the next message.

## Memory: context, notes and reminders

Everything is stored in one PMS Postgres database (`DATABASE_URL`). `src/db.js` applies `src/schema.sql` at boot. Without it, chat works but there are no prompts, context, notes or reminders.

**Storage budget** (`src/storage.js`): of the 1 GiB, persona gets 10 MB and the rest splits 75% context, 20% notes, 5% reminders. When a section is full, Panda DMs Oscar with **Delete oldest** / **Not now** and refuses new writes to it until trimmed.

**Context (hidden).** Panda keeps no summary or transcript, only per-channel message rows that feed the model. DMs are never saved. Everything else Panda sees is saved, after the reply is out: each turn, its reply and the 5 messages before it, everything `fetch_history` and `index_chat` read, and whole channels (below).
- `fetch_history`: *range* mode reads the channel straight from Discord (default 30, max 100 messages). *Search* mode takes a list of words and phrases (`query`) and a list of people (`author`) and returns every saved message from this channel that contains any of the words or phrases (full-text, so "plan" finds "plans", or as plain text, so names, numbers and links match) and, when authors are given, was sent by any of them. There is no Jev filter. Results are shown with what was searched, oldest first under a heading per day; if they don't fit in the 12,000-character tool result, the best-ranked are shown and the rest counted. When nothing matches, the whole channel is indexed and the search runs again; if it still finds nothing, the model is told so plainly and not to guess.
- **Channel indexing** (`src/discord/indexChannel.js`, also `/index_channel` for Oscar) copies a channel's history into the store. `context_channels` records how far it got (newest and oldest message saved, and whether it reached the first message), so a run reads only what is new since the last one, then carries on back from where that one stopped. A search-triggered run is capped at 20,000 messages or 60 s per turn; the next miss continues it.
- `index_chat`: given a message link or id, reads the 100 messages around it and remembers them. Other channels must be in this server and readable by the asker.

**Notes (shared).** Everyone sees every note (`src/agent/notes.js`, `src/discord/notes.js`).
- `/save_note [minutes]` reads the last 10 minutes (Jev trims past 60,000 characters). The model writes a title, description and Markdown summary, then files it in a nestable folder tree (or `Unsorted`) and may link up to 3 related notes.
- Finding notes (`search_notes`, `/open_note`): Jev walks the folder tree, then notes are ranked by full-text and title similarity. `/open_note` tries exact title, then similar title, then the search.
- `/display_notes` browses the tree; `/delete_note` is for the author or Oscar, after a confirm button.

**Reminders** (`src/reminders.js`). `/add_reminder <name> <repeat> <when> [timezone]`; repeat is once, daily, weekly or monthly. Times are stored as UTC and repeats are recomputed in the creator's timezone, so daylight saving can't shift them. Every 30 s due reminders are posted in the channel they were made in, pinging the creator (`channel_id`); one made in a DM, made before channels were saved, or whose channel is gone or unwritable goes by DM instead. Ones missed while down go out once, marked late. `/delete_reminder`: creator or Oscar.

## Models: OpenRouter and Jev

Every model call uses one OpenRouter key (`src/agent/openrouter.js`), retried on network errors, 429s, 5xx and 60 s of silence. Only real API errors fail a turn.

| Role | Used for |
|------|----------|
| **Conversation** model | Chat, `/research`, `set_rule`, `self_fix` commit titles |
| **Claude Code** | The code change in `self_fix` |
| **Jev** (`typesafe/jev-1.13`) | Fast yes/no and pick-one decisions |

`/set_model <model> [provider]` (Oscar) validates the id against OpenRouter's catalog and saves it in `bot_settings`, live at once and kept across restarts. The optional provider (e.g. `deepinfra`) pins that model to one OpenRouter provider (`provider: { order: [slug], allow_fallbacks: false }`); it is checked against the model's endpoints and refused if OpenRouter doesn't route the model there. Providers are saved per model id as JSON in the `model_providers` row; a blank provider, or no row at all, sends no provider field, so OpenRouter routes as it always has. `/model` shows the model and provider; `/usage` shows spend.

## Jev: the decision layer

Jev decides; the conversation model writes. The model never chooses whether to answer, which tools run, whether to react, what to remember or which notes folder to open. Plain code applies Jev's answers: tool picks, lookups and memory use fixed thresholds; the social calls (whether to chime in, react or talk) are sampled from Jev's probabilities so Panda varies like a person. Jev ignores a `temperature` field (0 and 2 return the same numbers), so `sampleChoice` / `sampleYes` in `jev.js` apply it.

`decide(config, state, questions)` in `src/agent/jev.js` sends named text `state` and named `questions` in one call (~0.2 s). Answers are probabilities: `noul` (yes, 0–1) or `choice` (a probability per option). The model is pinned because the thresholds were tuned to 1.13. `decide` returns `null` when `JEV_ENABLED=false`, the key is missing, the call fails or takes over 5 s, and every caller then falls back to its non-Jev behavior, so an outage never breaks a turn.

| Decision | Asked when | Bar | Jev off or down |
|----------|-----------|-----|-----------------|
| Gate (`forPanda`) | Server message that isn't a ping or reply | follow-up to Panda ≥ 0.6 or addressed ≥ 0.7 → talk; else talk sampled (never < 0.3), else react sampled (never < 0.5); bots the same | Silence |
| Bot sign-off | Every bot message | ≥ 0.8 → 👋, stop | Farewell regex |
| Triage | Every turn | sign-off ≥ 0.8; tool ≥ 0.5; unexplained ≥ 0.8; form sampled (owed words ≥ 0.5 → text or both); mood = most likely | No tools, text reply |
| Memory scan (`pickRelevant`) | Long `/save_note` windows | line ≥ 0.5 | Keep nothing |
| Source files (`how_i_work`) | A question about Panda with a topic | file ≥ 0.5, best 3 | Files whose path has a topic word |
| Notes walk | `search_notes`, `/open_note` | folder ≥ 0.25 (max 6 levels, 8 folders) | Search every note |
| Research fact-check | Each page read by `/research` | drop claim < 0.3 | Keep every claim |

Bars follow which mistake costs more: the gate is loose but floored, because joining in is human and butting into unrelated chatter is not; tools are loose because an extra tool is cheap; folders are wide so near-miss filing is still found; research drops a claim only when Jev is fairly sure its quote doesn't support it.

**Privacy:** the gate means Jev sees every server message Panda can read, with the 2 before it. `JEV_ENABLED=false` stops that.

## Tools

| Tool | What it does |
|------|--------------|
| `get_user_id` / `get_message_sender` | Find a member's id; who sent a message |
| `server_info` | Read-only server overview, channels, roles, events, members, emojis, threads (hidden channels left out) |
| `react` | React with one emoji (at most one Panda reaction per message, `src/discord/reactions.js`) |
| `create_poll` / `send_card` | Post a poll / an embed card with buttons and dropdown |
| `web_search` / `web_fetch` / `image_search` / `video_search` / `news_search` / `wiki_search` | SearXNG: web search (bing, falling back to yahoo then mojeek); read a public page; up to 3 images (google images); one dedicated engine each for videos (youtube), news (bing news), wiki (wikipedia) |
| `fetch_history` / `index_chat` | Read or search older messages |
| `search_notes` | Find saved notes |
| `how_i_work` | Read this file and the source files on GitHub that answer a topic (Jev picks up to 3; long files cut to the lines around the topic) |
| `play_music` | play / skip / pause / resume / stop / queue / now playing |
| GitHub MCP tools | Every GitHub read (**Oscar only**) |
| `github` | GitHub REST writes only (**Oscar only**) |
| `self_fix` / `set_rule` | Change Panda's code / personality (**Oscar only**) |

"Oscar only" is checked in code against the sender's Discord user id.

Slash commands: music (`/play /skip /pause /resume /stop /queue`), skills (`/research /web_search /web_fetch /image_search /video_search /news_search /wiki_search /create_poll /create_card`), notes (`/save_note /display_notes /open_note /delete_note`), reminders (`/add_reminder /show_reminders /delete_reminder`), info (`/menu /usage /model`), Oscar only (`/set_rule /self_fix /set_model /private`).

## Deep research

`/research [quick|normal|deep]` (`src/agent/research/`) is a fixed pipeline: plan sub-questions and search; pick and read pages (1–2 per domain); extract claims with word-for-word quotes (code checks the quote is on the page, Jev checks it supports the claim); fill gaps with rewritten queries (deep only); write one cited section per sub-question plus a direct answer.

| Depth | Sub-questions | Max pages | Gap rounds | Time limit |
|-------|---------------|-----------|------------|------------|
| `quick` | 3 | 8 | 0 | 90 s |
| `normal` | 5 | 16 | 0 | 4 min |
| `deep` | 5 | 32 | 2 | 10 min |

Sources are masked links so Discord shows previews; chat replies still wrap links in `<>`.

## The development sandbox (`self_fix`)

The only way Panda changes code, and only its own repo.

1. **Approval:** an Approve / Cancel card; only Oscar's click starts anything.
2. **Dispatch:** the bot starts `.github/workflows/development-sandbox.yml` on a throwaway runner, on a `panda-dev-*` branch.
3. **Claude Code** makes the change unattended with a read-only GitHub token, seeing only the repo and the instruction.
4. **Verify:** the workflow fails if nothing changed or `.git`, `node_modules`, `data/`, `.env` or `.github/` were touched, runs `npm test`, then commits, pushes and opens the PR with `GH_PAT`. `ci.yml`'s required `test` check gates auto-merge.

The bot watches via the GitHub MCP server, enables auto-merge and waits. The merge to main triggers the deploy (under `run.sh`, exit code 42 pulls and restarts). The run is in the background, so Panda keeps answering meanwhile; only a second self-fix is refused until it lands (or 50 min pass).

## Safety

- Owner checks use the Discord user id, never names or claims.
- Security rules live in the code's system prompt, so they hold even when the database is down.
- Credentials are only used in auth headers and the database connection; `redactSecrets` (`src/config.js`) strips their values from tool results and outgoing messages.
- `index_chat` only reads channels the asker can read; `web_fetch` refuses loopback, LAN, link-local and metadata addresses on every lookup and redirect.
- Every GitHub read goes through the read-only MCP endpoint; the only REST calls are writes.
- One GitHub token: `GITHUB_PAT` in the bot, `GH_PAT` in Actions.
- `/set_model` only saves model ids and provider names made of safe characters.

## Running and deploying

`npm start` runs `run.sh`: a private SearXNG (installed by `scripts/ensure-searxng.sh` with `uv`, loopback only, never blocks boot), then the bot under a supervisor (exit 42 → pull and restart, crash → restart after 3 s, exit 0 → stop). `npm run start:once` skips the supervisor; `npm test` runs the tests.

Every push to `main` builds and publishes the `panda-bot` and `panda-searxng` Docker images (`.github/workflows/docker.yml`). Production runs on PMS Cloud containers (project `oscars-discord-bot`) with `SEARXNG_URL=http://panda-searxng:8080`; they have no disk, so YouTube cookies go in as `YT_COOKIES_B64` and `/app/data` resets on restart. The CI deploy step currently fails behind Cloudflare, so deploy by hand: `pms container edit <name> --image <image>:<sha>`. To self-host, use `docker-compose.deploy.yml` with a volume on `/app/data`. Always set `DATABASE_URL`.

## Project layout

```
src/index.js              boot, intents, slash-command registration
src/discord/              message handler, slash commands, embeds, chunking
src/agent/                agent.js (triage, tools, answer), jev.js, prompts.js, historyStore.js, notes.js
src/agent/tools/          every tool the model can call
src/agent/research/       the /research pipeline
src/db.js, schema.sql     Postgres connection and tables
src/storage.js            section budgets and cleanup
src/reminders.js          reminder times and scheduler
src/music/                discord-player + yt-dlp streaming
.github/                  Docker build + deploy, CI tests, the development sandbox
```

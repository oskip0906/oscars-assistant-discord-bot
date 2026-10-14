# How Panda works

How panda-bot turns a message into a reply, and how its prompts, memory, models, Jev, tools, research, sandbox and safety work. For a quick overview, see the [README](README.md).

Panda's `how_i_work` tool reads this file, plus the source files on GitHub that answer the question, to explain itself. If you change how the bot works, update this file too.

## How a message becomes a reply

The flow lives in `src/discord/messageHandler.js` and `src/agent/agent.js`.

1. **Does Panda answer?** Always for an @-ping or a reply to Panda. Otherwise **Jev** reads the message with the 5 before it and Panda joins in one of two ways. **Talk** (text, or text + reaction) only when Jev is at least 80% sure it directly responds to one of Panda's own lines there (only if Panda really spoke in those 5) or is addressed to Panda, judged from identity.md and those 5 lines, so even unnamed; never by chance. **React**: when it isn't for Panda but stands out (funny, wild, dumb, big news), sampled from Jev's odds (under 0.5 is never), and that turn is emoji only. Another name or nickname ("slopbot", another bot) is never Panda. Before Jev, `addressee` checks the wording: "Panda", its Discord name, "panda bot", "Oscar's bot" or "the bot" from anyone means talk when it calls Panda (opening the message, as in "panda bot, …" or "panda play lofi", or tagged on the end, "…, panda?"), as does "my bot" / "my assistant" from Oscar only (from anyone else it is their own bot). Being named is not being addressed: a name anywhere else, or one opening a message that goes on to talk about Panda ("panda is so slow today", "ask panda later"), goes to Jev, who is told it was named and decides like any other message (Jev down: silence); a message put to Oscar (his @mention, a reply to him, "Oscar, can you…") is his, and Panda stays out of it. Bots are judged exactly like people. The model is never told it was addressed: an unpinged turn says only that it did not ping Panda, and the model judges from the message and the recent lines. A no means silence and nothing saved. Never in DMs. In private mode an `if` at the very top of the message handler drops anything not from Oscar: no reply, no reaction, no Jev, nothing saved. A self-fix doesn't pause answering.
2. **Batching.** The first trigger opens a batch for that sender, 1.5 seconds by default (`BATCH_WINDOW_MS`, 250–10,000); everything they send in that time joins it, and another sender's trigger opens their own. Batches run one at a time per channel (in the order triggered, at most 10 waiting, extras dropped) and per server. Panda replies to the last message of the batch. A reply to Panda is recognized from the author Discord puts on the message, without fetching it; a reply the trigger check did fetch, and the 5 lines Jev read for an unpinged message, are reused by the turn instead of fetched again.
3. **Prompt.** The system prompt (`src/agent/systemPrompt.js`) holds the date, server, channel, sender, private-mode note and security rules, followed by `identity.md` and `soul.md` from the database. The turn is the batch (`[RESPOND TO THIS]`, which matters most) under the 5 messages before it (`[RECENT MESSAGES]`, supporting background), each written as `Name (@username, id:NNN): text`. Panda's own lines there leave out their small grey `-# ` lines (the tools used, the token stats): noise, and they read as "always use tools". The prompt lists Panda's names (`myNames`) and tells it not to assume what the background doesn't make clear. A turn Panda joined without being named says so, so it doesn't take the message as being about itself. Anything older is read only through tools. Attachments (images, PDFs, text files, GIF frames, the picture being replied to) go to the model for that turn only (`src/discord/attachments.js`), opened by an `[ATTACHMENTS]` manifest that numbers every file with its name, type, size, sender and status: sent, sent as a link, shrunk to fit, OMITTED (past 30 files per turn, the turn's own first) or NOT READ (with the reason). No file is dropped silently. Images over 5 MB are shrunk through Discord's media proxy, or marked unreadable when they can't be; past 40 MB of downloads per turn files go as their links. The same file reached twice is one entry; look-alike uploads are not merged, since spotting duplicate receipts is the model's job. The system prompt tells the model to go through receipts by number, flag possible duplicates, double-check its arithmetic, and never call a total complete when a file is missing.
4. **Jev triage.** One Jev call asks everything at once: sign-off (≥ 0.8 → react 👋, no model call), which tools it expects (≥ 0.5 each; Oscar-only tools stop the turn for anyone else), whether the turn refers to something unexplained (≥ 0.8 → add `fetch_history`), reaction / message / both, and the mood (funny, happy, sad, angry or neutral). The form is sampled from Jev's probabilities at temperature 1.5, none favored. A turn owed words (any ping, reply to Panda or DM, or a question or request to Panda or a response to something it said, ≥ 0.5) is text or both, never reaction-only, and its words are always sent; its reaction odds count toward both. A turn Panda joined only to react is a reaction with no tools. The mood sets a `[TONE]` note and which reactions are suggested (a random 5 from that mood's set each turn, `MOOD_EMOJI`). Jev's tool picks are advice (below). If Jev is down: no picks, text reply, every tool still offered.
5. **Tools: answer first.** The tool choice is always `auto`: nothing is forced, neither Jev's picks nor a reaction. Tools come in two kinds (`LOOKUP_TOOLS` and `isLookup` in `src/agent/tools/index.js`). Lookups only read: web, image, news, video and wiki search, search by image, `web_fetch`, `research`, history, notes, reminders list, `how_i_work`, commands and model info, server and member info, every GitHub MCP read. Actions do something: react, polls, cards, threads, notes, reminders, music, rules, `self_fix`, model, private mode, GitHub writes. A turn with words starts with the action tools Jev picked, `more_tools` (the enum names every other action tool the sender may use, Oscar-only ones only to Oscar; calling it adds them from the next round) and `need_more_info`, but no lookups. The model answers from the turn, the recent messages, the attachments and what it knows; if it is confident it just answers, in one call with no tools, and never looks something up to double-check (the system prompt says so in general terms, and that a lookup result never outweighs what the model can see itself unless it is clearly about the same thing). Only when it doesn't know enough (something live or current, a page, older messages, a fact it is unsure of) does it call `need_more_info` with what is missing and the lookups to get it; those, with `web_search` and `web_fetch`, open for the next round, and `more_tools` may then add lookups too. A lookup called before that is dropped, and `more_tools` can't open one. So a lookup costs one extra call, the "I don't know" step. With Jev down every action tool the sender may use is offered, and lookups still go through `need_more_info`. A reaction-only turn gets just Jev's picks and `react`; if the model writes words instead of reacting, the first suggested emoji is added and nothing is said, with no extra call. A turn is at most five model calls (`MAX_MODEL_CALLS`): up to four rounds of tool calls (run in parallel, results capped at 12,000 characters each), then the answer with no tools; any round may answer in words instead, which ends the turn. `react` is offered until Panda has reacted. Every reaction (the tool, the 👋 wave, the 👀 fallback) goes through `reactOnce` (`src/discord/reactions.js`): at most one per message, the first one asked for wins, and a failed one is not retried or swapped for another.
6. **Sending.** The reply starts with a small `-# 🔧 tools used` line (`react` is never listed; a reaction-only turn sends no text) and ends with a `-# 📥 in · 📤 out · 💸 cost · ⏱️ total · 🧠 model` line (input and output tokens and cost of the turn's model calls, from OpenRouter's usage, then the turn's total and model time), text over 2,000 characters is split cleanly (`src/discord/chunk.js`), and bare links are wrapped in `<>`. A response is mandatory: with nothing to say Panda reacts 👀. Afterwards the batch and reply are saved to the context store.
7. **Stopping.** "@Panda stop" (or `cancel`, `abort`, `nvm`, "stop it"…; pinged, replied to Panda, or naming it: "panda, stop") as the whole message aborts the sender's batches in that channel, running or queued; Oscar's aborts everyone's there. Who sent it is the authenticated Discord id; other channels are untouched. The turn lets go of the queue at once, its model calls are aborted (every call inside it, tools' and `/research`'s included, reads the turn's signal, `turnSignal` in `openrouter.js`, and is never retried), tools the model asked for after the stop don't start, and its reply, embeds and remaining chunks are not sent. Panda answers "⏹️ Stopped": what already happened (sent messages, reactions, notes, reminders, a tool already running) is not undone, and a `self_fix` is outside the turn's signal, so its Approve / Cancel card stays the only way to start or drop it. With nothing of theirs running, the message is handled as usual ("stop" may mean the music).
8. **Bots.** Conversations with other bots continue until a sign-off ("bye!"), then Panda reacts 👋 and ignores unpinged bot lines in that channel until a human speaks; a bot's ping or reply is still answered (or waved at, if it's another bye).

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

**Rules (`RULES.md`).** Oscar's standing rules ("remember…", "never answer X", "be meaner", "answer everything with a joke") live in `RULES.md` at the repo root (`RULES_FILE` moves it, e.g. under `data/` in Docker so it survives redeploys), one `- ` line each under `## Rules`. `add_rule` appends one and `remove_rule` deletes one by its number or text (both Oscar only, `src/agent/rulesFile.js`); writes are serialized and atomic. The system prompt reads the file on every turn and lists the rules, numbered, above `identity.md` and `soul.md`, so a change applies from the next message. A rule to stay silent is followed by answering `[NO REPLY]`, which sends nothing at all, not even the sign-off wave.

## Memory: context, notes and reminders

Everything is stored in one PMS Postgres database (`DATABASE_URL`). `src/db.js` applies `src/schema.sql` at boot. Without it, chat works but there are no prompts, context, notes or reminders, and private mode starts OFF and can't be toggled.

**Private mode** (`src/privateMode.js`) is one row in db-1's `pms` table (`id = 1`, `enabled`). It is read at boot, before Panda logs in, so it survives restarts and redeploys. `/private` and `private_mode` (Oscar only) save the new value first and only then flip the in-memory state the message handler checks, so the change applies to the very next message and the two never disagree. A failed save changes nothing and the reply says so. A database that is down at boot is logged and leaves private mode OFF.

**Storage budget** (`src/storage.js`): of the 1 GiB, persona gets 10 MB and the rest splits 75% context, 20% notes, 5% reminders. When a section is full, Panda DMs Oscar with **Delete oldest** / **Not now** and refuses new writes to it until trimmed.

**Context (hidden).** Panda keeps no summary or transcript, only per-channel message rows that feed the model. DMs are never saved. Everything else Panda sees is saved, after the reply is out: each turn, its reply and the 5 messages before it, everything `fetch_history` and `index_chat` read, and whole channels (below).
- `fetch_history`: *range* mode reads the channel straight from Discord (default 30, max 100 messages). *Search* mode takes a list of words and phrases (`query`) and a list of people (`author`) and returns every saved message from this channel that contains any of the words or phrases (full-text, so "plan" finds "plans", or as plain text, so names, numbers and links match) and, when authors are given, was sent by any of them. There is no Jev filter. Results are shown with what was searched, oldest first under a heading per day; if they don't fit in the 12,000-character tool result, the best-ranked are shown and the rest counted. When nothing matches, the whole channel is indexed and the search runs again; if it still finds nothing, the model is told so plainly and not to guess.
- **Channel indexing** (`src/discord/indexChannel.js`, also `/index_channel` for Oscar) copies a channel's history into the store. `context_channels` records how far it got (newest and oldest message saved, and whether it reached the first message), so a run reads only what is new since the last one, then carries on back from where that one stopped. A search-triggered run is capped at 20,000 messages or 60 s per turn; the next miss continues it.
- `index_chat`: given a message link or id, reads the 100 messages around it and remembers them. Other channels must be in this server and readable by the asker.

**Notes (shared).** Everyone sees every note (`src/agent/notes.js`, `src/discord/notes.js`).
- `/save_note [minutes]` reads the last 10 minutes (Jev trims past 60,000 characters). The model writes a title, description and Markdown summary, then files it in a nestable folder tree (or `Unsorted`) and may link up to 3 related notes.
- Finding notes (`search_notes`, `/open_note`): Jev walks the folder tree, then notes are ranked by full-text and title similarity. `/open_note` tries exact title, then similar title, then the search.
- Panda can write notes and files itself (`create_note`): a text note shown as a card, or a file (.txt, .md, .csv or any text file) sent as an attachment, or both. Either way it is stored in the `notes` table (a file keeps its `file_name`, its text is the body), filed into the tree like any note and counted in the notes storage budget. `send_note_file` (and `/open_note` for a file note) sends a saved note back as an attachment.
- `/display_notes` browses the tree, split over as many pages as it takes; `/delete_note` is for the author or Oscar, after a confirm button.

**Reminders** (`src/reminders.js`). `/add_reminder <name> <repeat> <when> [timezone]`; repeat is once, daily, weekly or monthly. Times are stored as UTC and repeats are recomputed in the creator's timezone, so daylight saving can't shift them. Every 30 s due reminders are posted in the channel they were made in, pinging the creator (`channel_id`); one made in a DM, made before channels were saved, or whose channel is gone or unwritable goes by DM instead. Ones missed while down go out once, marked late. `/delete_reminder`: creator or Oscar.

## Models: OpenRouter and Jev

Every model call uses one OpenRouter key (`src/agent/openrouter.js`), retried on network errors, 429s, 5xx and 60 s of silence. Only real API errors fail a turn.

| Role | Used for |
|------|----------|
| **Conversation** model | Chat, `/research`, `set_rule`, `self_fix` commit titles |
| **Claude Code** | The code change in `self_fix` |
| **Jev** (`typesafe/jev-1.13`) | Fast yes/no and pick-one decisions |

`/set_model <model> [provider]` (Oscar) validates the id against OpenRouter's catalog and saves it in `bot_settings`, live at once and kept across restarts. The optional provider (e.g. `deepinfra`) pins that model to one OpenRouter provider (`provider: { order: [slug], allow_fallbacks: false }`); it is checked against the model's endpoints and refused if OpenRouter doesn't route the model there. Providers are saved per model id as JSON in the `model_providers` row; a blank provider, or no row at all, sends no provider field, so OpenRouter routes as it always has. `/model` shows the model and provider, and `/model <model>` posts OpenRouter's info on any model as a card (`src/agent/tools/modelInfo.js`, through `send_card`); `/usage` shows spend.

## Jev: the decision layer

Jev decides; the conversation model writes. The model never chooses whether to answer, whether to react, what to remember or which notes folder to open. Tool picks are the exception: Jev's say which tools are offered, and the model calls only those it needs (or adds one with `more_tools`). Plain code applies Jev's answers: tool picks, lookups and memory use fixed thresholds; the social calls (whether to chime in, react or talk) are sampled from Jev's probabilities so Panda varies like a person. Jev ignores a `temperature` field (0 and 2 return the same numbers), so `sampleChoice` / `sampleYes` in `jev.js` apply it.

`decide(config, state, questions)` in `src/agent/jev.js` sends named text `state` and named `questions` in one call (~0.2 s). Answers are probabilities: `noul` (yes, 0–1) or `choice` (a probability per option). The model is pinned because the thresholds were tuned to 1.13. `decide` returns `null` when `JEV_ENABLED=false`, the key is missing, the call fails or takes over 5 s, and every caller then falls back to its non-Jev behavior, so an outage never breaks a turn.

| Decision | Asked when | Bar | Jev off or down |
|----------|-----------|-----|-----------------|
| Gate (`forPanda`) | Server message that isn't a ping or reply | follow-up to Panda or addressed ≥ 0.8 → talk (a message that only names Panda included); else react sampled (never < 0.5); bots the same | Silence |
| Bot sign-off | Every bot message | ≥ 0.8 → 👋, stop | Farewell regex |
| Triage | Every turn | sign-off ≥ 0.8; tool ≥ 0.5 (offered, not forced); unexplained ≥ 0.8; form sampled (owed words ≥ 0.5 → text or both); mood = most likely | No picks, every tool offered, text reply |
| Memory scan (`pickRelevant`) | Long `/save_note` windows | line ≥ 0.5 | Keep nothing |
| Source files (`how_i_work`) | A question about Panda with a topic | file ≥ 0.5, best 3 | Files whose path has a topic word |
| Notes walk | `search_notes`, `/open_note` | folder ≥ 0.25 (max 6 levels, 8 folders) | Search every note |
| Research fact-check | Each page read by `/research` | drop claim < 0.3 | Keep every claim |

Bars follow which mistake costs more: the gate talks only when Jev is fairly sure, because butting into chatter is worse than missing a chance, but reacts more freely, since an emoji costs nobody anything; tools are loose because an extra tool is cheap; folders are wide so near-miss filing is still found; research drops a claim only when Jev is fairly sure its quote doesn't support it.

**Threads** are channels of their own to the message handler: Panda reads and answers in them, people and bots alike, exactly as in a channel. It joins every new thread (`ThreadCreate`) and the active ones at boot (`src/discord/threads.js`), since Discord only delivers a thread's messages reliably to its members, and the system prompt names the thread and its parent channel.

**Privacy:** the gate means Jev sees every server message Panda can read, with the 2 before it. `JEV_ENABLED=false` stops that.

## Tools

| Tool | What it does |
|------|--------------|
| `get_user_id` / `get_message_sender` | Find a member's id; who sent a message |
| `server_info` | Read-only server overview, channels, roles, events, members, emojis, threads (hidden channels left out) |
| `create_thread` / `send_to_thread` | Open a thread (in this channel, another one, a forum, or off the message being answered; optionally private) and post a message in it / post in an existing thread (**Oscar only**) |
| `react` | React with one emoji (at most one Panda reaction per message, `src/discord/reactions.js`) |
| `create_poll` / `send_card` | Post a poll / an embed card with buttons and dropdown |
| `web_search` / `web_fetch` / `image_search` / `video_search` / `news_search` / `wiki_search` | SearXNG: web search (bing, falling back to yahoo then mojeek); read a public page; images (google images): `count` is the most to return, 3 by default and up to 10, set by the model or the user's ask; the model puts the image links bare in its reply and Discord shows the pictures under it (the handler keeps those links unwrapped through `invocation.imageUrls`), with a `send_card` card only when asked; one dedicated engine each for videos (youtube), news (bing news), wiki (wikipedia) |
| `reverse_image_search` | Search by image, also `/reverse_image_search`: takes an attachment's number from `[ATTACHMENTS]` (the handler keeps their links in `invocation.attachmentUrls`) or an image URL, and returns the search engine's best guesses at what it shows plus up to 15 pages carrying matching pictures, each with its image. SearXNG's `yandex reverse` engine, Panda's own (`searxng/engines/yandex_reverse.py`, copied into SearXNG's engine folder by `searxng/Dockerfile` and `scripts/ensure-searxng.sh`). Yandex, because Google Lens builds its results with JavaScript, so a plain HTTP engine gets nothing from it, and SearXNG's TinEye engine is refused by TinEye |
| `fetch_history` / `index_chat` | Read or search older messages |
| `search_notes` / `save_note` | Find saved notes / save the recent chat as one |
| `create_note` / `send_note_file` | Write a new note or a file (.txt, .md, …), save it in the notes and post it as a card or attachment / send a saved note back as a file |
| `list_notes` / `open_note` / `delete_note` | List notes / open one / post the same Delete–Keep confirmation as `/delete_note` (nothing is deleted until the author or Oscar clicks) |
| `add_reminder` / `show_reminders` / `delete_reminder` | Reminders for the sender, as the slash commands; a name matching several reminders deletes nothing and asks which |
| `research` | The `/research` pipeline and report |
| `panda_commands` | List the slash commands or explain one, read live from `src/discord/commandDefs.js` |
| `model_info` | Any OpenRouter model's id, name, description, input / output price (per token and per 1M), context, max output, architecture, supported parameters and providers (only what differs per provider), as `/model <model>`. Reads OpenRouter's public `/models`, `/models/{id}` and `/models/{id}/endpoints` with no API key; an id, a bare model name or a display name matches exactly, otherwise the best fuzzy match is used only when clearly ahead, else it suggests the closest. Never switches models |
| `current_model` / `usage` | The conversation model and provider running now (read from the runtime config, as `/model`) plus Jev's model / spend, as `/usage` |
| `how_i_work` | Read this file and the source files on GitHub that answer a topic (Jev picks up to 3; long files cut to the lines around the topic) |
| `play_music` | play / skip / pause / resume / stop / queue / now playing |
| `sandbox` | Run Python, JavaScript or bash in the channel's own PMS Cloud sandbox and read the exit code, stdout and stderr; `send_files` posts files the code made. Anyone may use it. The same as `/sandbox`; see [The scripting sandbox](#the-scripting-sandbox-sandbox) |
| GitHub MCP tools | Every GitHub read (**Oscar only**) |
| `github` | GitHub REST writes only (**Oscar only**) |
| `self_fix` / `set_rule` | Change Panda's code / rewrite `soul.md` (**Oscar only**) |
| `add_rule` / `remove_rule` | Add / remove one of Oscar's standing rules in `RULES.md` (**Oscar only**) |
| `set_model` / `private_mode` | Switch the model / private mode, as `/set_model` and `/private` (**Oscar only**) |

"Oscar only" is checked in code against the sender's Discord user id.

Every slash command reaches chat through the tool in `COMMAND_TOOLS` (`src/agent/tools/commands.js`), which calls the same functions the command does, or is gated there with the reason (`/index_channel` and `/clear`: Oscar runs them himself). The command definitions live once in `src/discord/commandDefs.js`, with `OWNER_ONLY_COMMANDS`; tests hold the map to the full command list and the owner-only commands to `OWNER_ONLY_TOOLS`. Before a tool runs, `executeTool` checks the owner gate, then the arguments against the tool's own schema (required, type, enum); bad arguments or unreadable JSON run nothing and tell the model what to fix. An empty result is reported as empty, so the model can't fill it in.

Slash commands: music (`/play /skip /pause /resume /stop /queue`), skills (`/research /web_search /web_fetch /image_search /reverse_image_search /video_search /news_search /wiki_search /create_poll /create_card /sandbox`), notes (`/save_note /display_notes /open_note /delete_note`), reminders (`/add_reminder /show_reminders /delete_reminder`), info (`/menu /usage /model`), Oscar only (`/set_rule /self_fix /set_model /private /index_channel /clear`). `/clear <number|all>` (`src/discord/clear.js`) checks Panda has View Channel, Read Message History and Manage Messages in the channel and says it can't if not; messages under 14 days old are bulk deleted 100 at a time, older ones one by one.

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

The bot watches via the GitHub MCP server, enables auto-merge and waits. The merge to main triggers the deploy (under `run.sh`, exit code 42 pulls and restarts). The run is in the background, so Panda keeps answering meanwhile; only a second self-fix is refused until it lands (or 50 min pass). While it runs Panda shows Idle with a "Currently fixing myself" status. Otherwise its custom status shows private mode: "🔒 Private mode: ON" (Do Not Disturb) or "🔓 Private mode: OFF" (Online) (`src/presence.js`). The status is set at login, once the saved private mode is loaded, and again on every toggle. A failed presence update is logged and never breaks the command.

## The scripting sandbox (`/sandbox`)

Not the development sandbox above: `self_fix` changes Panda's own code through an approved PR, while this runs scripts that anyone in the server writes (or asks Panda to write) on PMS Cloud, and never touches Panda's code, environment or secrets.

- **Where:** `src/agent/tools/sandbox.js` (the `sandbox` tool, `runSandbox` shared with `/sandbox`, and `killPandaSandboxes`). PMS sandboxes are E2B-compatible, so it uses the `e2b` SDK with explicit PMS options. Each is 0.5 vCPU and 512 MiB with internet access; the account allows 4 running at once.
- **Template:** `scripts/build-sandbox-template.mjs` builds `panda-sandbox` once, by hand (`PMS_SANDBOX_TOKEN=pms_... node scripts/build-sandbox-template.mjs`): Python 3 (numpy, pandas, matplotlib, requests), Node.js, git, curl, jq. A sandbox starts from it in about 3 seconds; commands run as `user` in `/home/user`.
- **One per channel,** kept in memory and given 10 more minutes on every run (so its files last 10 minutes after the last run); an ended one is replaced. A fifth channel is told all 4 are in use. At boot `killPandaSandboxes` stops the ones left from before the restart (metadata `app: panda`).
- **A run** (`language`, `code`, optional `files` to write first and `send_files` to post in the channel) is validated, then gets 60 seconds, and is stopped at 1 MB of output. The model gets `[SANDBOX — …]` with the last 5,000 characters of stdout and of stderr. The sandbox is given no environment, so the code sees no secret.
- **Use:** anyone. `/sandbox [language]` opens a form for the code and replies with the output; in chat the model calls the tool. It needs `PMS_SANDBOX_TOKEN`, else Panda says it isn't set up (`PMS_SANDBOX_TEMPLATE` renames the template).

## Safety

- Owner checks use the Discord user id, never names or claims; so does a stop (a guest stops only their own turns).
- Security rules live in the code's system prompt, so they hold even when the database is down.
- Credentials are only used in auth headers and the database connection; `redactSecrets` (`src/config.js`) strips their values from tool results and outgoing messages.
- `index_chat` only reads channels the asker can read; `web_fetch` refuses loopback, LAN, link-local and metadata addresses on every lookup and redirect.
- Every GitHub read goes through the read-only MCP endpoint; the only REST calls are writes.
- One GitHub token: `GITHUB_PAT` in the bot, `GH_PAT` in Actions.
- `/set_model` only saves model ids and provider names made of safe characters.

## Running and deploying

**Settings** beyond the keys: `BATCH_WINDOW_MS` (the batch window, default 1500), `JEV_ENABLED`, `ALLOW_BOTS`, `BOT_NAME`, `SEARXNG_URL`, `GITHUB_MCP_ENABLED` (see `src/config.js`).

**Logs** time every turn without its content: `[panda] turn stages`: time waited (window and queue), reading context, attachments, the agent, sending; `[agent …]` lines: prep and Jev time, then per model call its time, tools offered and tokens in / out, per round the tools' time, and the turn's total calls and tokens.

**Evaluating.** `node scripts/eval-turns.js [--runs 5] [--cases photo,screenshot,skyline,receipt,live-fact,chat]` runs real turns (model and Jev, no Discord) and prints per-case median / p95 latency, model calls, prompt tokens, tools offered and pass rate. Copy it into a checkout of another version to compare the two on the same model.

`npm start` runs `run.sh`: a private SearXNG (installed by `scripts/ensure-searxng.sh` with `uv`, loopback only, never blocks boot), then the bot under a supervisor (exit 42 → pull and restart, crash → restart after 3 s, exit 0 → stop). `npm run start:once` skips the supervisor; `npm test` runs the tests.

Every push to `main` builds and publishes the `panda-bot` and `panda-searxng` Docker images (`.github/workflows/docker.yml`). Production runs on PMS Cloud containers (project `oscars-discord-bot`) with `SEARXNG_URL=http://panda-searxng:8080`; they have no disk, so YouTube cookies go in as `YT_COOKIES_B64` and `/app/data` resets on restart (private mode is in the database, so it is kept). The CI deploy step currently fails behind Cloudflare, so deploy by hand: `pms container edit <name> --image <image>:<sha>`. To self-host, use `docker-compose.deploy.yml` with a volume on `/app/data`. Always set `DATABASE_URL`.

## Project layout

```
src/index.js              boot, intents, slash-command registration
src/discord/              message handler, slash commands, embeds, chunking
src/agent/                agent.js (triage, tools, answer), jev.js, prompts.js, historyStore.js, notes.js
src/agent/tools/          every tool the model can call
src/agent/research/       the /research pipeline
scripts/eval-turns.js     live turn evaluation (latency, calls, tokens, tool use)
scripts/build-sandbox-template.mjs  builds the PMS sandbox template for /sandbox (run once by hand)
src/db.js, schema.sql     Postgres connection and tables
src/storage.js            section budgets and cleanup
src/reminders.js          reminder times and scheduler
src/music/                discord-player + yt-dlp streaming
.github/                  Docker build + deploy, CI tests, the development sandbox
```

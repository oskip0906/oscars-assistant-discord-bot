# How Panda works

This is a compact guide to Panda’s runtime. For the command list, see the [README](README.md). Panda’s `how_i_work` tool reads this file and relevant source files to explain itself; update this guide when behavior changes.

## Message flow

1. **Decide whether to answer.** Pings, replies to Panda, and DMs are direct triggers. Jev checks other server messages for a likely response or a notable reaction. DMs are not saved. Private mode drops messages from anyone except Oscar before they are saved or evaluated. “@Panda stop” cancels the sender’s active and queued turns; Oscar can stop everyone’s turns in that channel.
2. **Batch and build context.** Messages from the same sender are grouped briefly, then handled in channel order. A turn includes the request, recent messages, server and user details, saved rules and prompts, and available attachments. Voice turns use their own queue, a shorter grouping window and no reasoning, so they answer faster than text.
3. **Triage and answer.** Jev picks the response form, mood, and likely tools. The conversation model writes the reply. It starts with the tools Jev picked, lookups included; other lookups are made available when it asks for missing information. Tool calls run with validated arguments and owner checks, and the same call is never run twice in a turn.
4. **Reply and save.** Panda sends its answer and any requested reactions or cards, then saves the turn and recent context. Long replies are split to fit Discord.

Threads go through the same message flow as channels. Interactive card buttons and menus are acknowledged, then handled as requests from the person who clicked them.

## Prompts and memory

The system prompt is built in `src/agent/systemPrompt.js`. `identity.md` sets behavior and boundaries; `soul.md` holds the personality. Oscar can update the personality with `/set_rule`. Standing rules are stored in `RULES.md` and loaded each turn.

Postgres stores prompts, private-mode state, message context, notes, and reminders. DMs are not saved. Panda can search readable channel history, index older messages, and save shared notes from conversations. Notes can also contain text files; the author or Oscar can edit or delete them. Reminders support one-time and recurring schedules, calculated in the creator’s timezone.

## Models and Jev

Conversation calls use OpenRouter. The configured model handles chat, research, and personality updates. Jev is a separate, fast decision model for whether to join a conversation, how to respond, and which tools may help. If Jev is unavailable, the bot uses its fallback behavior and remains available.

Reasoning is off by default. Calls retry transient failures and can fall back to a configured general model when the request has no attachments. Oscar can change the model and optionally pin a provider with `/set_model`; `/model` and `/usage` report model details and spending.

## Tools

The model can use tools for Discord, web research, memory, notes, reminders, music, and self-knowledge. It can also create polls, cards, and threads. The source of truth for slash command definitions is `src/discord/commandDefs.js`; most commands share their implementation with a chat tool.

| Area | Capabilities |
|------|--------------|
| Discord | Read server, member, and message details; react; create threads, polls, and interactive cards. |
| Web | Search web, images, reverse images, videos, news, and Wikipedia; read public pages. |
| Memory | Search readable chat history, index messages, search and manage notes, and query saved data. Database queries are read-only and Oscar-only. |
| Reminders and music | Create, edit, list, or delete reminders; control playback and the queue. |
| Oscar-only | Read or write GitHub, manage standing rules and model settings, and toggle private mode. |

Owner-only tools check the authenticated Discord user ID. Tool arguments are checked against each tool’s schema before execution. GitHub reads use a read-only MCP connection; GitHub writes use the bot’s authenticated API.

## Research

`/research` runs a staged pipeline: plan research questions, search and read sources, extract claims with quotes, check that the quotes support the claims, then write a cited report. Deep mode can run additional searches to fill gaps.

| Depth | Pages | Time limit |
|-------|-------|------------|
| `quick` | Up to 8 | 90 seconds |
| `normal` | Up to 16 | 4 minutes |
| `deep` | Up to 32 | 10 minutes |

## Voice

`/voice join` connects to the caller’s voice channel. PMS speech services transcribe what people say, route transcripts through the normal message flow, and read Panda’s short reply aloud one sentence at a time: PMS's `thunder` model only returns a clip once all of it is made, so the next sentence is made while the current one plays. Thunder ignores the `voice` field and picks a speaker for each request from `instructions`, so a fixed description that names the gender and age keeps every sentence in the same voice. It keeps listening while speaking; people can interrupt it, and `deafen` pauses transcription. In private mode, guests’ speech is not transcribed. Voice requires `PMS_AI_KEY` and Discord channel permissions. Music and voice cannot use the same server connection.

## Code sandbox

`/sandbox` runs Python, JavaScript, or bash in an isolated PMS Cloud sandbox. It is available to everyone, has internet access, and receives no bot secrets. Runs have a time and output limit; created files can be posted back to the channel. The sandbox template is built by `scripts/build-sandbox-template.mjs`.

## Safety and deployment

- Owner checks use Discord IDs. Private mode and the system prompt enforce access and behavior even when a request claims otherwise.
- Secrets are redacted from tool results and outgoing messages. Web fetch blocks local and private network addresses, including redirects.
- History tools only read channels the asker can access; database queries are read-only and restricted to Oscar.
- `npm start` runs the supervisor and bot; `npm run start:once` starts one process. `DATABASE_URL` is required for persistent prompts, memory, notes, reminders, and private-mode state.
- Pushes to `main` build the Docker images. Production uses PMS Cloud; `docker-compose.deploy.yml` is available for self-hosting.

## Project layout

```text
src/discord/       message handling, commands, and Discord UI
src/agent/         prompt, triage, model calls, and tool implementations
src/agent/research/ research pipeline
src/voice/         voice capture, transcription, and playback
src/music/         music playback
src/db.js          database connection and schema setup
scripts/           research evaluation and sandbox template build
.github/           image build and deployment workflows
```

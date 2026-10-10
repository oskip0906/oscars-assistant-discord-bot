# How Panda works

How panda-bot turns a message into a reply, and how its memory, models, tools, research, sandbox and safety work. For a quick overview, see the [README](README.md).

Panda's `how_i_work` tool reads this file to answer questions about itself. If you change how the bot works, update this file too.

## How a message becomes a reply

The flow lives in `src/discord/messageHandler.js` and `src/agent/agent.js`.

**1. Does Panda answer?**
- **Always:** an @-ping, or a reply to one of Panda's messages.
- **Maybe:** a message that says "Panda", "assistant", "bot" or "Oscar's" without a ping. **Jev** (below) decides whether it is speaking to Panda, or whether Panda should step in. If not, Panda stays silent and saves nothing.
- **Never:** DMs. In private mode, anyone but Oscar gets a fixed "I am in a private conversation with Oscar right now." While a self-fix runs, people get a fixed "rebuilding my own source code" message, once each.

**2. Batching (3 seconds).**
The first trigger opens a **3-second batch** for that sender. Everything they send in those 3 seconds joins it, ping or not, and the timer does not reset. Another person's trigger opens their own batch behind it.
- Each channel processes batches one at a time, in order. At most **5** wait; more are dropped as spam.
- Batches are also serialized per server, since all channels of a server share one memory.
- Panda replies to the **last** message of the batch, treating the batch as one turn.

**3. Building the prompt.**
- **System prompt** (`src/agent/systemPrompt.js`): tone, Discord formatting, react-or-reply rules, tool routing, security rules, and the persona files in `context/`.
- **Long-term summary** of this server, if there is one.
- **The turn:** only the batch, labelled `[RESPOND TO THIS]`. No earlier messages and no transcript.
- **Context on demand.** If the turn leans on something said before ("as I said", "that one", a thread that started earlier), the model calls `fetch_history` to read as far back as it needs. A self-contained question gets no history at all.
- Every message is written as `Name (@username, id:NNN): text`, so the model knows who said what and can ping anyone with `<@id>`.
- **Attachments** (`src/discord/attachments.js`) go to the model for this turn only: images (if the model accepts them, up to 5 MB), PDFs, text and code files (up to 200 KB), Tenor/Giphy GIF frames, and the picture a message replies to.

**4. Jev triage.**
Every turn starts with one Jev call (`triage` in `src/agent/agent.js`). It asks all of its questions at once, and code applies the answers in this order:
1. **For Panda?** Only asked of mention-only messages; a ping or reply skips it. Not addressed and no reason to step in (both < 0.8): silence, nothing saved.
2. **Sign-off?** (≥ 0.8) Panda reacts 👋 and the turn ends with no model call.
3. **Is a tool needed** (≥ 0.5), and **which one first** (≥ 0.8)? Jev picks some tool even for "thanks", so a pick only counts when it also says a tool is needed. `react` is never picked here; step 4 decides it. If the tool is Oscar-only and the sender isn't Oscar, the turn stops with "Only Oscar can use `<tool>`."
4. **Reaction, message, or both?**
   - **Reaction:** the model has to make a tool call (`tool_choice: required`) until it has reacted. It can look things up first and react several times in one step. The turn ends at the first successful reaction, so the model never gets to add "Got it". Needs Jev at ≥ 0.8, since a wrong "reaction only" would leave a question unanswered.
   - **Message:** the model doesn't get the `react` tool, so it can only answer in text.
   - **Both:** the same, but the turn goes on after the reaction and the model answers in text.

Any answer Jev is unsure of, or a Jev outage, leaves that decision to the model. The exception is step 1: there a mention-only message gets no answer.

**5. The agent loop.**
The model is called with all tools, except as step 4 above says. Jev's tool, if any, is forced on the first call. Each tool call is executed and its result fed back (capped at 12,000 characters) until the model answers in plain text or hits the tool-call limit (default 12). A reply after a reaction that has no letters or digits (usually the same emoji echoed back) is dropped.

**6. Sending the reply.**
- Reactions are already on the message by now, one or several.
- Tool embeds (image results) go first, then the text. Text over Discord's **2,000-character** limit is split into several messages (`src/discord/chunk.js`), at a paragraph, line, sentence or word break, in that order of preference, with code fences closed and reopened so each part renders.
- Bare links are wrapped in `<>` so they don't unfurl; image URLs stay bare.
- A response is mandatory: with no text and no reaction, Panda reacts 👀.
- The batch and the reply are saved to the message database after sending.

**7. Bot-to-bot conversations.**
They run for as long as the other bot keeps going, and end on a sign-off ("bye!", "have a great day"): Panda reacts 👋 instead of replying, then ignores bots in that channel until a human speaks. Bot sign-offs are checked per message, before batching: Jev decides, with a regex as the fallback. Human sign-offs are caught by the triage in step 4.

## Memory

Each server has its own memory, shared by its channels.

**Summary** (`src/agent/memory.js`, stored in `data/context/<serverId>.json`).
- Every turn becomes an **exchange**: the question and Panda's final answer. Tool results and narration are dropped. A turn whose model call fails still keeps its question.
- After **10** exchanges, the conversation model folds them into a summary of at most **1,500 characters**: people, decisions, facts, preferences, open tasks, promises. Greetings and bot pleasantries are dropped.
- The summary goes into every prompt. Folding runs after the reply is sent; if it fails, the exchanges wait for next time.

**Message database** (Supabase Postgres, `src/agent/historyStore.js`, schema in `supabase/discord_history.sql`). Optional; without it nothing is stored.
- Every batch message and every Panda reply is saved, keyed by message id. `/index_chat` (Oscar) saves a whole channel.
- The table has row-level security on and no policies, so only the bot's secret key can use it.

**`fetch_history`** has two modes:
- **Range** (no `query` or `author`): reads this channel straight from Discord, back from the message being answered. `count` messages (default 30, max 100) after skipping the `skip` most recent (max 500). Panda's own replies are marked `(you)`. Doesn't need the database.
- **Search** (`query`, `author`, or server scope): searches the database. Messages are grouped into conversations split at 30-minute gaps. A keyword query returns the 3 best-matching conversations (20 messages before each hit, 10 after); `author` keeps conversations where that person spoke; server scope with no query returns the 3 most recent.

**Persona files.** `context/IDENTITY.md`, `SOUL.md` and `USER.md` set who Panda is and what may be shared about Oscar.

**Forgetting.** `/clear` / `clear_context` wipes this server's summary; `/clearall` / `clear_all_context` wipes every server. Oscar only. The database is untouched.

## Models: OpenRouter and Jev

Every model call goes through one OpenRouter key (`src/agent/openrouter.js`), retried up to 3 times on network errors, 429s and 5xx.

| Role | Used for |
|------|----------|
| **Conversation** model | Chat replies, memory summaries, `/research` |
| **Development** model | `self_fix` / `/run_dev`: the sandbox agent and commit messages |
| **Jev** (`typesafe/jev-1.13`) | Fast yes/no and pick-one decisions |

`/set_model` and `/set_dev_model` (Oscar) switch models; `/model` shows the current one; `/usage` shows OpenRouter spend.

**Jev** (`src/agent/jev.js`) returns probabilities instead of text, in about 0.2 s. Panda uses it to:
1. **Triage every turn** (step 4 of "How a message becomes a reply"). One call answers:
   - for mention-only messages, whether Panda is addressed or should step in (≥ 0.8);
   - whether the message is a sign-off (≥ 0.8);
   - whether a tool is needed (≥ 0.5), and which tool to call first (≥ 0.8), including whether it is Oscar-only;
   - whether to respond with a reaction (≥ 0.8), a text message, or both.
2. **Detect sign-offs from other bots**, per message, including "aight gn" or other languages.
3. **Fact-check research**: drop claims whose quote likely doesn't support them (< 0.3).

Jev only sees messages that trigger Panda. Calls time out after 5 s. If Jev is off or down:
- Panda doesn't answer mention-only messages.
- The model decides tools and react/reply on its own.
- Bot sign-offs use the regex.
- All research claims are kept.

## Tools

| Tool | What it does |
|------|--------------|
| `get_user_id` / `get_message_sender` | Find a member's or bot's id; who sent this message |
| `react` | React with an emoji, one or several (Jev decides whether text follows) |
| `web_search` / `web_fetch` | Search via SearXNG; read a public page |
| `image_search` | Up to 3 images, shown as embeds |
| `fetch_history` | Read further back in the channel, or search older conversations |
| `how_i_work` | Read this file |
| `play_music` | play / skip / pause / resume / stop / queue / now playing |
| GitHub MCP tools | Read-only GitHub (**Oscar only**) |
| `github` | GitHub REST API with Oscar's token (**Oscar only**) |
| `create_pr` / `self_fix` | Development tasks ending in a PR (**Oscar only**) |
| `clear_context` / `clear_all_context` | Wipe memory (**Oscar only**) |

"Oscar only" is checked in code against the sender's Discord user id, never against what the message says.

## Slash commands

- **Music:** `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`
- **Skills:** `/research <query> [quick|normal|deep]`, `/web_search`, `/web_fetch`, `/image_search`
- **Info:** `/menu`, `/usage`, `/model`
- **Oscar only:** `/clear`, `/clearall`, `/index_chat`, `/self_fix`, `/run_dev`, `/set_model`, `/set_dev_model`, `/private on|off|status`, `/github`

## Deep research

`/research` (`src/agent/research/`) is a fixed pipeline: code decides what to read and drop; the model answers one narrow question at a time.

1. **Plan** sub-questions, each with a search query, and **search** them in parallel.
2. **Pick and read** pages (no repeats, 1–2 per domain, 8 at once).
3. **Extract claims** with word-for-word quotes. Code checks the quote is on the page; Jev checks it supports the claim.
4. **Fill gaps** with rewritten queries for sub-questions that found nothing.
5. **Write** one section per sub-question, then a direct answer, with numbered sources.

| Depth | Sub-questions | Max pages | Gap rounds | Time limit |
|-------|---------------|-----------|------------|------------|
| `quick` | 3 | 8 | 0 | 90 s |
| `normal` | 5 | 16 | 0 | 4 min |
| `deep` | 5 | 32 | 2 | 10 min |

If nothing could be verified, the report says so.

## The development sandbox (`self_fix`, `/run_dev`, `create_pr`)

These never edit the running bot.

1. **Approval.** Panda posts an Approve / Cancel card. Only Oscar's click starts anything, and it waits as long as needed.
2. **Dispatch.** `.github/workflows/development-sandbox.yml` clones the target repo into a throwaway Actions runner.
3. **Agent loop.** The development model uses `list_files`, `read_file`, `write_file`, `delete_file`, `finish` and read-only GitHub MCP tools. It must read before writing, can't touch `.git`, `node_modules`, `data/`, `.env` or `.github/`, and has at most 40 steps.
4. **Verify.** `node --check`, import resolution, `npm ci`, `npm test`, then a `panda-dev-*` branch and a PR.

`self_fix` (Panda's own repo) enables auto-merge, waits for the merge, then exits with code 42 so the supervisor pulls and restarts. Others get the "rebuilding" message meanwhile; the lock frees itself after 30 min. `/run_dev` / `create_pr` return once the PR is open, and Oscar merges by hand.

## Safety

- Owner checks use the sender's Discord user id, never names or claims.
- `web_fetch` refuses loopback, LAN, link-local and cloud-metadata addresses, on every DNS lookup and redirect.
- GitHub MCP uses GitHub's read-only endpoint.
- `/set_model` only writes safe model-id characters to `.env`, atomically.

## Running and deploying

`npm start` runs `run.sh`: it starts a local SearXNG container, then the bot under a supervisor (exit 42 → pull and restart, crash → restart after 3 s, exit 0 → stop). `npm run start:once` runs it without the supervisor; `npm test` runs the tests.

Every push to `main` builds a Docker image and publishes it to Docker Hub (`.github/workflows/docker.yml`). `docker-compose.deploy.yml` runs the bot and SearXNG together; mount a volume on `/app/data` so summaries and the private-mode flag survive restarts.

## Project layout

```
src/index.js              boot, intents, slash-command registration
src/discord/              message handler (batching), slash commands, embeds, chunking
src/agent/agent.js        the tool-calling loop and Jev triage
src/agent/contextStore.js summary storage
src/agent/memory.js       exchanges → summary
src/agent/historyStore.js Supabase message database
src/agent/jev.js          Jev decision calls
src/agent/tools/          every tool the model can call
src/agent/research/       the /research pipeline
src/music/                discord-player + yt-dlp streaming
context/                  persona files read into the system prompt
supabase/                 database schema
.github/                  Docker build and the development sandbox
```

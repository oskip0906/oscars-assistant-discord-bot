# How Panda works

How panda-bot turns a message into a reply, and how its prompts, history, models, tools, research, sandbox and safety work. For a quick overview, see the [README](README.md).

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
- Batches are also serialized per server, since turns there share server-wide state such as the music queue.
- Panda replies to the **last** message of the batch, treating the batch as one turn.

**3. Building the prompt.**
- **System prompt** (`src/agent/systemPrompt.js`): only what can't live in Supabase: today's date, server, channel, sender and owner id, the private-mode note, how the input is laid out, and the security rules. Then the two prompt files from Supabase, `identity.md` and `soul.md` (see "Prompts" below).
- **The turn:** the batch, labelled `[RESPOND TO THIS]`, under `[RECENT MESSAGES]`: the 20 messages just before it in the channel (each cut to 500 characters, Panda's own marked `(you)`). That is how "that", "it" or "the bug" get resolved, by the model and by Jev. No transcript, no summary.
- **Older context.** Anything further back is only read when Jev picks `fetch_history` (search older conversations) or `index_chat` (the messages around one specific old message, from a reply or a link).
- Every message is written as `Name (@username, id:NNN): text`, so the model knows who said what and can ping anyone with `<@id>`. A reply also shows the message it replies to, with that message's id.
- **Attachments** (`src/discord/attachments.js`) go to the model for this turn only: images (if the model accepts them, up to 5 MB), PDFs, text and code files (up to 200 KB), Tenor/Giphy GIF frames, and the picture a message replies to.

**4. Jev triage.**
Every turn starts with one Jev call (`triage` in `src/agent/agent.js`). It asks all of its questions at once, and code applies the answers in this order:
1. **For Panda?** Only asked of mention-only messages; a ping or reply skips it. Not addressed and no reason to step in (both < 0.8): silence, nothing saved.
2. **Sign-off?** (≥ 0.8) Panda reacts 👋 and the turn ends with no model call.
3. **Which tools?** One yes/no per tool, read with the recent messages, so several can be picked at once. A tool runs only at ≥ 0.5: plain chat scores every tool under that, and a clear request scores the right one well above it. `react` is never asked about; step 4 decides it. If a picked tool is Oscar-only and the sender isn't Oscar, the turn stops with "Only Oscar can use `<tool>`."
4. **Reaction, message, or both?** Reaction needs Jev at ≥ 0.8, since a wrong "reaction only" would leave a question unanswered. Reaction and both add `react` to the picked tools.

Any answer Jev is unsure of means no tools and a text reply; a Jev outage means the same. The exception is step 1: there a mention-only message gets no answer.

**5. Running the tools.**
The model never chooses tools; it only fills in arguments. A turn is at most two model calls:
1. **Tool call** (only if Jev picked any): the model is offered just the picked tools (`tool_choice: required`) and calls the ones that help, all in one reply. A call to anything else is ignored. They all run at once, except reactions, which run in order. Results are capped at 12,000 characters. A reaction-only turn ends here, so the model never gets to add "Got it".
2. **Answer:** the model writes the reply from the results, with no tools it can call (`tool_choice: none`). There is no second round of tools. A reply after a reaction that has no letters or digits (usually the same emoji echoed back) is dropped.

**6. Sending the reply.**
- Reactions are already on the message by now, one or several.
- The first message of a text reply starts with the tools the turn called, as small grey subtext: `-# 🔧 web_search ×2 · send_card`. A turn with no tools has no line. A reply that is only a reaction, poll or card has no text to carry the line.
- Tool embeds (image results) go first, then the text. Text over Discord's **2,000-character** limit is split into several messages (`src/discord/chunk.js`), at a paragraph, line, sentence or word break, in that order of preference, with code fences closed and reopened so each part renders.
- Bare links are wrapped in `<>` so they don't unfurl; image URLs stay bare.
- Polls and cards (below) are posted by their tools before the answer is written, so they land before the text.
- A response is mandatory: with no text, no reaction and no poll or card, Panda reacts 👀. After a poll or card, a reply with no words is dropped: the poll or card is the answer.

**Discord UI.** Panda can post UI on its own when it reads better than text (`src/agent/tools/ui.js`). `identity.md` says when.
- `create_poll`: a native Discord poll with 2–10 answers, open 1–768 hours (default 24), single or multi-choice. Discord counts the votes.
- `send_card`: an embed box with a title, text, up to 25 fields, an image and a footer. Under it go up to 5 buttons and an optional dropdown of 2–25 choices.
  - A button with a url is a **link button**.
  - Buttons without one, and the dropdown, are **clickable**. Their ids start with `ui:`.
- **A click is a message.** The click is acknowledged at once, because Discord allows 3 seconds. It then goes through the message handler as a message from whoever clicked: `[clicked "Spicy miso ramen"]`, replying to the card, whose title the model sees. So a click gets the same batching, Jev triage, owner checks (against the clicker) and private mode as typed text, and the answer goes out as a follow-up to the click. Anyone who can see the card can click it.
- Both tools check their input first (answer counts, http(s) links, button and choice limits). They hand Discord's own validation errors back to the model to fix, and pass everything they send through `redactSecrets`.
- The batch and the reply are saved to the message database after sending.

**7. Bot-to-bot conversations.**
They run for as long as the other bot keeps going, and end on a sign-off ("bye!", "have a great day"): Panda reacts 👋 instead of replying, then ignores bots in that channel until a human speaks. Bot sign-offs are checked per message, before batching: Jev decides, with a regex as the fallback. Human sign-offs are caught by the triage in step 4.

## Prompts

Everything that tells the model who Panda is and how to behave lives in **Supabase Storage**, in the private bucket `prompts` (`src/agent/prompts.js`, bucket created by `supabase/prompts.sql`). The repo holds no prompt text beyond the short system prompt, the Jev triage questions, the task prompts of `/research`, `self_fix` commit messages, the dev sandbox and `set_rule`, and slash-command text.

| File | What it holds | Who changes it |
|------|---------------|----------------|
| `identity.md` | Who Panda is; Oscar as owner and master; what may be shared about Oscar; boundaries; Discord rules; how to use each tool | Nobody from Discord. Edit it in the Supabase dashboard. |
| `soul.md` | Personality: vibe, tone, attitude, how to react and reply, how to handle other bots | Oscar, with `set_rule` |
| `history/soul-<time>.md` | Every `soul.md` that `set_rule` replaced | Written by `set_rule` |

- Both files are read with the bot's Supabase secret key and cached for **60 seconds**, so a dashboard edit is live within a minute, with no deploy.
- If Supabase can't be reached, the bot keeps the last copy it loaded. If it never loaded one, it runs on the system prompt alone (which still carries the security rules) and logs an error.
- When the two files disagree, `identity.md` wins.

**`set_rule`** (tool and `/set_rule <instruction>`, **Oscar only**). It changes Panda's personality for good. When Oscar says to behave differently from now on ("stop using emojis", "be more sarcastic"), the model calls it with his words.
1. It reads the current `soul.md` and `identity.md` fresh from Supabase. If either can't be read, nothing changes.
2. The **development** model rewrites `soul.md` with the instruction applied, touching nothing else, and with `identity.md` given only as reference.
3. The old `soul.md` is saved to `history/` first, then the new one is written. An empty or unchanged result writes nothing.
4. The change applies from the next message on.

## History

Panda keeps no summary and no transcript. What was said before is read on demand.

**Message database** (Supabase Postgres, `src/agent/historyStore.js`, schema in `supabase/discord_history.sql`). Optional; without it nothing is stored.
- Every batch message and every Panda reply is saved, keyed by message id.
- `/index_chat` (Oscar) saves a whole channel. It only **adds** messages that aren't stored yet; a saved message is never overwritten. It still reads the whole channel from Discord each time.
- The table has row-level security on and no policies, so only the bot's secret key can use it.

**`fetch_history`** has two modes:
- **Range** (no `query` or `author`): reads this channel straight from Discord, back from the message being answered. `count` messages (default 30, max 100) after skipping the `skip` most recent (max 500). Panda's own replies are marked `(you)`. Doesn't need the database.
- **Search** (`query`, `author`, or server scope): searches the database. Messages are grouped into conversations split at 30-minute gaps. A keyword query returns the 3 best-matching conversations (20 messages before each hit, 10 after); `author` keeps conversations where that person spoke; server scope with no query returns the 3 most recent.

**`index_chat`** (the tool; anyone can trigger it) is for one specific old message Panda hasn't seen: someone replies to it, links it, or points at it.
- It takes a message link, or an id in this channel, and reads the **50** messages around that message straight from Discord, oldest first, with the message itself marked.
- It saves the ones not stored yet, the same add-only way as `/index_chat`. If the database is down, it still shows them.
- Another channel must be in this server, and the person asking must be able to read its history. Panda can see channels they can't. A DM can only reach itself.

## Models: OpenRouter and Jev

Every model call goes through one OpenRouter key (`src/agent/openrouter.js`), retried without limit on network errors, 429s, 5xx and silence: an attempt with no answer after 60 s is sent again (each retry waits 60 s longer), so one stuck call can never freeze the bot. Only real API errors (bad key, unknown model) fail the turn.

| Role | Used for |
|------|----------|
| **Conversation** model | Chat replies, `/research` |
| **Development** model | `self_fix`: the sandbox agent and commit messages; `set_rule`: rewriting `soul.md` |
| **Jev** (`typesafe/jev-1.13`) | Fast yes/no and pick-one decisions |

`/set_model` and `/set_dev_model` (Oscar) switch models; `/model` shows the current one; `/usage` shows OpenRouter spend.

**Jev** (`src/agent/jev.js`) returns probabilities instead of text, in about 0.2 s. Panda uses it to:
1. **Triage every turn** (step 4 of "How a message becomes a reply"). One call answers:
   - for mention-only messages, whether Panda is addressed or should step in (≥ 0.8);
   - whether the message is a sign-off (≥ 0.8);
   - which tools to run, one yes/no each (≥ 0.5), including whether one is Oscar-only;
   - whether to respond with a reaction (≥ 0.8), a text message, or both.
2. **Detect sign-offs from other bots**, per message, including "aight gn" or other languages.
3. **Fact-check research**: drop claims whose quote likely doesn't support them (< 0.3).

Jev only sees messages that trigger Panda. Calls time out after 5 s. If Jev is off or down:
- Panda doesn't answer mention-only messages.
- No tools run, and the model answers in text.
- Bot sign-offs use the regex.
- All research claims are kept.

## Tools

| Tool | What it does |
|------|--------------|
| `get_user_id` / `get_message_sender` | Find a member's or bot's id; who sent this message |
| `react` | React with an emoji, one or several (Jev decides whether text follows) |
| `create_poll` | Post a native Discord poll |
| `send_card` | Post an embed card, with link buttons, clickable buttons or a dropdown |
| `web_search` / `web_fetch` | Search via SearXNG; read a public page |
| `image_search` | Up to 3 images, shown as embeds |
| `fetch_history` | Read further back in the channel, or search older conversations |
| `index_chat` | Read and save the messages around one old message |
| `how_i_work` | Read this file |
| `play_music` | play / skip / pause / resume / stop / queue / now playing |
| GitHub MCP tools | Read-only GitHub (**Oscar only**) |
| `github` | GitHub REST API with Oscar's token (**Oscar only**) |
| `self_fix` | Change Panda's own code through a merged PR (**Oscar only**) |
| `set_rule` | Change Panda's personality (`soul.md`) for good (**Oscar only**) |

"Oscar only" is checked in code against the sender's Discord user id, never against what the message says.

## Slash commands

- **Music:** `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`
- **Skills:** `/research <query> [quick|normal|deep]`, `/web_search`, `/web_fetch`, `/image_search`
- **Info:** `/menu`, `/usage`, `/model`
- **Oscar only:** `/set_rule`, `/index_chat`, `/self_fix`, `/set_model`, `/set_dev_model`, `/private on|off|status`, `/github`

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

Each source is cited as a masked link with no `<>` around it, so Discord shows its preview card under the message. Research is the one place where previews stay on; links in chat replies are still wrapped in `<>`.

## The development sandbox (`self_fix`)

`self_fix` is the only way Panda changes code, and only its own repo. It never edits the running bot.

1. **Approval.** Panda posts an Approve / Cancel card. Only Oscar's click starts anything, and it waits as long as needed.
2. **Dispatch.** `.github/workflows/development-sandbox.yml` clones the target repo into a throwaway Actions runner.
3. **Agent loop.** The development model uses `list_files`, `read_file`, `write_file`, `delete_file`, `finish` and read-only GitHub MCP tools. It must read before writing, can't touch `.git`, `node_modules`, `data/`, `.env` or `.github/`, and has at most 40 steps.
4. **Verify.** `node --check`, import resolution, `npm ci`, `npm test`, then a `panda-dev-*` branch and a PR.

`self_fix` enables auto-merge and waits for the merge. The merge to main triggers the CI deploy, which restarts Panda on the fix; under `run.sh` it also exits with code 42 so the supervisor pulls and restarts. Others get the "rebuilding" message meanwhile; the lock frees itself after 30 min.

## Safety

- Owner checks use the sender's Discord user id, never names or claims.
- The security rules live in the system prompt in code, so they hold even when Supabase is down.
- Nobody can get a credential by asking, Oscar included. The Discord token, OpenRouter key, GitHub token and Supabase key are only ever used in auth headers, so the model never sees them. On top of that, `redactSecrets` (`src/config.js`) strips their exact values from every tool result before the model reads it, and from every message Panda sends.
- `index_chat` only reads channels of this server that the person asking can read.
- `web_fetch` refuses loopback, LAN, link-local and cloud-metadata addresses, on every DNS lookup and redirect.
- GitHub MCP uses GitHub's read-only endpoint.
- `/set_model` and `/set_dev_model` only commit safe model-id characters to `src/models.json`.

## Running and deploying

`npm start` runs `run.sh`: it starts a private SearXNG, then the bot under a supervisor (exit 42 → pull and restart, crash → restart after 3 s, exit 0 → stop). `npm run start:once` runs it without the supervisor; `npm test` runs the tests.

**Local search needs no Docker.** Before every bot start, `scripts/ensure-searxng.sh` makes sure a SearXNG answers on `SEARXNG_URL` (loopback only):
- **First start:** it fetches SearXNG at a pinned commit into `searxng/src` and installs it into `searxng/.venv` with `uv`, which also fetches Python 3.12 if needed. Later starts reuse the install; bumping the pinned `ref` reinstalls.
- **Running:** SearXNG runs as a Python process bound to `127.0.0.1` only, even though `settings.yml` says `0.0.0.0` for the deploy container. Its log is `searxng/searxng.log`.
- **Lifetime:** `run.sh` stops it when the bot stops (`searxng/searxng.pid`), and the next start brings up a fresh one. A SearXNG that was started some other way and is already answering is used and left running.
- **Failures:** it never blocks or fails the boot. Without `uv`, or after a failed install, the bot starts without search and the next start tries again.

Every push to `main` builds a Docker image and publishes it to Docker Hub (`.github/workflows/docker.yml`). `docker-compose.deploy.yml` runs the bot and SearXNG together; mount a volume on `/app/data` so the private-mode flag and the dev-run log survive restarts. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: without them Panda runs with no prompts and no history.

## Project layout

```
src/index.js              boot, intents, slash-command registration
src/discord/              message handler (batching), slash commands, embeds, chunking
src/agent/agent.js        Jev triage, one round of tools, the answer
src/agent/prompts.js      identity.md / soul.md from Supabase Storage
src/agent/historyStore.js Supabase message database
src/agent/jev.js          Jev decision calls
src/agent/tools/          every tool the model can call
src/agent/research/       the /research pipeline
src/music/                discord-player + yt-dlp streaming
supabase/                 database schema and the prompts bucket
.github/                  Docker build and the development sandbox
```

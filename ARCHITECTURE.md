# How Panda works

How panda-bot turns a message into a reply, and how its prompts, memory (context, notes, reminders), models, Jev decisions, tools, research, sandbox and safety work. For a quick overview, see the [README](README.md).

Panda's `how_i_work` tool reads this file to answer questions about itself. If you change how the bot works, update this file too.

## How a message becomes a reply

The flow lives in `src/discord/messageHandler.js` and `src/agent/agent.js`.

**1. Does Panda answer?**
- **Always:** an @-ping, or a reply to one of Panda's messages.
- **Maybe:** every other message, with no keyword filter (`forPanda` in `src/discord/messageHandler.js`). **Jev** (below) reads it with only the 2 messages before it, to keep the call small, and says yes (≥ 0.8) only if it speaks to Panda directly (by name, as Oscar's assistant, or as the bot) or answers or follows up on what Panda just said. Passing mentions, people talking to each other, a "lol" or "thanks" that needs nothing back, and questions nobody put to Panda are a no. A no means silence, and nothing is saved. Panda's own messages are never checked.
- **Never:** DMs. In private mode, anyone but Oscar gets a fixed "I am in a private conversation with Oscar right now." While a self-fix runs, people get a fixed "rebuilding my own source code" message, once each.

**2. Batching (3 seconds).**
The first trigger opens a **3-second batch** for that sender. Everything they send in those 3 seconds joins it, ping or not, and the timer does not reset. Another person's trigger opens their own batch behind it.
- Each channel processes batches one at a time, in the order their triggers were **sent**, not the order their Jev checks came back. Two sent in the same millisecond go in a random order. At most **10** wait, held in memory (a restart drops them); more are dropped as spam, before Jev is asked.
- Batches are also serialized per server, since turns there share server-wide state such as the music queue.
- Panda replies to the **last** message of the batch, treating the batch as one turn.

**3. Building the prompt.**
- **System prompt** (`src/agent/systemPrompt.js`): only what can't live in the database: today's date, server, channel, sender and owner id, the private-mode note, how the input is laid out, and the security rules. Then the two prompt files from the database, `identity.md` and `soul.md` (see "Prompts" below).
- **The turn:** the batch, labelled `[RESPOND TO THIS]`, under `[RECENT MESSAGES]`: the 10 messages just before it in the channel (each cut to 500 characters, Panda's own marked `(you)`). That is how "that", "it" or "the bug" get resolved, by the model and by Jev. No transcript, no summary.
- **Older context.** Anything further back is only read when Jev picks `fetch_history` (search what was remembered, then the last 1000 messages if nothing was), `search_notes` (the saved notes) or `index_chat` (the messages around one specific old message, from a reply or a link). Jev also picks `fetch_history` on its own when the turn refers to something nothing shown explains (step 4).
- Every message is written as `Name (@username, id:NNN): text`, so the model knows who said what and can ping anyone with `<@id>`. A reply also shows the message it replies to, with that message's id.
- **Attachments** (`src/discord/attachments.js`) go to the model for this turn only: images (if the model accepts them, up to 5 MB), PDFs, text and code files (up to 200 KB), Tenor/Giphy GIF frames, and the picture a message replies to.

**4. Jev triage.**
Every turn starts with one Jev call (`triage` in `src/agent/agent.js`); by then step 1 has settled that it is for Panda. It asks all of its questions at once, and code applies the answers in this order:
1. **Sign-off?** (≥ 0.8) Panda reacts 👋 and the turn ends with no model call.
2. **Which tools?** One yes/no per tool, read with the recent messages, so several can be picked at once. A separate question asks whether the turn refers to something neither it nor the recent messages explain ("are you excited for the event" with no event in sight). At ≥ 0.8 that adds `fetch_history`, and the model is told to search with the key words, so the answer comes from what was said earlier instead of "which event?". A tool runs only at ≥ 0.5: plain chat scores every tool under that, and a clear request scores the right one well above it. `react` is never asked about; step 3 decides it. If a picked tool is Oscar-only and the sender isn't Oscar, the turn stops with "Only Oscar can use `<tool>`."
3. **Reaction, message, or both?** Reaction needs Jev at ≥ 0.8, since a wrong "reaction only" would leave a question unanswered. Reaction and both add `react` to the picked tools.

Any answer Jev is unsure of means no tools and a text reply; a Jev outage means the same.

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

After sending, the batch and the reply are saved to the context store (see "Memory").

**7. Bot-to-bot conversations.**
They run for as long as the other bot keeps going, and end on a sign-off ("bye!", "have a great day"): Panda reacts 👋 instead of replying, then ignores bots in that channel until a human speaks. Bot sign-offs are checked per message, before batching: Jev decides, with a regex as the fallback. Human sign-offs are caught by the triage in step 4.

## Prompts

Everything that tells the model who Panda is and how to behave lives in **the database** (PMS Postgres db-1), table `prompts` (`src/agent/prompts.js`, schema in `src/schema.sql`). The repo holds no prompt text beyond the short system prompt, the Jev triage questions, the task prompts of `/research`, `self_fix` commit messages, the dev sandbox and `set_rule`, and slash-command text.

| File | What it holds | Who changes it |
|------|---------------|----------------|
| `identity.md` | Who Panda is; Oscar as owner and master; what may be shared about Oscar; boundaries; Discord rules; how to use each tool | Nobody from Discord. Edit the row in the database (`pms db connect db-1`, then `psql`). |
| `soul.md` | Personality: vibe, tone, attitude, how to react and reply, how to handle other bots | Oscar, with `set_rule` |
| `history/soul-<time>.md` | Every `soul.md` that `set_rule` replaced | Written by `set_rule` |

- Both files are cached for **60 seconds**, so an edit in the database is live within a minute, with no deploy.
- If the database can't be reached, the bot keeps the last copy it loaded. If it never loaded one, it runs on the system prompt alone (which still carries the security rules) and logs an error.
- When the two files disagree, `identity.md` wins.

**`set_rule`** (tool and `/set_rule <instruction>`, **Oscar only**). It changes Panda's personality for good. When Oscar says to behave differently from now on ("stop using emojis", "be more sarcastic"), the model calls it with his words.
1. It reads the current `soul.md` and `identity.md` fresh from the database. If either can't be read, nothing changes.
2. The **development** model rewrites `soul.md` with the instruction applied, touching nothing else, and with `identity.md` given only as reference.
3. The old `soul.md` is saved to `history/` first, then the new one is written. An empty or unchanged result writes nothing.
4. The change applies from the next message on.

## Memory: context, notes and reminders

Everything Panda stores lives in one PMS Postgres database, **db-1** in project `oscars-discord-bot` (`DATABASE_URL`). `src/db.js` applies `src/schema.sql` at every boot (every statement is `if not exists`). Without `DATABASE_URL` chat still works, but there are no prompts, context, notes or reminders.

**Storage budget** (`src/storage.js`). PMS gives the account 1 GiB. Persona gets a fixed 10 MB; the rest is split **75% context, 20% notes, 5% reminders**.
- A section's size is the bytes of its live rows (written out as text), so it drops as soon as rows are deleted. Indexes come on top.
- Sizes are checked at boot, every hour, and at most every 10 minutes after a write.
- When a section reaches 100%, Panda DMs Oscar once with **Delete oldest** / **Not now** buttons, and refuses new writes to that section until it is trimmed. Delete oldest removes the oldest rows (inactive reminders first) until the section is at 90%. Not now leaves it full and asks again an hour later.
- Persona is never trimmed or blocked; it only alerts.

### Context (hidden)

Panda keeps no summary and no transcript. `context_messages` is split by channel: each row is the Discord message id (so a re-save is a no-op), the server, channel and author ids, the text and when it was said. A search only reads the channel it is asked from. **DMs are never saved.** Nobody can list it; it only feeds the model.

What gets saved:
- **After every reply**, the turn's messages and Panda's reply, as they are. This happens after the reply is sent, so the database can never delay or break it.
- **`fetch_history` range reads** and **`index_chat`**: every message they read.
- **When a search finds nothing remembered** (see `fetch_history`), the last 1,000 messages of the channel are read from Discord, and Jev keeps only the lines relevant to the question (see "Jev"). With Jev off or down, that scan keeps nothing.

**`fetch_history`** has two modes:
- **Range** (no `query` or `author`): reads this channel straight from Discord, back from the message being answered. `count` messages (default 30, max 100) after skipping the `skip` most recent (max 500). Panda's own replies are marked `(you)`. Doesn't need the database.
- **Search** (`query` and/or `author`): full-text search over what was remembered in this channel, up to 40 lines, oldest first. `author` is a name (looked up among this server's members), a mention or an id. When nothing is remembered yet, the channel is searched as above.

**`index_chat`** (the tool; anyone can trigger it) is for one specific old message Panda hasn't seen: someone replies to it, links it, or points at it.
- It takes a message link, or an id in this channel, and reads the **100** messages around that message (about 50 each side) straight from Discord, oldest first, with the message itself marked. All are shown to the model and remembered. If the database is down, it still shows them.
- Another channel must be in this server, and the person asking must be able to read its history. Panda can see channels they can't. A DM can only reach itself.

### Notes (shared)

Anyone can save, browse and open notes, and everyone sees every note (`src/agent/notes.js`, views in `src/discord/notes.js`).
- **`/save_note [minutes]`** reads the channel's last 10 minutes (or `minutes`). Past 60,000 characters, Jev keeps the lines worth remembering first. The conversation model writes a title, a one-line description and an organized Markdown summary of everything discussed. A second call files it into the **folder tree** (folders can nest, like a knowledge graph): it sees the tree with each folder's description and the 5 closest existing notes, reuses a folder, adds a sub-folder or starts a new top-level one, and may link the note to up to 3 of those related notes. If it can't decide, the note goes to `Unsorted`.
- **Finding notes** (the `search_notes` tool, and `/open_note` when no title is close): Jev walks the tree from the top, one level at a time, going into every folder it rates ≥ 0.25 (at least its top pick), at most 6 levels and 8 folders. The notes in those folders and the notes linked to them are ranked by full-text match and title similarity. With Jev off, or when the walk finds nothing, every note is searched the same way.
- **`/open_note <title>`**: exact title (case-insensitive), then the most similar title (trigram similarity ≥ 0.3), then the search above. Long bodies continue in follow-up messages.
- **`/display_notes`**: the whole tree with counts when it fits, otherwise one folder at a time; a menu opens a folder or a note, and ⬆ Up goes back.
- **`/delete_note`**: the author or Oscar, after a confirm button. Folders left empty are removed.

### Reminders

`/add_reminder <name> <repeat> <when> [timezone]` (`src/reminders.js`). `repeat` is once, every day, every week or every month; `when` is `2026-10-20 18:30`, `18:30`, `mon 18:30` or `15 18:30` to match. The timezone is needed the first time (autocomplete lists IANA zones) and is remembered per user.
- Times are stored as UTC. Repeats are recomputed from their local time in the creator's timezone, so daylight saving can't shift them. Monthly on the 31st falls on the last day of shorter months.
- Every 30 s the bot DMs each due reminder to the person who made it. A one-off then ends, and a repeat moves to its next time. One that came due while the bot was down goes out once, marked late. A failed DM (closed DMs) is recorded and shown in `/show_reminders`.
- `/show_reminders` lists every active reminder with its creator, next time (Discord timestamps, so each viewer sees their own timezone) and repeat. `/delete_reminder`: the creator or Oscar.

## Models: OpenRouter and Jev

Every model call goes through one OpenRouter key (`src/agent/openrouter.js`), retried without limit on network errors, 429s, 5xx and silence: an attempt with no answer after 60 s is sent again (each retry waits 60 s longer), so one stuck call can never freeze the bot. Only real API errors (bad key, unknown model) fail the turn.

| Role | Used for |
|------|----------|
| **Conversation** model | Chat replies, `/research`, `set_rule`'s rewrite of `soul.md`, `self_fix` commit titles |
| **Claude Code** | The code change itself in `self_fix` (see "The development sandbox") |
| **Jev** (`typesafe/jev-1.13`) | Fast yes/no and pick-one decisions |

`/set_model` (Oscar) switches the conversation model, live at once; `/model` shows the current one; `/usage` shows OpenRouter spend. The id is checked against OpenRouter's catalog, then saved in the database (`bot_settings`, key `model`), and every boot loads it from there (`loadModel` in `src/discord/model.js`). No commit and no redeploy: the container's own disk resets on restart, the database doesn't. With no saved choice, or no database, Panda boots on the default in `src/config.js`.

Jev has its own section below: it makes every decision in Panda that code, not the conversation model, acts on.

## Jev: the decision layer

Panda splits thinking into two kinds. **Jev** decides; the **conversation model** writes. The model never chooses whether to answer, which tools run, whether to react, what to remember or which notes folder to open. Jev answers those, and plain code applies its answers with fixed thresholds. That is what keeps a turn at most two model calls and keeps the model from wandering off into tools nobody asked for.

### What a Jev call is

Jev (`typesafe/jev-1.13`) is a decision model on OpenRouter's decisions endpoint (`/api/alpha/decisions`), called with the same OpenRouter key. `decide(config, state, questions)` in `src/agent/jev.js` is the only way in. A call sends:
- **`state`**: named pieces of text, such as `message`, `recent_messages`, `sender`, `query`, or `m0` … `m24`.
- **`questions`**: named, typed questions whose instructions point at the state by name in backticks ("Is `message` meant for the assistant…?").

Jev answers every question at once, in about 0.2 s, with **probabilities instead of text**. Panda uses two question types:

| Type | Answer | Example |
|------|--------|---------|
| `noul` | a yes probability, `answers.q.noul` from 0 to 1 | "Should the assistant call `web_search`?" → 0.91 |
| `choice` | the top pick plus a probability per option, `answers.q.choice` / `answers.q.probabilities` | `respond_with`: reaction 0.12 · message 0.80 · both 0.08 |

Because the answer is a number, the caller picks the bar. The model is pinned (not `jev-latest`) because every threshold below was tuned against 1.13's probabilities; a new version means re-tuning them.

**Many questions, one call.** Where Panda needs several decisions about the same text, it packs them into one call: triage asks the sign-off, the response form, the unexplained-reference question and one yes/no per tool together; a memory scan puts 25 lines in as `m0` … `m24` with one `keep_mN` question each; a research page sends every claim and quote as `claim_i` / `quote_i`.

**Failure is always safe.** `decide` returns `null` when `JEV_ENABLED=false`, the key is missing, the call fails, or it takes longer than **5 s**. Every caller treats `null` (or a missing answer) as its pre-Jev behaviour, so a Jev outage changes what Panda does but never breaks a turn.

### Every decision Jev makes

| Where | Asked when | State | Question(s) | Bar | Jev off or down |
|-------|-----------|-------|-------------|-----|-----------------|
| **Gate** (`forPanda`, `messageHandler.js`) | Every server message that isn't a ping or a reply to Panda | `message`, the 2 messages before it, bot and owner names | `for_assistant` (noul) | ≥ 0.8 → answer | Silence: only pings and replies get answers |
| **Bot sign-off** (`signsOff`, `messageHandler.js`) | Every message from another bot | `message` | `bye` (noul) | ≥ 0.8 → wave 👋, stop talking to bots in that channel | The farewell regex |
| **Triage** (`triage`, `agent.js`) | Every turn, once | the batch, the 10 recent messages, sender (marked if Oscar), bot and owner names | `bye` (noul) | ≥ 0.8 → wave 👋, no model call | Not a sign-off |
| | | | `use_<tool>` (noul, one per tool but `react`) | ≥ 0.5 → offer that tool | No tools |
| | | | `unexplained` (noul) | ≥ 0.8 → add `fetch_history` and tell the model to search | No lookup |
| | | | `respond_with` (choice: reaction / message / both) | reaction needs ≥ 0.8; message or both just need to be the top pick | Text reply |
| **Memory scan** (`pickRelevant`, `historyStore.js`) | `fetch_history` search found nothing remembered; `/save_note` transcript over 60,000 characters | `focus` (the query) + 25 lines per call, 5 calls at once | `keep_mN` (noul): relevant to `focus`, or worth remembering | ≥ 0.5 → keep the line | Keep nothing (`fetch_history` says nothing matched; `/save_note` cuts the oldest lines instead) |
| **Notes walk** (`walkFolders`, `notes.js`) | `search_notes`, and `/open_note` when no title is close | `query` | `folder` (choice over up to 20 sibling folders, with descriptions) | go into every folder ≥ 0.25, or the top pick if none is; at most 6 levels and 8 folders | Full-text search over every note |
| **Research fact-check** (`supportedClaims`, `research/stages.js`) | Each page read by `/research`, after code has checked each quote is on the page | `claim_i`, `quote_i` | `supported_i` (noul): does the quote state or imply the claim? | < 0.3 → drop the claim | Keep every claim |

### Why the bars differ

Each bar is set by which mistake costs more:
- **Gate, 0.8:** a false yes means Panda butts into a conversation that wasn't for it; a false no costs only a ping. So it is tight.
- **Tools, 0.5:** an extra tool is cheap, since the model is told to call only the picked tools that help. Plain chat scores every tool under 0.5; clear requests score the right one 0.57–0.97.
- **Reaction only, 0.8:** a wrong "reaction only" leaves a real question unanswered. Message and both need no bar, since a text reply is the safe side.
- **Unexplained reference, 0.8:** references nothing shown explains score 0.90–0.97; plain chat ≤ 0.45; "fix that" right under the bug report 0.73, which should *not* search.
- **Folders, 0.25:** wide on purpose, so a note filed under a near-miss folder is still found; the 8-folder cap bounds the cost.
- **Research, < 0.3:** a claim is dropped only when Jev is fairly sure its quote doesn't back it, so borderline claims survive and the report isn't starved.

### One message through Jev

For a message that isn't a ping, Jev is asked up to three times before the conversation model sees anything:
1. **Gate:** is it for Panda? (A ping or a reply to Panda skips this.) No → silence, nothing saved.
2. **Bot sign-off**, only if a bot sent it: yes → 👋 and stop.
3. **Triage**, once the 3-second batch closes: sign-off → 👋; otherwise the tools to offer and the response form.

Then, only if triage picked them, tools may call Jev again: `fetch_history` runs a memory scan of up to 1,000 channel lines (40 calls, 5 at a time), and `search_notes` walks the notes tree. Jev reads text only: attachments go to the conversation model alone.

**Privacy:** the gate means Jev sees every message Panda can read in a server, with the 2 before it, so ordinary chatter does reach OpenRouter. `JEV_ENABLED=false` stops that, at the cost of everything in the "Jev off or down" column.

## Tools

| Tool | What it does |
|------|--------------|
| `get_user_id` / `get_message_sender` | Find a member's or bot's id; who sent this message |
| `server_info` | Read the server right now: overview, channels, roles, scheduled events, members, one user in detail, emojis and stickers, active threads. Read only. Channels, threads and events in channels the sender can't see are left out |
| `react` | React with an emoji, one or several (Jev decides whether text follows) |
| `create_poll` | Post a native Discord poll |
| `send_card` | Post an embed card, with link buttons, clickable buttons or a dropdown |
| `web_search` / `web_fetch` | Search via SearXNG; read a public page |
| `image_search` | Up to 3 images, shown as embeds |
| `fetch_history` | Read further back in the channel, or search what was remembered |
| `index_chat` | Read the messages around one old message, and remember the relevant ones |
| `search_notes` | Find the saved notes that answer a question |
| `how_i_work` | Read this file |
| `play_music` | play / skip / pause / resume / stop / queue / now playing |
| GitHub MCP tools | Every GitHub read: files, commits, issues, PRs, code search, Actions runs (**Oscar only**) |
| `github` | GitHub REST **writes only** (POST/PATCH/PUT/DELETE) with Oscar's token; it refuses reads (**Oscar only**) |
| `self_fix` | Change Panda's own code through a merged PR (**Oscar only**) |
| `set_rule` | Change Panda's personality (`soul.md`) for good (**Oscar only**) |

"Oscar only" is checked in code against the sender's Discord user id, never against what the message says.

## Slash commands

- **Music:** `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`
- **Skills:** `/research <query> [quick|normal|deep]`, `/web_search`, `/web_fetch`, `/image_search`, `/create_poll`, `/create_card`
- **Notes:** `/save_note`, `/display_notes`, `/open_note <title>`, `/delete_note <note>`
- **Reminders:** `/add_reminder <name> <repeat> <when> [timezone]`, `/show_reminders`, `/delete_reminder <reminder>`
- **Info:** `/menu`, `/usage`, `/model`
- **Oscar only:** `/set_rule`, `/self_fix`, `/set_model`, `/private on|off|status`, `/github` (lists Oscar's own repositories, read through the GitHub MCP server)

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
2. **Dispatch.** The bot starts `.github/workflows/development-sandbox.yml` with one REST call. The workflow checks out this repo on a throwaway Actions runner and creates a `panda-dev-*` branch.
3. **Claude Code.** The [Claude Code Action](https://github.com/anthropics/claude-code-action), signed in with Oscar's subscription token (`CLAUDE_CODE_OAUTH_TOKEN` secret), makes the change. It runs unattended with `--dangerously-skip-permissions` (never asks for permission) and `--permission-prompts none` (can't ask questions). It holds only a read-only GitHub token, so it can't push. It sees only the repo and the instruction, so the instruction must be self-contained. Its final message is printed in the run log.
4. **Verify.** The workflow fails if Claude changed nothing or touched `.git`, `node_modules`, `data/`, `.env` or `.github/`, then runs `npm test`. Only then does it commit (Claude's summary is the body), push and open the PR with `GH_PAT`, so the PR triggers `ci.yml`. A ruleset makes that `test` check required on `main`, so auto-merge waits for it.

While it runs, the bot watches it only through the GitHub MCP server (`actions` and `pull_requests` tools): the pull request for its branch, or the failed run and the step it died on. `self_fix` enables auto-merge and waits for the merge. If the bot restarts mid-run, the next boot looks the pull request up the same way and reports it. The merge to main triggers the CI deploy, which restarts Panda on the fix; under `run.sh` it also exits with code 42 so the supervisor pulls and restarts. Others get the "rebuilding" message meanwhile; the lock frees itself after 50 min.

## Safety

- Owner checks use the sender's Discord user id, never names or claims.
- The security rules live in the system prompt in code, so they hold even when the database is down.
- Nobody can get a credential by asking, Oscar included. The Discord token, OpenRouter key, GitHub token and database URL are only ever used in auth headers and the database connection, so the model never sees them. On top of that, `redactSecrets` (`src/config.js`) strips their exact values from every tool result before the model reads it, and from every message Panda sends.
- `index_chat` only reads channels of this server that the person asking can read.
- `web_fetch` refuses loopback, LAN, link-local and cloud-metadata addresses, on every DNS lookup and redirect.
- Every GitHub read, in chat and in code, goes through GitHub's read-only MCP endpoint (`/mcp/readonly`), so a read can never write. The only REST calls are writes: the sandbox dispatch and the `github` tool.
- There is one GitHub token: `GITHUB_PAT` in the bot, the `GH_PAT` Actions secret in CI (Actions secret names can't start with `GITHUB_`).
- `/set_model` only saves ids made of safe model-id characters.

## Running and deploying

`npm start` runs `run.sh`: it starts a private SearXNG, then the bot under a supervisor (exit 42 → pull and restart, crash → restart after 3 s, exit 0 → stop). `npm run start:once` runs it without the supervisor; `npm test` runs the tests.

**Local search needs no Docker.** Before every bot start, `scripts/ensure-searxng.sh` makes sure a SearXNG answers on `SEARXNG_URL` (loopback only):
- **First start:** it fetches SearXNG at a pinned commit into `searxng/src` and installs it into `searxng/.venv` with `uv`, which also fetches Python 3.12 if needed. Later starts reuse the install; bumping the pinned `ref` reinstalls.
- **Running:** SearXNG runs as a Python process bound to `127.0.0.1` only, even though `settings.yml` says `0.0.0.0` for the deploy container. Its log is `searxng/searxng.log`.
- **Lifetime:** `run.sh` stops it when the bot stops (`searxng/searxng.pid`), and the next start brings up a fresh one. A SearXNG that was started some other way and is already answering is used and left running.
- **Failures:** it never blocks or fails the boot. Without `uv`, or after a failed install, the bot starts without search and the next start tries again.

Every push to `main` builds two Docker images and publishes them to Docker Hub, tagged `latest` and with the commit sha (`.github/workflows/docker.yml`): the bot, and `panda-searxng`, a SearXNG with its settings baked in (`searxng/Dockerfile`).

**Production runs on PMS Cloud containers**, project `oscars-discord-bot`: `panda-bot` and `panda-searxng` (port 8080). The bot reaches search at `SEARXNG_URL=http://panda-searxng:8080`. PMS containers have no disk and no file mounts, so YouTube cookies go in as `YT_COOKIES_B64` and `/app/data` resets on every restart. After building, CI points both containers at the new sha with the `PMS_EMAIL` / `PMS_PASSWORD` secrets, since PMS has no API tokens. Cloudflare in front of `api.pmservers.org` currently blocks GitHub's runners, so that step fails and the deploy is done by hand: `pms container edit <name> --image <image>:<sha>`.

To self-host instead, `docker-compose.deploy.yml` runs the bot and SearXNG together; mount a volume on `/app/data` so the private-mode flag and the dev-run log survive restarts. Either way, set `DATABASE_URL`: without it Panda runs with no prompts, context, notes or reminders. On PMS it points at db-1's internal host.

## Project layout

```
src/index.js              boot, intents, slash-command registration
src/discord/              message handler (batching), slash commands, embeds, chunking
src/agent/agent.js        Jev triage, one round of tools, the answer
src/db.js, src/schema.sql the PMS Postgres connection and every table
src/storage.js            section budgets, the full-section alert and cleanup
src/agent/prompts.js      identity.md / soul.md from the database
src/agent/historyStore.js the hidden context store
src/agent/notes.js        notes: filing into the folder tree, the Jev walk
src/reminders.js          reminder times and the DM scheduler
src/agent/jev.js          Jev decision calls
src/agent/tools/          every tool the model can call; githubMcp.js is the one way code reads GitHub
src/agent/mcp.js          minimal MCP client (GitHub's hosted server)
src/agent/research/       the /research pipeline
src/music/                discord-player + yt-dlp streaming
.github/                  Docker build + PMS deploy, CI tests, the development sandbox
```

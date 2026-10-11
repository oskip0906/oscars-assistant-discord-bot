# panda-bot 🐼

**Oscar's** Discord AI agent, built from scratch with **Node.js** + **discord.js v14** and an **OpenRouter** tool-calling loop. No agent framework: batching, history, routing and safety are plain JavaScript in `src/`. Its prompts (`identity.md` and `soul.md`) live in Supabase Storage, not in the code.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- **Chat** when pinged, replied to, or mentioned by name.
- **Look back** when it needs more context: a searchable database of the messages it's part of, the channel itself, and the messages around any old message someone replies to or links (`index_chat`).
- **See** images, PDFs, text files and GIFs posted in the chat.
- **Search** the web and images through a private SearXNG, and read any public page.
- **Research** a question in depth and write a cited, fact-checked report (`/research`).
- **Play music** in voice channels.
- **Post polls and embed cards** with link buttons, clickable buttons and dropdowns, on its own when it fits; a click is answered like a message.
- **Read GitHub** through GitHub's read-only MCP server and **change its own code** behind an approval button (Oscar only).
- **Change its personality** for good when Oscar says so, in chat or with `/set_rule` (Oscar only).

How all of it works (message flow, prompts, history, models, tools, research, the sandbox, safety, deployment) is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.
<!-- sandbox smoke test -->

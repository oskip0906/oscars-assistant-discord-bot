# panda-bot 🐼

**Oscar's** Discord AI agent, built from scratch with **Node.js** + **discord.js v14** and an **OpenRouter** tool-calling loop. No agent framework: batching, history, routing and safety are plain JavaScript in `src/`. Its prompts (`identity.md` and `soul.md`) and everything it remembers live in a PMS Postgres database, not in the code.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- **Chat** when pinged, replied to, or mentioned by name.
- **Remember** what matters: after each reply it keeps only the lines worth remembering, and looks back through those, the channel itself, or the messages around any old message someone replies to or links (`index_chat`).
- **Take notes** anyone can save, browse and open: `/save_note` files an organized summary of the conversation into a folder tree, and `/display_notes`, `/open_note` and `/delete_note` work with them.
- **Remind** people by DM, once or every day, week or month, in their own timezone (`/add_reminder`, `/show_reminders`, `/delete_reminder`).
- **See** images, PDFs, text files and GIFs posted in the chat.
- **Search** the web and images through a private SearXNG, and read any public page.
- **Research** a question in depth and write a cited, fact-checked report (`/research`).
- **Play music** in voice channels.
- **Post polls and embed cards** with link buttons, clickable buttons and dropdowns, on its own when it fits; a click is answered like a message.
- **Read GitHub** through GitHub's read-only MCP server and **change its own code** behind an approval button (Oscar only).
- **Change its personality** for good when Oscar says so, in chat or with `/set_rule` (Oscar only).

How all of it works (message flow, prompts, memory, models, tools, research, the sandbox, safety, deployment) is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

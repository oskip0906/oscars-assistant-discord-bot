# panda-bot 🐼

**Oscar's** Discord AI agent, built from scratch with **Node.js** + **discord.js v14** and an **OpenRouter** tool-calling loop. No agent framework: batching, memory, routing and safety are plain JavaScript in `src/`.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- **Chat** when pinged, replied to, or mentioned by name.
- **Remember** each server: a running summary and a searchable message database, and read back through the channel on its own when it needs more context.
- **See** images, PDFs, text files and GIFs posted in the chat.
- **Search** the web and images through a private SearXNG, and read any public page.
- **Research** a question in depth and write a cited, fact-checked report (`/research`).
- **Play music** in voice channels.
- **Read GitHub** and **change its own code** behind an approval button (Oscar only).

How all of it works (message flow, memory, models, tools, research, the sandbox, safety, deployment) is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

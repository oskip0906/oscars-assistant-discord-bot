# panda-bot 🐼

**Oscar's** Discord AI agent, built from scratch with **Node.js** + **discord.js v14** and an **OpenRouter** tool-calling loop. No agent framework: batching, memory, routing and safety are plain JavaScript in `src/`.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- **Chat** when pinged, replied to, or mentioned by name.
- **Remember** each server: a recent transcript, a running summary, and a searchable message database.
- **See** images, PDFs, text files and GIFs posted in the chat.
- **Search** the web and images through a private SearXNG, and read any public page.
- **Research** a question in depth and write a cited, fact-checked report (`/research`).
- **Play music** in voice channels.
- **Read GitHub** and **change its own code** behind an approval button (Oscar only).

How all of it works (message flow, memory, models, tools, research, the sandbox, safety, deployment) is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Run it

Needs Node 22+ and Docker (for SearXNG).

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
npm start
```

Set at least `DISCORD_TOKEN` (with the Message Content intent on) and `OPENROUTER_API_KEY` in `.env`. Every other variable is optional and listed in [ARCHITECTURE.md](ARCHITECTURE.md#running-it).

`npm test` runs the tests.

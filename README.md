# panda-bot 🐼

**Oscar's** Discord AI assistant: a from-scratch agent that chats, remembers what matters, and can search, research, take notes, set reminders, play music, post polls and interactive cards, and — with Oscar's approval — change its own code.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## What it can do

- **Chat** when pinged or replied to, or when Jev judges a message is meant for it, such as a follow-up to what it just said.
- **Remember** what matters: after each reply it keeps only the lines worth remembering, and can look back through what it remembered, the channel itself, or the messages around any older message someone replies to or links.
- **Take notes** anyone can save, browse, open and delete; saved conversations are filed into a folder tree.
- **Remind** people by DM, once or on a repeating schedule, in their own timezone.
- **See** images, PDFs, text files and GIFs posted in the chat.
- **Search** the web and images through a private search backend, and read any public page.
- **Research** a question in depth and write a cited, fact-checked report.
- **Play music** in voice channels.
- **Post polls and embed cards** with link buttons, clickable buttons and dropdowns, on its own when it fits; a click is answered like a message.
- **Read and change its own code** behind an approval button (Oscar only).
- **Change its personality** for good when Oscar asks, in chat or through a command (Oscar only).

Everything else — how a message becomes a reply, the prompts, memory, models, tools, the research pipeline, the sandbox, safety, deployment, and the exact commands — lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

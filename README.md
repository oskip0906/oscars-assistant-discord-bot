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

## Commands

The same groups as `/menu`. Everything except the Power Tools also works by just asking in chat.

**🎵 Music**
| Command | What it does |
|---------|--------------|
| `/play <song>` | Play a song, or add it to the queue |
| `/skip` | Skip the current track |
| `/pause` · `/resume` | Pause / resume playback |
| `/stop` | Stop and clear the queue |
| `/queue` | See what's playing next |

**🧠 AI Skills**
| Command | What it does |
|---------|--------------|
| `/research <query> [quick\|normal\|deep]` | Deep research: plan, crawl, verify and report with sources |
| `/web_search <query>` | Search the web and cite links |
| `/web_fetch <url>` | Read a full page |
| `/image_search <query>` | Find pictures of anything |
| `/create_poll <question> <answers> [hours] [multiple]` | Post a native Discord poll; answers separated by `\|` |
| `/create_card <title> [description] [color] [url] [image] [thumbnail] [footer] [fields] [buttons] [menu]` | Post an embed card with optional buttons and a dropdown |

**📝 Notes**
| Command | What it does |
|---------|--------------|
| `/save_note [minutes]` | Save an organized summary of the last 10 minutes here (or longer), filed into folders |
| `/display_notes` | Browse every saved note, folder by folder |
| `/open_note <title>` | Open a note by its title, or the closest match |
| `/delete_note <note>` | Delete one of your notes (Oscar can delete any) |

**⏰ Reminders**
| Command | What it does |
|---------|--------------|
| `/add_reminder <name> <repeat> <when> [timezone]` | Get a DM once, or every day, week or month. `when`: `2026-10-20 18:30` · `18:30` · `mon 18:30` · `15 18:30` |
| `/show_reminders` | See every active reminder |
| `/delete_reminder <reminder>` | Delete one of your reminders (Oscar can delete any) |

**🛠️ Power Tools (Oscar only)**
| Command | What it does |
|---------|--------------|
| `/self_fix <instruction>` | Approve a sandboxed self-fix PR, then restart after it merges |
| `/set_model <model>` | Switch the conversation model (OpenRouter); saved in the database |
| `/set_rule <instruction>` | Change Panda's personality or behavior for good |
| `/private on\|off\|status` | Only respond to Oscar |

**📖 Info**
| Command | What it does |
|---------|--------------|
| `/menu` | Show the menu |
| `/usage` | How much money Panda has spent |
| `/model` | Which model Panda is running on |

## Tools

Beyond the slash commands, Panda calls these on its own while chatting (details in [ARCHITECTURE.md](ARCHITECTURE.md#tools)):

- **Discord:** look up members and message senders, read server info (channels, roles, events, emojis, threads), react with emoji, post polls and embed cards (link buttons, clickable buttons, dropdowns).
- **Web:** search the web and images, read any public page.
- **Memory:** read further back in a channel, search what it remembered, index the messages around an old one, and find saved notes.
- **Music:** play, skip, pause, resume, stop and show the queue.
- **Self-knowledge:** read ARCHITECTURE.md to explain how it works.
- **Oscar only:** read GitHub (files, commits, issues, PRs, code search, Actions runs), make GitHub writes such as issues and comments, change its own code through an approved `self_fix` PR, and change its personality with `set_rule`.

Everything else — how a message becomes a reply, how Jev makes Panda's decisions, the prompts, memory, models, tools, the research pipeline, the sandbox, safety and deployment — lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

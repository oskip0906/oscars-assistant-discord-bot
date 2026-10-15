# panda-bot 🐼

**Oscar's** Discord AI assistant: a from-scratch agent that chats, remembers what matters, and can search, research, take notes, set reminders, play music, post polls and interactive cards, and — with Oscar's approval — change its own code.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## Commands

The same groups as `/menu`. Everything also works by just asking in chat, except `/index_channel` and `/clear`; the Power Tools only for Oscar. Saying "@Panda stop" aborts your request that is still running or waiting (Oscar's, everyone's in that channel).

**🎵 Music**
| Command | What it does |
|---------|--------------|
| `/play <song>` | Play a song, or add it to the queue |
| `/skip` | Skip the current track |
| `/pause` · `/resume` | Pause / resume playback |
| `/stop` | Stop and clear the queue |
| `/queue` | See what's playing next |
| `/voice <join\|leave\|status>` | Talk with Panda in your voice channel: it transcribes what you say, answers in the channel's chat and reads the start of the answer aloud. Needs `PMS_AI_KEY`; music and voice don't share a server |

**🧠 AI Skills**
| Command | What it does |
|---------|--------------|
| `/research <query> [quick\|normal\|deep]` | Deep research: plan, crawl, verify and report with sources |
| `/web_search <query>` | Search the web and cite links |
| `/web_fetch <url>` | Read a full page |
| `/image_search <query>` | Find pictures of anything |
| `/reverse_image_search <image\|url>` | Search by image: pages with matching pictures, and what it likely shows |
| `/video_search <query>` | Find videos |
| `/news_search <query>` | Find recent news |
| `/wiki_search <query>` | Look something up on Wikipedia |
| `/create_poll <question> <answers> [hours] [multiple]` | Post a native Discord poll; answers separated by `\|` |
| `/create_card <title> [description] [color] [url] [image] [thumbnail] [footer] [fields] [buttons] [menu]` | Post an embed card with optional buttons and a dropdown |
| `/sandbox [python\|javascript\|bash]` | Run code in a Linux sandbox (one per channel, Python with numpy, pandas and matplotlib, Node.js, git, curl, jq, internet): a form opens for the code, and the output is posted. Ask in chat to also post files it made, like a chart |

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
| `/add_reminder <name> <repeat> <when> [timezone]` | Get pinged in the channel you set it in (a DM if set in DMs) once, or every day, week or month. `when`: `2026-10-20 18:30` · `18:30` · `mon 18:30` · `15 18:30` |
| `/show_reminders` | See every active reminder |
| `/delete_reminder <reminder>` | Delete one of your reminders (Oscar can delete any) |

**🛠️ Power Tools (Oscar only)**
| Command | What it does |
|---------|--------------|
| `/self_fix <instruction>` | Approve a sandboxed self-fix PR, then restart after it merges |
| `/set_model <model> [provider]` | Switch the conversation model (OpenRouter), optionally pinned to one provider; saved in the database |
| `/set_rule <instruction>` | Change Panda's personality or behavior for good |
| `/private on\|off\|status` | Only respond to Oscar. Saved in the database (db-1 `pms` table), so it survives restarts; Panda's status shows whether it is ON or OFF |
| `/clear <number\|all>` | Delete the newest messages in the channel, or `all` of them. Needs Panda to have **Manage Messages** (plus View Channel and Read Message History) there; otherwise it says it can't |

**📖 Info**
| Command | What it does |
|---------|--------------|
| `/menu` | Show the menu |
| `/usage` | How much money Panda has spent |
| `/model` | Which model Panda is running on |
| `/model <model>` | OpenRouter info for any model (name or id, fuzzy-matched): price per 1M tokens, context, max output, architecture, providers |

## Tools

Beyond the slash commands, Panda calls these on its own while chatting (details in [ARCHITECTURE.md](ARCHITECTURE.md#tools)):

- **Discord:** look up members and message senders, read server info (channels, roles, events, emojis, threads), react with emoji, post polls and embed cards (link buttons, clickable buttons, dropdowns). Panda listens and answers in threads too, to people and bots alike.
- **Web:** search the web and images, search by image (pages with matching pictures), read any public page.
- **Memory:** read further back in a channel, search what it remembered, index the messages around an old one, and save, list, open, find and edit notes (an edit keeps the old version), create notes and files (.txt, .md and other text files) that are stored with the notes and sent as attachments or cards, and send any saved note back as a file (deleting one posts the same confirmation as `/delete_note`).
- **Reminders and research:** add, show, change and delete reminders, and run the full `/research` pipeline.
- **Slash commands:** explain any command from its registered definition, say which model it runs on (the live setting), look up any OpenRouter model's price, context and providers (`model_info`), and report spend.
- **Music:** play, skip, pause, resume, stop and show the queue.
- **Self-knowledge:** read ARCHITECTURE.md and its own source on GitHub to explain how it works.
- **Oscar only:** read GitHub (files, commits, issues, PRs, code search, Actions runs), make GitHub writes such as issues and comments, change its own code through an approved `self_fix` PR, remember standing rules in `RULES.md` with `add_rule` / `remove_rule` (followed in every reply), create threads and post in them with `create_thread` / `send_to_thread`, change its personality with `set_rule`, switch models with `set_model`, and toggle private mode.

Everything else — how a message becomes a reply, how Jev makes Panda's decisions, the prompts, memory, models, tools, the research pipeline, the sandbox, safety and deployment — lives in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

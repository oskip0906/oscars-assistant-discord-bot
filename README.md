# panda-bot 🐼

Oscar’s Discord AI assistant: it chats, remembers useful context, searches and researches, takes notes, sets reminders, plays music, and can improve its own code with Oscar’s approval.

![Screenshot of Panda-bot](assets/Panda_Screenshot.png)

## Commands

Most commands also work as a chat request. `/index_channel` and `/clear` are slash-command only; power tools are for Oscar. Say “@Panda stop” to stop a running request.

### 🎙️ Voice, search & creation

| Command | Description |
|---------|-------------|
| `/voice <join\|leave\|deafen\|undeafen\|status>` | **Voice mode:** listens and transcribes the call, answers in chat, and speaks its reply aloud. Requires `PMS_AI_KEY`. |
| `/research <query> [quick\|normal\|deep]` | **Deep research:** investigates a question and returns a sourced report. |
| `/web_search <query>` · `/web_fetch <url>` | Search the web or read a page. |
| `/image_search <query>` · `/reverse_image_search <image\|url>` | Find images or search the web using an image. |
| `/video_search <query>` · `/news_search <query>` · `/wiki_search <query>` | Search videos, recent news, or Wikipedia. |
| `/sandbox [python\|javascript\|bash]` | **Code sandbox:** run code in an isolated Linux environment; ask Panda to share files it creates. |
| `/create_poll <question> <answers>` | Post a Discord poll. Separate answers with `\|`. |
| `/create_card <title> [description] [buttons] [menu]` | Post a rich card with optional buttons or dropdown. |

### 🎵 Music

| Command | Description |
|---------|-------------|
| `/play <song>` | Play a song or add it to the queue. |
| `/skip` · `/pause` · `/resume` | Control the current track. |
| `/stop` · `/queue` | Stop and clear playback, or view the queue. |

### 📝 Notes & reminders

| Command | Description |
|---------|-------------|
| `/save_note [minutes]` | Save a summary of recent chat. |
| `/display_notes` · `/open_note <title>` | Browse notes or open one. |
| `/delete_note <note>` | Delete one of your notes; Oscar can delete any. |
| `/add_reminder <name> <repeat> <when> [timezone]` | Set a one-time or repeating reminder. |
| `/show_reminders` · `/delete_reminder <reminder>` | View or delete reminders. |

### 🛠️ Oscar’s power tools

| Command | Description |
|---------|-------------|
| `/self_fix <instruction> [level]` | **Self-fix:** prepare a code change, show Oscar an approval card, then open and merge a change and restart Panda. |
| `/set_model <model> [provider]` | Switch Panda’s AI model. |
| `/set_rule <instruction>` | Change Panda’s personality or behavior. |
| `/private <on\|off\|status>` | Limit replies to Oscar or check the current setting. |
| `/index_channel` · `/clear <number\|all>` | Save channel history to memory, or delete recent messages. |

### ℹ️ Info

| Command | Description |
|---------|-------------|
| `/menu` | Show the command menu. |
| `/usage` | Show AI spending. |
| `/model [model]` | Show the active model or look up a model’s details. |

## Other tools

While chatting, Panda can read server and message context, react, create threads and interactive cards, search and read the web, and find or update saved notes and reminders. It can also look up older channel messages and explain how it works. Oscar can additionally use GitHub, read saved database records, manage standing rules, and start approved self-fixes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how Panda handles messages, memory, research, voice, sandboxes, and deployment.

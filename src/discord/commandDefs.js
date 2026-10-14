import { SlashCommandBuilder } from 'discord.js';

// Every slash command's name, description and options. This is the one source
// of truth for what the commands are: index.js registers it with Discord, and
// the conversation model reads it (panda_commands, src/agent/tools/commands.js)
// so its answers about a command never drift from the real thing. Kept apart
// from commands.js, which imports the agent, so the agent can import this.

// Commands only Oscar can run, checked against the authenticated user id.
export const OWNER_ONLY_COMMANDS = new Set(['set_model', 'self_fix', 'private', 'set_rule', 'index_channel', 'clear']);

export const commandDefs = [
  new SlashCommandBuilder().setName('menu').setDescription('Show everything Panda can do'),
  new SlashCommandBuilder().setName('usage').setDescription('Show how much money Panda has spent'),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Show which AI model Panda is running on, or OpenRouter info for a specific model')
    .addStringOption((o) =>
      o
        .setName('model')
        .setDescription('Show OpenRouter info for a specific model — name or id, start typing to search')
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName('set_model')
    .setDescription('Set the OpenRouter model Panda runs on (owner only)')
    .addStringOption((o) =>
      o
        .setName('model')
        .setDescription('OpenRouter model id — start typing to search')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('provider').setDescription('OpenRouter provider to pin it to, e.g. deepinfra — leave blank for the default').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song (or add it to the queue)')
    .addStringOption((o) => o.setName('query').setDescription('Song name, artist, or URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Talk with Panda in your voice channel: join, leave or status')
    .addStringOption((o) =>
      o
        .setName('action')
        .setDescription('Join your voice channel, leave it, or see where Panda is')
        .setRequired(true)
        .addChoices({ name: 'join', value: 'join' }, { name: 'leave', value: 'leave' }, { name: 'status', value: 'status' }),
    ),
  new SlashCommandBuilder()
    .setName('web_search')
    .setDescription('Search the web and get cited links')
    .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true)),
  new SlashCommandBuilder()
    .setName('web_fetch')
    .setDescription('Fetch and read the full content of a web page')
    .addStringOption((o) => o.setName('url').setDescription('Full URL (http:// or https://)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('image_search')
    .setDescription('Search for images')
    .addStringOption((o) => o.setName('query').setDescription('What to find pictures of').setRequired(true))
    .addIntegerOption((o) => o.setName('count').setDescription('How many pictures (default 3, up to 10)').setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder()
    .setName('reverse_image_search')
    .setDescription('Search by image: pages with matching pictures, and what it likely shows')
    .addAttachmentOption((o) => o.setName('image').setDescription('The picture to search by'))
    .addStringOption((o) => o.setName('url').setDescription('Or a public image URL (http:// or https://)')),
  new SlashCommandBuilder()
    .setName('video_search')
    .setDescription('Search for videos')
    .addStringOption((o) => o.setName('query').setDescription('What to find videos about').setRequired(true)),
  new SlashCommandBuilder()
    .setName('news_search')
    .setDescription('Search recent news')
    .addStringOption((o) => o.setName('query').setDescription('News topic').setRequired(true)),
  new SlashCommandBuilder()
    .setName('wiki_search')
    .setDescription('Search Wikipedia')
    .addStringOption((o) => o.setName('query').setDescription('Topic to look up').setRequired(true)),
  new SlashCommandBuilder()
    .setName('research')
    .setDescription('Deep research: plan, crawl, verify, and report with sources')
    .addStringOption((o) => o.setName('query').setDescription('What to research').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('depth')
        .setDescription('How hard to dig (default: normal)')
        .addChoices(
          { name: 'quick', value: 'quick' },
          { name: 'normal', value: 'normal' },
          { name: 'deep', value: 'deep' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('self_fix')
    .setDescription('Patch Panda’s own source code and restart (owner only)')
    .addStringOption((o) => o.setName('instruction').setDescription('What to change/fix about the bot').setRequired(true)),
  new SlashCommandBuilder()
    .setName('private')
    .setDescription('Private mode: Panda only responds to Oscar (owner only)')
    .addStringOption((o) =>
      o
        .setName('state')
        .setDescription('Turn private mode on, off, or check status')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('save_note')
    .setDescription('Save a summary of the recent conversation here as a note')
    .addIntegerOption((o) => o.setName('minutes').setDescription('How far back to cover, in minutes (default 10)').setMinValue(1)),
  new SlashCommandBuilder().setName('display_notes').setDescription('Browse every saved note, folder by folder'),
  new SlashCommandBuilder()
    .setName('open_note')
    .setDescription('Open a note by its title, or the closest match')
    .addStringOption((o) => o.setName('title').setDescription('Note title — start typing to search').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('delete_note')
    .setDescription('Delete one of your notes (Oscar can delete any)')
    .addStringOption((o) => o.setName('note').setDescription('Start typing the title').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('add_reminder')
    .setDescription('Get a DM from Panda at a set time, once or on repeat')
    .addStringOption((o) => o.setName('name').setDescription('What to remind you about').setRequired(true).setMaxLength(200))
    .addStringOption((o) =>
      o
        .setName('repeat')
        .setDescription('Once, or how often')
        .setRequired(true)
        .addChoices(
          { name: 'once', value: 'once' },
          { name: 'every day', value: 'daily' },
          { name: 'every week', value: 'weekly' },
          { name: 'every month', value: 'monthly' },
        ),
    )
    .addStringOption((o) =>
      o.setName('when').setDescription('once: 2026-10-20 18:30 · daily: 18:30 · weekly: mon 18:30 · monthly: 15 18:30').setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('timezone').setDescription('Your timezone — needed the first time, then remembered').setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName('show_reminders').setDescription('Show every active reminder'),
  new SlashCommandBuilder()
    .setName('delete_reminder')
    .setDescription('Delete one of your reminders (Oscar can delete any)')
    .addStringOption((o) => o.setName('reminder').setDescription('Start typing its name').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('set_rule')
    .setDescription('Change Panda’s personality or behavior for good (owner only)')
    .addStringOption((o) => o.setName('instruction').setDescription('What to change, e.g. "be more sarcastic"').setRequired(true)),
  new SlashCommandBuilder()
    .setName('create_poll')
    .setDescription('Post a native Discord poll people can vote on')
    .addStringOption((o) => o.setName('question').setDescription('The question, up to 300 characters').setRequired(true))
    .addStringOption((o) => o.setName('answers').setDescription('2 to 10 answers, separated by | (e.g. "Yes | No | Maybe")').setRequired(true))
    .addIntegerOption((o) => o.setName('hours').setDescription('How long voting stays open, 1 to 768 hours (default 24)'))
    .addBooleanOption((o) => o.setName('multiple').setDescription('Let people pick more than one answer (default false)')),
  new SlashCommandBuilder()
    .setName('create_card')
    .setDescription('Post a rich embed card with optional buttons and dropdown')
    .addStringOption((o) => o.setName('title').setDescription('Card title, up to 256 characters').setRequired(true))
    .addStringOption((o) => o.setName('description').setDescription('Main text in Discord markdown, up to 4096 characters'))
    .addStringOption((o) => o.setName('color').setDescription('Hex color such as #5865F2 (optional)'))
    .addStringOption((o) => o.setName('url').setDescription('Link for the title (optional)'))
    .addStringOption((o) => o.setName('image').setDescription('Image URL shown large (optional)'))
    .addStringOption((o) => o.setName('thumbnail').setDescription('Image URL shown small in the corner (optional)'))
    .addStringOption((o) => o.setName('footer').setDescription('Small text at the bottom (optional)'))
    .addStringOption((o) => o.setName('fields').setDescription('Fields as name: value pairs separated by | (e.g. "A: 1 | B: 2")'))
    .addStringOption((o) => o.setName('buttons').setDescription('Button labels separated by | (e.g. "Yes | No"), up to 5'))
    .addStringOption((o) => o.setName('menu').setDescription('Dropdown choices separated by | (e.g. "Red | Green | Blue"), 2 to 25')),
  new SlashCommandBuilder()
    .setName('sandbox')
    .setDescription('Run code in a sandbox (Python, JavaScript or bash)')
    .addStringOption((o) =>
      o
        .setName('language')
        .setDescription('What the code is written in (default python)')
        .addChoices(
          { name: 'python', value: 'python' },
          { name: 'javascript', value: 'javascript' },
          { name: 'bash', value: 'bash' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete recent messages in this channel, or all of them (owner only)')
    .addStringOption((o) => o.setName('amount').setDescription('How many of the newest messages to delete, or "all" for the whole channel').setRequired(true)),
  new SlashCommandBuilder().setName('index_channel').setDescription("Owner only: save this channel's whole history into Panda's context"),
].map((b) => b.toJSON());

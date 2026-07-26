import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { config, validateConfig } from './config.js';
import { ContextStore } from './agent/contextStore.js';
import { PrivateMode } from './privateMode.js';
import { createPlayer } from './music/player.js';
import { createMessageHandler } from './discord/messageHandler.js';
import { commandDefs, createInteractionHandler } from './discord/commands.js';
import { approvalCard } from './agent/tools/source.js';
import { devRunStore, githubRequest } from './agent/tools/developmentSandbox.js';
import { resolveInterruptedRun } from './devRunStore.js';
import { dmOwner } from './discord/notify.js';

validateConfig();

const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.DirectMessages,
];

async function boot(intents) {
  const client = new Client({ intents, partials: [Partials.Channel] });
  const contextStore = new ContextStore(config.contextDir);
  const privateMode = new PrivateMode(config.dataDir);
  if (privateMode.isOn()) console.log('[panda] Private mode is ON (restored from flag file)');

  let player = null;
  try {
    player = await createPlayer(client, {
      cookiesFile: config.ytCookiesFile,
      cookiesFromBrowser: config.ytCookiesFromBrowser,
    });
  } catch (err) {
    console.error('[panda] music init failed (continuing without music):', err.message);
  }

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[panda] Logged in as ${readyClient.user.tag} (id ${readyClient.user.id})`);
    let registered = 0;
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        await guild.commands.set(commandDefs);
        registered++;
      } catch (err) {
        console.error(`[panda] slash registration failed for "${guild.name}":`, err.message);
      }
    }
    console.log(`[panda] Registered ${commandDefs.length} slash commands in ${registered} guild(s)`);

    // Nothing from before the restart is left dangling: an approval card that
    // can no longer be honoured loses its buttons, and a development run that
    // was still in flight gets the finish line and the DM its process never
    // lived to send. A self-fix ends in a restart, so this is the normal path
    // for reporting one — not an edge case.
    await approvalCard.retireStale(readyClient).catch(() => {});
    await resolveInterruptedRun({
      store: devRunStore,
      gh: githubRequest(config.githubPat),
      client: readyClient,
      ownerId: config.ownerId,
      notify: dmOwner,
    }).catch((err) => console.error('[panda] could not resolve the interrupted run:', err.message));
  });

  client.on(Events.GuildCreate, (guild) => {
    guild.commands.set(commandDefs).catch(() => {});
  });
  client.on(Events.MessageCreate, createMessageHandler({ client, config, contextStore, player, privateMode }));
  client.on(Events.InteractionCreate, createInteractionHandler({ client, config, contextStore, player, privateMode }));
  client.on(Events.Error, (err) => console.error('[panda] client error:', err));

  try {
    await client.login(config.discordToken);
  } catch (err) {
    client.destroy();
    throw err;
  }
  return client;
}

let client;
try {
  client = await boot([...BASE_INTENTS, GatewayIntentBits.GuildMembers]);
} catch (err) {
  if (/disallowed intents/i.test(String(err?.message || err))) {
    console.warn(
      '[panda] GuildMembers intent is not enabled in the Developer Portal — retrying without it. ' +
        '(get_user_id falls back to the member cache; enable "Server Members Intent" for full search.)',
    );
    client = await boot(BASE_INTENTS);
  } else {
    throw err;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[panda] ${signal} received — shutting down cleanly`);
    client?.destroy();
    process.exit(0);
  });
}

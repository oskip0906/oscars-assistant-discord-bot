import { ChannelType } from 'discord.js';
import { config } from '../../config.js';
import { startInteraction } from '../agent/agent.js';
import { getAIChannel } from './commands.js'; // Assuming getAIChannel is from commands.js
import { chunk } from './chunk.js';
import { trimMention, isDM, botId } from './envelope.js'; // Assuming these are from envelope.js

const mainLoop = async (msg) => {
  // DM functionality is disabled (by config.dmEnabled = false).
  if (isDM(msg) && !config.dmEnabled) return; // isDM needs msg as argument

  // Ignore messages from bots.
  if (msg.author.bot && !config.allowBots) return;

  // Ignore messages unless they are @-mentions or DMs.
  const mentioned = msg.mentions.users.some((user) => user.id === botId(msg)); // botId needs msg as argument
  if (!isDM(msg) && !mentioned) return;

  if (config.isSelfFixInProgress) {
    await msg.reply(
      'I am currently undergoing a self-fix operation. Please hold your messages, and I will process them once I am done.'
    );
    return;
  }

  // If we are in a DM, and NOT just responding to a mention, then we can assume
  // the whole message is for us.
  const text = isDM(msg) || !mentioned ? msg.content : trimMention(msg.content, botId(msg)); // isDM and botId need msg
  if (!text) return;

  // This takes ~100ms and returns quickly while the LLM generates in the background.
  const { invocation, promise } = await startInteraction(msg, text, { isDM: isDM(msg) }); // Pass isDM to startInteraction

  // Tell Discord that we're thinking...
  msg.channel.sendTyping();

  try {
    const response = await promise;
    // Empty response means an emoji reaction was used instead (see agent.js).
    if (response) {
      for (const resChunk of chunk(response)) {
        await invocation.reply(resChunk);
      }
    }
  } catch (err) {
    console.error(`Error in mainLoop: ${err.message}`, err);
    await invocation.reply(
      '🤖 A fatal error occurred. The bot developer has been notified.'
    );
  }
};

export default async function messageHandler(msg) {
  if (msg.channel.type === ChannelType.DM) return mainLoop(msg);

  // If in a guild, only process messages in either the special AI channel, or
  // any channel if there is no special AI channel.
  const aiChannel = await getAIChannel(msg.guild.id);
  if (aiChannel && aiChannel.id !== msg.channel.id) return;

  return mainLoop(msg);
}

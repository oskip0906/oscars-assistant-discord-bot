import { ActivityType } from 'discord.js';

export const PRIVATE_ON_STATUS = '🔒 Private mode: ON';
export const PRIVATE_OFF_STATUS = '🔓 Private mode: OFF';

const custom = (text) => [{ name: text, state: text, type: ActivityType.Custom }];

// What Panda shows in the member list: the custom status says whether private
// mode is ON (Do Not Disturb) or OFF (Online).
export function presenceFor({ privateOn = false } = {}) {
  return privateOn
    ? { status: 'dnd', activities: custom(PRIVATE_ON_STATUS) }
    : { status: 'online', activities: custom(PRIVATE_OFF_STATUS) };
}

// Re-applies the presence from the current state. Called whenever private mode
// flips or the bot logs in (after the saved private mode is loaded). A failure
// is logged, never thrown.
export function updatePresence(client, privateMode) {
  try {
    client?.user?.setPresence(presenceFor({ privateOn: Boolean(privateMode?.isOn()) }));
  } catch (err) {
    console.error('[presence] update failed:', err.message);
  }
}

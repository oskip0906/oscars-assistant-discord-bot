import { ActivityType } from 'discord.js';
import { selfFixState } from './selfFixState.js';

export const SELF_FIX_STATUS = '🛠️ Currently fixing myself';

export const PRIVATE_ON_STATUS = '🔒 Private mode: ON';
export const PRIVATE_OFF_STATUS = '🔓 Private mode: OFF';

const custom = (text) => [{ name: text, state: text, type: ActivityType.Custom }];

// What Panda shows in the member list. A self-fix in flight is Idle with a
// status message saying so; otherwise the custom status says whether private
// mode is ON (Do Not Disturb) or OFF (Online).
export function presenceFor({ selfFixing = false, privateOn = false } = {}) {
  if (selfFixing) return { status: 'idle', activities: custom(SELF_FIX_STATUS) };
  return privateOn
    ? { status: 'dnd', activities: custom(PRIVATE_ON_STATUS) }
    : { status: 'online', activities: custom(PRIVATE_OFF_STATUS) };
}

// Re-applies the presence from the current state. Called whenever a self-fix
// starts or ends, private mode flips, or the bot logs in (after the saved
// private mode is loaded). A failure is logged, never thrown.
export function updatePresence(client, privateMode, state = selfFixState) {
  try {
    client?.user?.setPresence(presenceFor({ selfFixing: state.isActive(), privateOn: Boolean(privateMode?.isOn()) }));
  } catch (err) {
    console.error('[presence] update failed:', err.message);
  }
}

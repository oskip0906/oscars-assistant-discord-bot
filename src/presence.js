import { ActivityType } from 'discord.js';
import { selfFixState } from './selfFixState.js';

export const SELF_FIX_STATUS = '🛠️ Currently fixing myself';

// What Panda shows in the member list. A self-fix in flight is Idle with a
// status message saying so; otherwise private mode is Do Not Disturb, and
// anything else is plain Online with no status message.
export function presenceFor({ selfFixing = false, privateOn = false } = {}) {
  if (selfFixing) return { status: 'idle', activities: [{ name: SELF_FIX_STATUS, state: SELF_FIX_STATUS, type: ActivityType.Custom }] };
  return { status: privateOn ? 'dnd' : 'online', activities: [] };
}

// Re-applies the presence from the current state. Called whenever a self-fix
// starts or ends, private mode flips, or the bot logs in.
export function updatePresence(client, privateMode, state = selfFixState) {
  try {
    client?.user?.setPresence(presenceFor({ selfFixing: state.isActive(), privateOn: Boolean(privateMode?.isOn()) }));
  } catch (err) {
    console.error('[presence] update failed:', err.message);
  }
}

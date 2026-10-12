// Panda listens and answers in threads like in any channel: a thread is its own
// channel to the message handler, people and bots alike. Discord only sends a
// thread's messages reliably to its members, so Panda joins every thread it can:
// each new one as it is made, and the active ones at boot.
export async function joinThread(thread) {
  if (!thread?.isThread?.() || thread.joined || !thread.joinable) return false;
  try {
    await thread.join();
    return true;
  } catch (err) {
    console.error(`[threads] could not join "${thread.name}":`, String(err.message || err).slice(0, 200));
    return false;
  }
}

export async function joinActiveThreads(client) {
  let joined = 0;
  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    for (const thread of active?.threads?.values() ?? []) if (await joinThread(thread)) joined++;
  }
  return joined;
}

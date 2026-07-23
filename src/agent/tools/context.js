export const defs = [
  {
    type: 'function',
    function: {
      name: 'clear_context',
      description:
        "Erase the bot's stored conversation memory for THIS server (all channels of it). Use when someone asks to reset/forget the conversation here.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_all_context',
      description:
        'Erase stored conversation memory for EVERY server and DM. Owner (Oscar) only.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export function clearContext(_args, invocation) {
  invocation.contextStore.clear(invocation.contextKey);
  invocation.contextCleared = true;
  return 'Stored context for this server has been erased — fresh start. (The current exchange will not be saved either.)';
}

export function clearAllContext(_args, invocation) {
  invocation.contextStore.clearAll();
  invocation.contextCleared = true;
  return 'ALL stored context across every server and DM has been erased.';
}

import { voiceCommand } from '../../voice/session.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'voice',
      description:
        'Voice mode, the same as /voice. join brings you into the voice channel the SENDER is in right now ("come to vc", "join voice"): you then listen, answer in that channel\'s text chat and read the start of each answer aloud. leave ends it; status says whether and where you are in voice. deafen stops you listening to the call (you stay in it and still answer typed messages), undeafen listens again. You leave on your own when the person who brought you in leaves.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['join', 'leave', 'status', 'deafen', 'undeafen'], description: 'Join the sender\'s voice channel, leave voice, report status, or stop / resume listening.' } },
        required: ['action'],
      },
    },
  },
];

export async function voiceTool({ action } = {}, invocation) {
  if (!invocation.member) return 'Voice only works in a server.';
  return voiceCommand(action, invocation.member);
}

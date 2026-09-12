import {
  parseChatRuntimeCommand,
  type ChatRuntimeCommand,
} from './chatRuntimeCommandController';

export type OpenCodeControlCommand =
  | { owner: 'vibespace-ui'; control: 'effort' | 'fast' | 'performance'; command: ChatRuntimeCommand }
  | { owner: 'vibespace-context'; control: 'rlm'; command: ChatRuntimeCommand };

/**
 * Parse VibeSpace-owned controls before any model request is assembled. Raw
 * commands are never sent to OpenCode as user text.
 */
export function parseOpenCodeControlCommand(input: string): OpenCodeControlCommand | null {
  const command = parseChatRuntimeCommand(input);
  if (!command) return null;
  if (command.kind === 'effort' || command.kind === 'fast' || command.kind === 'performance') {
    return { owner: 'vibespace-ui', control: command.kind, command };
  }
  return { owner: 'vibespace-context', control: 'rlm', command };
}

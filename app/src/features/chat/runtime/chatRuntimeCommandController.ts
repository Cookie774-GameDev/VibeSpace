import {
  parseRuntimeSlashCommand,
  type EffortPreference,
  type FastModePreference,
  type RuntimeSlashCommand,
} from './runtimeModelControls';
import {
  DEFAULT_PERFORMANCE_PROFILE,
  parsePerformanceCommand,
  type PerformanceCommand,
  type PerformanceProfile,
} from './performanceProfile';
import { parseRlmCommand, type RlmCommand } from './rlmPreference';

export interface ChatRuntimeSettings {
  effort: EffortPreference;
  fastMode: FastModePreference;
  performance: PerformanceProfile;
  rlmEnabled: boolean;
}

export const DEFAULT_CHAT_RUNTIME_SETTINGS: Readonly<ChatRuntimeSettings> = Object.freeze({
  effort: 'auto',
  fastMode: 'auto',
  performance: DEFAULT_PERFORMANCE_PROFILE,
  rlmEnabled: true,
});

export type ChatRuntimeCommand = RuntimeSlashCommand | PerformanceCommand | RlmCommand;

export function parseChatRuntimeCommand(input: string): ChatRuntimeCommand | null {
  return parseRuntimeSlashCommand(input) ?? parsePerformanceCommand(input) ?? parseRlmCommand(input);
}

export type ApplyRuntimeCommandResult =
  | { kind: 'updated'; settings: ChatRuntimeSettings; message: string }
  | { kind: 'status'; settings: ChatRuntimeSettings; message: string }
  | { kind: 'action'; action: 'refresh-rlm' | 'open-rlm-trace'; settings: ChatRuntimeSettings }
  | { kind: 'picker'; picker: 'effort' | 'fast' | 'performance' | 'rlm'; settings: ChatRuntimeSettings };

export function applyChatRuntimeCommand(
  current: Readonly<ChatRuntimeSettings>,
  command: Readonly<ChatRuntimeCommand>,
): ApplyRuntimeCommandResult {
  const settings = { ...current };

  if (command.kind === 'effort') {
    if (!command.value) return { kind: 'picker', picker: 'effort', settings };
    if (command.value === 'status') {
      return { kind: 'status', settings, message: `Effort: ${settings.effort}` };
    }
    settings.effort = command.value;
    return { kind: 'updated', settings, message: `Effort set to ${command.value}.` };
  }

  if (command.kind === 'fast') {
    if (!command.value) return { kind: 'picker', picker: 'fast', settings };
    if (command.value === 'status') {
      return { kind: 'status', settings, message: `Fast mode: ${settings.fastMode}` };
    }
    settings.fastMode = command.value;
    return {
      kind: 'updated',
      settings,
      message: command.value === 'on'
        ? 'Fast mode requested. Availability will be validated against the exact selected connection and model before send.'
        : `Fast mode set to ${command.value}.`,
    };
  }

  if (command.kind === 'performance') {
    if (!command.value) return { kind: 'picker', picker: 'performance', settings };
    if (command.value === 'status') {
      return { kind: 'status', settings, message: `Performance profile: ${settings.performance}` };
    }
    settings.performance = command.value;
    return {
      kind: 'updated',
      settings,
      message: `Performance profile set to ${command.value}; model, effort, and provider Fast mode are unchanged.`,
    };
  }

  if (command.kind === 'open') return { kind: 'picker', picker: 'rlm', settings };
  if (command.kind === 'status') {
    return { kind: 'status', settings, message: `RLM: ${settings.rlmEnabled ? 'on' : 'off'}` };
  }
  if (command.kind === 'refresh') {
    return { kind: 'action', action: 'refresh-rlm', settings };
  }
  if (command.kind === 'trace') {
    return { kind: 'action', action: 'open-rlm-trace', settings };
  }
  settings.rlmEnabled = command.enabled;
  return {
    kind: 'updated',
    settings,
    message: `RLM turned ${command.enabled ? 'on' : 'off'}.`,
  };
}

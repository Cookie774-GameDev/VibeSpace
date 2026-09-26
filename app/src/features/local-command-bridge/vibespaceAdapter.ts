import { APP_ROUTES, type Route } from '@/features/navigation/routeSchema';
import { INSTANT_COMMAND_CATALOG } from '@/features/instant-command/catalog';
import {
  getTerminalCliPreset,
  TERMINAL_CLI_PRESET_IDS,
  type TerminalCliPresetId,
} from '@/features/terminals/terminalCliPresets';
import type { TerminalSelector } from '@/features/instant-command/types';
import type { LocalCommandAdaptation, LocalDetectedCommand } from './types';

function slotString(command: LocalDetectedCommand, key: string, maximum = 128): string | null {
  const value = command.slots[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function canonicalCatalogCommand(
  id: string,
  slots: Readonly<Record<string, unknown>>,
): LocalCommandAdaptation {
  const definition = INSTANT_COMMAND_CATALOG.find((candidate) => candidate.id === id);
  if (!definition || definition.availability === 'blocked') {
    return Object.freeze({ status: 'unsupported', reason: 'unsupported_authority' as const });
  }
  return Object.freeze({
    status: 'mapped' as const,
    command: Object.freeze({
      kind: 'catalog' as const,
      id: definition.id,
      family: definition.family,
      authority: definition.authority,
      safety: definition.safety,
      slots: Object.freeze({ ...slots }),
    }),
  });
}

function slotInteger(
  command: LocalDetectedCommand,
  key: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number | null {
  const value = command.slots[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return null;
  }
  return value as number;
}

function slotPayload(command: LocalDetectedCommand): string | null {
  return slotString(command, 'payload', 32_768);
}

function slotTarget(command: LocalDetectedCommand): TerminalSelector | null {
  const raw = command.slots.target;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Readonly<Record<string, unknown>>;
  if (Object.keys(source).some((key) => !['ordinal', 'provider', 'scope'].includes(key)))
    return null;
  const target: {
    ordinal?: number;
    provider?: string;
    scope?: 'one' | 'all';
  } = {};

  if (source.ordinal !== undefined) {
    if (
      !Number.isInteger(source.ordinal) ||
      (source.ordinal as number) < 1 ||
      (source.ordinal as number) > 10
    ) {
      return null;
    }
    target.ordinal = source.ordinal as number;
  }

  if (source.provider !== undefined) {
    if (typeof source.provider !== 'string') return null;
    const provider = source.provider.trim();
    if (!provider || !getTerminalCliPreset(provider)) return null;
    target.provider = provider;
  }

  if (source.scope !== undefined) {
    if (source.scope !== 'one' && source.scope !== 'all') return null;
    target.scope = source.scope;
  }

  if (target.ordinal === undefined && !target.provider && !target.scope) return null;
  return Object.freeze(target);
}

function terminalCommand(command: LocalDetectedCommand): LocalCommandAdaptation {
  const provider = slotString(command, 'provider', 32);
  const count = slotInteger(command, 'count', 1, 10, 1);
  if (provider === 'shell' && count !== null) {
    return Object.freeze({
      status: 'mapped',
      command: Object.freeze({
        kind: 'legacy' as const,
        intent: { kind: 'open_terminals' as const, count },
      }),
    });
  }
  if (!provider || !getTerminalCliPreset(provider) || count === null) {
    return Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  return Object.freeze({
    status: 'mapped' as const,
    command: Object.freeze({
      kind: 'open-agent-cli' as const,
      provider: provider as TerminalCliPresetId,
      count,
    }),
  });
}

function targetedMessageCommand(
  command: LocalDetectedCommand,
  kind: 'terminal-message' | 'terminal-broadcast' | 'agent-message',
): LocalCommandAdaptation {
  const target = slotTarget(command);
  const payload = slotPayload(command);
  const scope = target?.scope ?? 'one';
  const validTarget =
    target &&
    (kind === 'terminal-broadcast'
      ? scope === 'all' && target.ordinal === undefined
      : scope === 'one' && (target.ordinal !== undefined || !!target.provider));
  if (!validTarget || !target || !payload) {
    return Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  return Object.freeze({
    status: 'mapped' as const,
    command: Object.freeze({ kind, target, payload }),
  });
}

function pageCommand(command: LocalDetectedCommand): LocalCommandAdaptation {
  const route = slotString(command, 'route', 64);
  if (!route) {
    return Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  if (route === 'settings') {
    return canonicalCatalogCommand('settings.open', {});
  }
  if (!APP_ROUTES.includes(route as Route)) {
    return Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  return canonicalCatalogCommand('page.open', { route });
}

function mediaCommand(command: LocalDetectedCommand): LocalCommandAdaptation {
  if (command.id === 'music.track') {
    const text = slotString(command, 'text', 200);
    return text
      ? canonicalCatalogCommand(command.id, { text })
      : Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  if (command.id === 'music.volume') {
    const value = command.slots.value;
    return typeof value === 'number' && Number.isFinite(value)
      ? canonicalCatalogCommand(command.id, { value })
      : Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
  }
  return canonicalCatalogCommand(command.id, {});
}

/**
 * Convert only router IDs with an existing VibeSpace authority into typed
 * Instant Commands. The demo-only router inventory intentionally fails closed.
 */
export function adaptLocalCommand(command: LocalDetectedCommand): LocalCommandAdaptation {
  switch (command.id) {
    case 'terminal.open':
      return terminalCommand(command);
    case 'terminal.message':
      return targetedMessageCommand(command, 'terminal-message');
    case 'terminal.broadcast':
      return targetedMessageCommand(command, 'terminal-broadcast');
    case 'agent.message':
      return targetedMessageCommand(command, 'agent-message');
    case 'page.open':
      return pageCommand(command);
    case 'status.show':
      // Reject malformed arguments rather than hiding them from the authority.
      if (
        !command.slots ||
        typeof command.slots !== 'object' ||
        Array.isArray(command.slots) ||
        Object.keys(command.slots).length !== 0
      ) {
        return Object.freeze({ status: 'unsupported', reason: 'invalid_slots' as const });
      }
      return canonicalCatalogCommand('status.show', {});
    case 'music.play':
    case 'music.pause':
    case 'music.resume':
    case 'music.stop':
    case 'music.next':
    case 'music.previous':
    case 'music.track':
    case 'music.volume':
    case 'music.mute':
    case 'music.unmute':
      return mediaCommand(command);
    default:
      return Object.freeze({ status: 'unsupported', reason: 'unsupported_authority' as const });
  }
}

export function isSupportedLocalTerminalProvider(value: string): value is TerminalCliPresetId {
  return (TERMINAL_CLI_PRESET_IDS as readonly string[]).includes(value);
}

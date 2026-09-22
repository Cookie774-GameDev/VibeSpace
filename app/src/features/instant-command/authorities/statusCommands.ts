import { INSTANT_COMMAND_CATALOG } from '../catalog';
import type { InstantResult } from '../types';

const STATUS_COMMAND_ID = 'status.show';
const MAX_CATALOG_COMMANDS = 4_096;

export type RouterStatusSnapshot = Readonly<{
  state: 'ready';
  catalogCommands: number;
  availableCommands: number;
  gatedCommands: number;
}>;

export type RouterStatusRequest = Readonly<{
  id: string;
  slots: Readonly<Record<string, unknown>>;
}>;

export function readRouterStatus(): RouterStatusSnapshot {
  const catalogCommands = INSTANT_COMMAND_CATALOG.length;
  const availableCommands = INSTANT_COMMAND_CATALOG.filter(
    (command) => command.availability === 'available',
  ).length;
  return Object.freeze({
    state: 'ready' as const,
    catalogCommands,
    availableCommands,
    gatedCommands: catalogCommands - availableCommands,
  });
}

function validSnapshot(value: unknown): value is RouterStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as RouterStatusSnapshot;
  return (
    snapshot.state === 'ready' &&
    Number.isSafeInteger(snapshot.catalogCommands) &&
    snapshot.catalogCommands > 0 &&
    snapshot.catalogCommands <= MAX_CATALOG_COMMANDS &&
    Number.isSafeInteger(snapshot.availableCommands) &&
    snapshot.availableCommands >= 0 &&
    snapshot.availableCommands <= snapshot.catalogCommands &&
    Number.isSafeInteger(snapshot.gatedCommands) &&
    snapshot.gatedCommands === snapshot.catalogCommands - snapshot.availableCommands
  );
}

function invalid(message: string): InstantResult {
  return { ok: false, code: 'queue_failed', message };
}

export async function executeRouterStatusCommand(
  request: RouterStatusRequest,
  readStatus: () => RouterStatusSnapshot = readRouterStatus,
  signal?: AbortSignal,
): Promise<InstantResult> {
  if (signal?.aborted) return invalid('The instant command deadline elapsed.');
  if (
    request.id !== STATUS_COMMAND_ID ||
    !request.slots ||
    typeof request.slots !== 'object' ||
    Array.isArray(request.slots) ||
    Object.keys(request.slots).length !== 0
  ) {
    return invalid('Router status command arguments are invalid.');
  }
  try {
    const snapshot = readStatus();
    if (signal?.aborted) return invalid('The instant command deadline elapsed.');
    if (!validSnapshot(snapshot)) return invalid('Router status is unavailable.');
    return {
      ok: true,
      code: 'opened',
      message: `Local command router ready — ${snapshot.availableCommands} available of ${snapshot.catalogCommands} cataloged; ${snapshot.gatedCommands} gated or unproven. No provider call was made.`,
    };
  } catch {
    return invalid('Router status is unavailable.');
  }
}

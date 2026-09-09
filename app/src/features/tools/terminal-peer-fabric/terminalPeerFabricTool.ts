import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const TERMINAL_PEER_FABRIC_TOOL = Object.freeze({
  id: 'terminal-peer-fabric',
  name: 'Terminal Peer Fabric',
  distribution: 'preloaded' as const,
  actions: Object.freeze(['inspect', 'open'] as const),
});

export type TerminalPeerFabricCapability = Readonly<{
  available: boolean;
  version?: string;
  operations?: readonly TerminalPeerFabricOperation[];
}>;

export type TerminalPeerFabricOperation = 'connect' | 'team.status';

export type FabricPeerRef = Readonly<{
  paneId: string;
  sessionId: string;
  projectId: string;
  runtimeGeneration: string;
}>;

export type ConnectTeamRequest = Readonly<{
  correlationId: string;
  peerRefs: readonly FabricPeerRef[];
}>;

export type FabricCommandRequest = Readonly<{
  commandId: string;
  correlationId: string;
  targetIds: readonly string[];
  arguments?: Readonly<Record<string, unknown>>;
}>;

export type FabricReceipt = Readonly<{
  correlationId: string;
  status: 'completed' | 'queued' | 'stored' | 'rejected';
  targetIds: readonly string[];
}>;

export interface TerminalPeerFabricCommandPort {
  capability(refresh?: boolean): Promise<TerminalPeerFabricCapability>;
  connect(request: ConnectTeamRequest): Promise<FabricReceipt>;
  command(request: FabricCommandRequest): Promise<FabricReceipt>;
}

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function compatibleCapability(value: unknown): TerminalPeerFabricCapability {
  if (!value || typeof value !== 'object') return { available: false };
  const candidate = value as {
    available?: unknown;
    version?: unknown;
    operations?: unknown;
  };
  if (
    candidate.available !== true ||
    typeof candidate.version !== 'string' ||
    !Array.isArray(candidate.operations)
  ) {
    return { available: false };
  }
  const version = candidate.version.trim();
  if (!/^2\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(version)) return { available: false };
  const operations = candidate.operations.filter(
    (operation): operation is TerminalPeerFabricOperation =>
      operation === 'connect' || operation === 'team.status',
  );
  if (!operations.includes('connect') || !operations.includes('team.status')) {
    return { available: false };
  }
  return { available: true, version, operations: Object.freeze([...new Set(operations)]) };
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validPeerRefs(peerRefs: readonly FabricPeerRef[]): boolean {
  if (peerRefs.length < 2 || peerRefs.length > 8) return false;
  const identities = new Set<string>();
  const paneGenerations = new Set<string>();
  return peerRefs.every((peer) => {
    if (
      !validIdentifier(peer.paneId) ||
      !validIdentifier(peer.sessionId) ||
      !validIdentifier(peer.projectId) ||
      !validIdentifier(peer.runtimeGeneration)
    ) {
      return false;
    }
    const identity = `${peer.projectId}\u0000${peer.sessionId}`;
    const paneGeneration = `${peer.projectId}\u0000${peer.paneId}\u0000${peer.runtimeGeneration}`;
    if (identities.has(identity) || paneGenerations.has(paneGeneration)) return false;
    identities.add(identity);
    paneGenerations.add(paneGeneration);
    return true;
  });
}

function validatedReceipt(value: unknown): FabricReceipt {
  if (!value || typeof value !== 'object')
    throw new Error('Terminal Peer Fabric returned an invalid receipt.');
  const candidate = value as { correlationId?: unknown; status?: unknown; targetIds?: unknown };
  const statuses: FabricReceipt['status'][] = ['completed', 'queued', 'stored', 'rejected'];
  if (
    !validIdentifier(candidate.correlationId) ||
    !statuses.includes(candidate.status as FabricReceipt['status']) ||
    !Array.isArray(candidate.targetIds) ||
    candidate.targetIds.some((target) => !validIdentifier(target))
  ) {
    throw new Error('Terminal Peer Fabric returned an invalid receipt.');
  }
  return Object.freeze({
    correlationId: candidate.correlationId,
    status: candidate.status as FabricReceipt['status'],
    targetIds: Object.freeze([...candidate.targetIds]) as readonly string[],
  });
}

export function createTerminalPeerFabricCommandPort(
  invoke: InvokeFn = tauriInvoke,
): TerminalPeerFabricCommandPort {
  let capabilityPromise: Promise<TerminalPeerFabricCapability> | null = null;
  const capability = (refresh = false) => {
    if (refresh) capabilityPromise = null;
    capabilityPromise ??= invoke<unknown>('terminal_peer_fabric', {
      request: { action: 'capability' },
    })
      .then(compatibleCapability)
      .catch(() => ({ available: false }));
    return capabilityPromise;
  };

  const operate = async (request: Record<string, unknown>): Promise<FabricReceipt> => {
    const current = await capability();
    if (!current.available) throw new Error('Terminal Peer Fabric is unavailable in this build.');
    return invoke<unknown>('terminal_peer_fabric', { request }).then(validatedReceipt);
  };

  const port: TerminalPeerFabricCommandPort = {
    capability,
    connect: (request) => operate({ action: 'connect', ...request }),
    command: (request) => operate({ action: 'command', ...request }),
  };
  return Object.freeze(port);
}

export async function recoverTerminalPeerFabricTeam(
  correlationId: string,
  peerRefs: readonly FabricPeerRef[],
  port: TerminalPeerFabricCommandPort = terminalPeerFabricCommandPort,
): Promise<FabricReceipt> {
  if (!validIdentifier(correlationId) || !validPeerRefs(peerRefs)) {
    throw new Error('Terminal Peer Fabric recovery requires verified stable terminal generations.');
  }
  const capability = await port.capability();
  if (
    !capability.available ||
    !capability.version?.startsWith('2.') ||
    !capability.operations?.includes('connect')
  ) {
    throw new Error('Terminal Peer Fabric recovery is unavailable in this build.');
  }
  return port.connect({ correlationId, peerRefs });
}

export const terminalPeerFabricCommandPort = createTerminalPeerFabricCommandPort();

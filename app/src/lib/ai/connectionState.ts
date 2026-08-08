export interface ConnectionPickerState {
  available: boolean;
  auth: 'authenticated' | 'unauthenticated' | 'unknown';
}

export interface ConnectionMetadataRecord {
  installation: 'installed' | 'not-installed' | 'unknown';
  auth: ConnectionPickerState['auth'];
  executablePath?: string;
  version?: string;
  lastCheckedAt?: number;
  disabled?: boolean;
}

export type ConnectionMetadata = Partial<Record<string, ConnectionMetadataRecord>>;

export const AI_CONNECTION_STATE_EVENT = 'jarvis:ai-connections:changed';
export const AI_CONNECTION_STATE_KEY = 'vibespace.ai-connection-states.v1';
export const AI_CONNECTION_METADATA_KEY = 'vibespace.ai-connection-metadata.v1';

const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;
const INSTALLATION_STATES = new Set(['installed', 'not-installed', 'unknown']);
const AUTH_STATES = new Set(['authenticated', 'unauthenticated', 'unknown']);
const sessionCheckedConnectionIds = new Set<string>();
const metadataRevisions = new Map<string, number>();
let sessionMetadataSnapshot: ConnectionMetadata | undefined;
let metadataPersistenceDirty = false;
let sessionPickerStates: Partial<Record<string, ConnectionPickerState>> = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedDisplayText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function canonicalPickerStates(
  states: Partial<Record<string, ConnectionPickerState>>,
): Partial<Record<string, ConnectionPickerState>> {
  const canonical: Partial<Record<string, ConnectionPickerState>> = {};
  for (const [id, value] of Object.entries(states)) {
    if (!CONNECTION_ID_PATTERN.test(id) || !isRecord(value)) continue;
    if (typeof value.available !== 'boolean' || !AUTH_STATES.has(String(value.auth))) {
      continue;
    }
    canonical[id] = Object.freeze({
      available: value.available,
      auth: value.auth as ConnectionPickerState['auth'],
    });
  }
  return Object.freeze(canonical);
}

function canonicalMetadata(value: unknown): ConnectionMetadata {
  if (!isRecord(value)) return Object.freeze({});
  const canonical: ConnectionMetadata = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (!CONNECTION_ID_PATTERN.test(id) || !isRecord(candidate)) continue;
    if (
      !INSTALLATION_STATES.has(String(candidate.installation)) ||
      !AUTH_STATES.has(String(candidate.auth))
    ) {
      continue;
    }
    const executablePath = boundedDisplayText(candidate.executablePath, 1_024);
    const version = boundedDisplayText(candidate.version, 160);
    const lastCheckedAt =
      typeof candidate.lastCheckedAt === 'number' &&
      Number.isSafeInteger(candidate.lastCheckedAt) &&
      candidate.lastCheckedAt >= 0
        ? candidate.lastCheckedAt
        : undefined;
    canonical[id] = Object.freeze({
      installation: candidate.installation as ConnectionMetadataRecord['installation'],
      auth: candidate.auth as ConnectionMetadataRecord['auth'],
      ...(executablePath ? { executablePath } : {}),
      ...(version ? { version } : {}),
      ...(lastCheckedAt !== undefined ? { lastCheckedAt } : {}),
      ...(typeof candidate.disabled === 'boolean' ? { disabled: candidate.disabled } : {}),
    });
  }
  return Object.freeze(canonical);
}

function sameMetadataRecord(
  left: ConnectionMetadataRecord | undefined,
  right: ConnectionMetadataRecord | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.installation === right.installation &&
    left.auth === right.auth &&
    left.executablePath === right.executablePath &&
    left.version === right.version &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.disabled === right.disabled
  );
}

function observeMetadataSnapshot(metadata: ConnectionMetadata): void {
  if (sessionMetadataSnapshot) {
    const connectionIds = new Set([
      ...Object.keys(sessionMetadataSnapshot),
      ...Object.keys(metadata),
    ]);
    for (const connectionId of connectionIds) {
      if (sameMetadataRecord(sessionMetadataSnapshot[connectionId], metadata[connectionId])) {
        continue;
      }
      metadataRevisions.set(connectionId, (metadataRevisions.get(connectionId) ?? 0) + 1);
    }
  }
  sessionMetadataSnapshot = metadata;
}

export function readConnectionPickerStates(): Partial<Record<string, ConnectionPickerState>> {
  if (typeof window === 'undefined') return {};
  try {
    return canonicalPickerStates(
      JSON.parse(window.localStorage.getItem(AI_CONNECTION_STATE_KEY) ?? '{}') as Partial<
        Record<string, ConnectionPickerState>
      >,
    );
  } catch {
    return {};
  }
}

export function writeConnectionPickerStates(
  states: Partial<Record<string, ConnectionPickerState>>,
): Partial<Record<string, ConnectionPickerState>> {
  const canonical = canonicalPickerStates(states);
  if (typeof window === 'undefined') return canonical;
  try {
    window.localStorage.setItem(AI_CONNECTION_STATE_KEY, JSON.stringify(canonical));
  } catch {
    // In-memory session state still changed; mounted consumers must re-read it.
  }
  window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT));
  return canonical;
}

export function readConnectionMetadata(): ConnectionMetadata {
  if (metadataPersistenceDirty && sessionMetadataSnapshot) {
    return sessionMetadataSnapshot;
  }
  if (typeof window === 'undefined') return {};
  try {
    const metadata = canonicalMetadata(
      JSON.parse(window.localStorage.getItem(AI_CONNECTION_METADATA_KEY) ?? '{}'),
    );
    observeMetadataSnapshot(metadata);
    return metadata;
  } catch {
    const metadata = Object.freeze({});
    observeMetadataSnapshot(metadata);
    return metadata;
  }
}

export function writeConnectionMetadata(metadata: ConnectionMetadata): ConnectionMetadata {
  const previous = sessionMetadataSnapshot ?? {};
  const hadSessionSnapshot = sessionMetadataSnapshot !== undefined;
  const canonical = canonicalMetadata(metadata);
  if (!sessionMetadataSnapshot) readConnectionMetadata();
  // Re-read previous after ensuring snapshot exists for first-write baseline.
  const baseline = hadSessionSnapshot ? previous : {};
  observeMetadataSnapshot(canonical);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(AI_CONNECTION_METADATA_KEY, JSON.stringify(canonical));
      metadataPersistenceDirty = false;
    } catch {
      // Current-session authority remains in memory even when persistence is unavailable.
      metadataPersistenceDirty = true;
    }
  }
  const pickerStates: Partial<Record<string, ConnectionPickerState>> = Object.fromEntries(
    Object.entries(canonical).map(([id, record]) => [
      id,
      {
        available: record?.installation === 'installed' && record.disabled !== true,
        auth: record?.auth ?? 'unknown',
      },
    ]),
  );
  sessionPickerStates = canonicalPickerStates(pickerStates);
  writeConnectionPickerStates(pickerStates);

  // Real auth-loss event: authenticated → unauthenticated (not first hydrate).
  if (hadSessionSnapshot) {
    void import('@/lib/notifications').then(({ detectAndNotifyConnectorAuthLoss }) => {
      detectAndNotifyConnectorAuthLoss(baseline, canonical);
    });
  }

  return canonical;
}

export function isConnectionSessionChecked(connectionId: string): boolean {
  return sessionCheckedConnectionIds.has(connectionId);
}

export function readConnectionMetadataRevision(connectionId: string): number {
  return metadataRevisions.get(connectionId) ?? 0;
}

export function markConnectionSessionChecked(connectionIds: readonly string[]): void {
  let changed = false;
  for (const connectionId of connectionIds) {
    if (
      !CONNECTION_ID_PATTERN.test(connectionId) ||
      sessionCheckedConnectionIds.has(connectionId)
    ) {
      continue;
    }
    sessionCheckedConnectionIds.add(connectionId);
    changed = true;
  }
  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AI_CONNECTION_STATE_EVENT));
  }
}

export function readConnectionSessionPickerStates(): Partial<
  Record<string, ConnectionPickerState>
> {
  return sessionPickerStates;
}

export function resetConnectionSessionChecksForTests(): void {
  sessionCheckedConnectionIds.clear();
  metadataRevisions.clear();
  sessionMetadataSnapshot = undefined;
  metadataPersistenceDirty = false;
  sessionPickerStates = Object.freeze({});
}

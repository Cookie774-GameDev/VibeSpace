import {
  markConnectionSessionChecked,
  readConnectionMetadata,
  readConnectionMetadataRevision,
  writeConnectionMetadata,
  type ConnectionMetadata,
  type ConnectionMetadataRecord,
} from '../connectionState';
import { PROVIDER_CONNECTIONS } from './catalog';
import { claudeCliAdapter } from './claude';
import { codexCliAdapter } from './codex';
import { copilotCliAdapter } from './copilot';
import { geminiCliAdapter } from './gemini';
import { openCodeCliAdapter } from './opencode';
import { qwenCliAdapter } from './qwen';
import type { ProviderAdapter, ProviderConnection } from './types';

const EXTERNAL_CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze(
  Object.fromEntries(
    [
      codexCliAdapter,
      claudeCliAdapter,
      geminiCliAdapter,
      copilotCliAdapter,
      qwenCliAdapter,
      openCodeCliAdapter,
    ].map((adapter) => [adapter.id, adapter]),
  ),
);

export interface ExternalConnectionDetectionDependencies {
  connections: readonly Readonly<ProviderConnection>[];
  adapters: Readonly<Record<string, ProviderAdapter>>;
  readMetadata: () => ConnectionMetadata;
  readMetadataRevision: (connectionId: string) => number;
  writeMetadata: (metadata: ConnectionMetadata) => ConnectionMetadata;
  markSessionChecked: (connectionIds: readonly string[]) => void;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: ExternalConnectionDetectionDependencies = Object.freeze({
  connections: PROVIDER_CONNECTIONS,
  adapters: EXTERNAL_CLI_ADAPTERS,
  readMetadata: readConnectionMetadata,
  readMetadataRevision: readConnectionMetadataRevision,
  writeMetadata: writeConnectionMetadata,
  markSessionChecked: markConnectionSessionChecked,
  now: Date.now,
});

function unknownRecord(now: number, disabled?: boolean): ConnectionMetadataRecord {
  return {
    installation: 'unknown',
    auth: 'unknown',
    lastCheckedAt: now,
    ...(disabled !== undefined ? { disabled } : {}),
  };
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

async function inspectConnection(
  connection: Readonly<ProviderConnection>,
  adapter: ProviderAdapter,
  now: number,
  disabled?: boolean,
): Promise<ConnectionMetadataRecord> {
  let detection;
  try {
    detection = await adapter.detect!();
  } catch {
    return unknownRecord(now, disabled);
  }

  const installation: ConnectionMetadataRecord['installation'] =
    detection.status === 'available'
      ? 'installed'
      : detection.status === 'unavailable'
        ? 'not-installed'
        : 'unknown';
  let auth: ConnectionMetadataRecord['auth'] = 'unknown';
  if (detection.status === 'available' && adapter.probeAuth) {
    try {
      auth = (await adapter.probeAuth(connection)).status;
    } catch {
      auth = 'unknown';
    }
  }
  return {
    installation,
    auth,
    ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
    ...(detection.version ? { version: detection.version } : {}),
    lastCheckedAt: now,
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

export async function detectExternalConnectionStates(
  dependencies: ExternalConnectionDetectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ConnectionMetadata> {
  const current = dependencies.readMetadata();
  const targets = dependencies.connections.filter(
    (connection) =>
      connection.enabled &&
      connection.mode === 'external-cli' &&
      typeof dependencies.adapters[connection.adapterId]?.detect === 'function',
  );
  const baselineRevisions = new Map(
    targets.map((connection) => [connection.id, dependencies.readMetadataRevision(connection.id)]),
  );
  const inspected = await Promise.all(
    targets.map(async (connection) => {
      const existing = current[connection.id];
      if (existing?.disabled) return [connection.id, existing, false] as const;
      const record = await inspectConnection(
        connection,
        dependencies.adapters[connection.adapterId]!,
        dependencies.now(),
        existing?.disabled,
      );
      return [connection.id, record, true] as const;
    }),
  );
  const latest = dependencies.readMetadata();
  const merged: ConnectionMetadata = { ...latest };
  const appliedConnectionIds: string[] = [];
  for (const [id, record] of inspected) {
    const latestRecord = latest[id];
    if (
      dependencies.readMetadataRevision(id) !== baselineRevisions.get(id) ||
      !sameMetadataRecord(latestRecord, current[id])
    ) {
      if (latestRecord) merged[id] = latestRecord;
      else delete merged[id];
      continue;
    }
    merged[id] = record;
    appliedConnectionIds.push(id);
  }
  const persisted = dependencies.writeMetadata(merged);
  const checkedConnectionIds = appliedConnectionIds.filter(
    (id) => inspected.find(([inspectedId]) => inspectedId === id)?.[2] === true,
  );
  if (checkedConnectionIds.length > 0) {
    dependencies.markSessionChecked(checkedConnectionIds);
  }
  return persisted;
}

export function createExternalConnectionAutoDetector(
  dependencies: ExternalConnectionDetectionDependencies = DEFAULT_DEPENDENCIES,
  ttlMs = 60_000,
): Readonly<{
  ensure: (options?: Readonly<{ force?: boolean }>) => Promise<ConnectionMetadata>;
  invalidate: () => void;
}> {
  let inFlight: Promise<ConnectionMetadata> | undefined;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    ensure(options): Promise<ConnectionMetadata> {
      if (inFlight) return inFlight;
      if (!options?.force && dependencies.now() - lastCompletedAt < ttlMs) {
        return Promise.resolve(dependencies.readMetadata());
      }
      const scan = detectExternalConnectionStates(dependencies);
      inFlight = scan;
      const complete = () => {
        if (inFlight === scan) {
          lastCompletedAt = dependencies.now();
          inFlight = undefined;
        }
      };
      void scan.then(complete, complete);
      return scan;
    },
    invalidate(): void {
      lastCompletedAt = Number.NEGATIVE_INFINITY;
    },
  });
}

const defaultDetector = createExternalConnectionAutoDetector();

export function ensureExternalConnectionAutoDetection(): Promise<ConnectionMetadata> {
  return defaultDetector.ensure();
}

export function refreshExternalConnectionAutoDetection(): Promise<ConnectionMetadata> {
  defaultDetector.invalidate();
  return defaultDetector.ensure({ force: true });
}

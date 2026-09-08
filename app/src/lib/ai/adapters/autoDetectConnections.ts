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
import { openCodePersistentAdapter } from './opencodePersistent';
import { qwenCliAdapter } from './qwen';
import type { DetectionResult, ProviderAdapter, ProviderConnection } from './types';

const EXTERNAL_CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze(
  Object.fromEntries(
    [
      codexCliAdapter,
      claudeCliAdapter,
      geminiCliAdapter,
      copilotCliAdapter,
      qwenCliAdapter,
      openCodePersistentAdapter,
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
  inspectionTimeoutMs?: number;
  now: () => number;
}

const DEFAULT_INSPECTION_TIMEOUT_MS = 20_000;

const DEFAULT_DEPENDENCIES: ExternalConnectionDetectionDependencies = Object.freeze({
  connections: PROVIDER_CONNECTIONS,
  adapters: EXTERNAL_CLI_ADAPTERS,
  readMetadata: readConnectionMetadata,
  readMetadataRevision: readConnectionMetadataRevision,
  writeMetadata: writeConnectionMetadata,
  markSessionChecked: markConnectionSessionChecked,
  inspectionTimeoutMs: DEFAULT_INSPECTION_TIMEOUT_MS,
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
  detectionPromise: Promise<DetectionResult>,
  now: number,
  disabled?: boolean,
): Promise<ConnectionMetadataRecord> {
  let detection;
  try {
    detection = await detectionPromise;
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

interface CompletedConnectionInspection {
  readonly completed: true;
  readonly record: ConnectionMetadataRecord;
}

interface TimedOutConnectionInspection {
  readonly completed: false;
}

type ConnectionInspection = CompletedConnectionInspection | TimedOutConnectionInspection;

async function inspectConnectionWithinDeadline(
  connection: Readonly<ProviderConnection>,
  adapter: ProviderAdapter,
  detectionPromise: Promise<DetectionResult>,
  now: number,
  timeoutMs: number,
  disabled?: boolean,
): Promise<ConnectionInspection> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutConnectionInspection>((resolve) => {
    timeoutId = setTimeout(() => resolve(Object.freeze({ completed: false })), timeoutMs);
  });
  try {
    return await Promise.race([
      inspectConnection(connection, adapter, detectionPromise, now, disabled).then((record) =>
        Object.freeze({ completed: true as const, record }),
      ),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
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
  const detectionsByAdapter = new Map<string, Promise<DetectionResult>>();
  const publishedByThisScan = new Map<string, ConnectionMetadataRecord>();
  let lastPersisted: ConnectionMetadata = current;
  let publishQueue: Promise<void> = Promise.resolve();

  const publishCompletedInspection = (
    id: string,
    record: ConnectionMetadataRecord,
  ): Promise<void> => {
    const publication = publishQueue.then(() => {
      const latest = dependencies.readMetadata();
      const merged: ConnectionMetadata = { ...latest };

      for (const [publishedId, publishedRecord] of publishedByThisScan) {
        if (
          dependencies.readMetadataRevision(publishedId) === baselineRevisions.get(publishedId) &&
          (sameMetadataRecord(latest[publishedId], current[publishedId]) ||
            sameMetadataRecord(latest[publishedId], publishedRecord))
        ) {
          merged[publishedId] = publishedRecord;
        }
      }

      if (
        dependencies.readMetadataRevision(id) !== baselineRevisions.get(id) ||
        !sameMetadataRecord(latest[id], current[id])
      ) {
        lastPersisted = dependencies.writeMetadata(merged);
        return;
      }

      merged[id] = record;
      lastPersisted = dependencies.writeMetadata(merged);
      publishedByThisScan.set(id, record);
      dependencies.markSessionChecked([id]);
    });
    publishQueue = publication.catch(() => undefined);
    return publication;
  };

  await Promise.all(
    targets.map(async (connection) => {
      const existing = current[connection.id];
      if (existing?.disabled) return;
      const adapter = dependencies.adapters[connection.adapterId]!;
      let detection = detectionsByAdapter.get(adapter.id);
      if (!detection) {
        detection = (async () => adapter.detect!())();
        detectionsByAdapter.set(adapter.id, detection);
      }
      const inspection = await inspectConnectionWithinDeadline(
        connection,
        adapter,
        detection,
        dependencies.now(),
        dependencies.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
        existing?.disabled,
      );
      if (!inspection.completed) return;
      await publishCompletedInspection(connection.id, inspection.record);
    }),
  );
  await publishQueue;
  return lastPersisted;
}

export function createExternalConnectionAutoDetector(
  dependencies: ExternalConnectionDetectionDependencies = DEFAULT_DEPENDENCIES,
  ttlMs = 60_000,
): Readonly<{
  ensure: (options?: Readonly<{ force?: boolean }>) => Promise<ConnectionMetadata>;
  invalidate: () => void;
}> {
  let inFlight: Promise<ConnectionMetadata> | undefined;
  let queuedForce: Promise<ConnectionMetadata> | undefined;
  let lastCompletedAt = Number.NEGATIVE_INFINITY;
  const runScan = (): Promise<ConnectionMetadata> => {
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
  };
  const ensure = (options?: Readonly<{ force?: boolean }>): Promise<ConnectionMetadata> => {
    if (inFlight) {
      if (!options?.force) return inFlight;
      if (!queuedForce) {
        const blocking = inFlight;
        queuedForce = blocking
          .catch(() => dependencies.readMetadata())
          .then(() => runScan())
          .finally(() => {
            queuedForce = undefined;
          });
      }
      return queuedForce;
    }
    if (!options?.force && dependencies.now() - lastCompletedAt < ttlMs) {
      return Promise.resolve(dependencies.readMetadata());
    }
    return runScan();
  };
  return Object.freeze({
    ensure,
    invalidate(): void {
      lastCompletedAt = Number.NEGATIVE_INFINITY;
    },
  });
}

const defaultDetector = createExternalConnectionAutoDetector();

export function ensureExternalConnectionAutoDetection(
  options?: Readonly<{ force?: boolean }>,
): Promise<ConnectionMetadata> {
  return defaultDetector.ensure(options);
}

export function refreshExternalConnectionAutoDetection(): Promise<ConnectionMetadata> {
  defaultDetector.invalidate();
  return defaultDetector.ensure({ force: true });
}

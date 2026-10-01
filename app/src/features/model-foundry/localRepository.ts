import {
  FOUNDRY_SCHEMA_VERSION,
  type FoundryError,
  type FoundryErrorCode,
  type FoundryResult,
  type ProjectSnapshot,
} from './domain';
import { validateProjectSnapshot } from './validation';

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RepositoryEnvelope {
  readonly repositoryVersion: typeof CURRENT_REPOSITORY_VERSION;
  readonly generation: number;
  readonly snapshot: ProjectSnapshot;
}

interface ParsedEnvelopeSuccess {
  readonly ok: true;
  readonly value: RepositoryEnvelope;
}

interface ParsedEnvelopeFailure {
  readonly ok: false;
  readonly code: Extract<
    FoundryErrorCode,
    'STORAGE_PARSE_ERROR' | 'STORAGE_VALIDATION_ERROR' | 'UNSUPPORTED_STORAGE_VERSION'
  >;
  readonly message: string;
  readonly recoverable: boolean;
}

type ParsedEnvelope = ParsedEnvelopeSuccess | ParsedEnvelopeFailure;

export const CURRENT_REPOSITORY_VERSION = 1 as const;

const SECRET_FIELD_NAMES = new Set([
  'apikey',
  'providerkey',
  'secret',
  'secrets',
  'token',
  'accesstoken',
  'refreshtoken',
  'credential',
  'credentials',
  'password',
  'privatekey',
]);

function normalizedFieldName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /(?:postgres(?:ql)?|mysql):\/\/[^\s:@]+:[^\s@]+@/i,
];

function containsSecretMaterial(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretMaterial(item, seen));
  return Object.entries(value).some(
    ([key, child]) =>
      SECRET_FIELD_NAMES.has(normalizedFieldName(key)) || containsSecretMaterial(child, seen),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export class VersionedFixtureRepository {
  private readonly currentKey: string;
  private readonly backupKey: string;

  constructor(
    private readonly storage: StorageAdapter,
    keyPrefix: string,
    private readonly correlationIdFactory: () => string,
  ) {
    this.currentKey = `${keyPrefix}.current`;
    this.backupKey = `${keyPrefix}.backup`;
  }

  save(snapshot: ProjectSnapshot): FoundryResult<void> {
    if (containsSecretMaterial(snapshot)) {
      return this.failure(
        'SECRET_MATERIAL_REJECTED',
        'Fixture snapshots containing secret-shaped fields are not persisted.',
        false,
        {},
      );
    }
    const validation = validateProjectSnapshot(snapshot);
    if (!validation.valid) {
      return this.failure(
        'STORAGE_VALIDATION_ERROR',
        'Fixture snapshot failed validation and was not persisted.',
        true,
        {
          issueCount: validation.issues.length,
          fieldPaths: validation.issues.map((issue) => issue.path.join('.')).join(','),
        },
      );
    }

    try {
      const currentRaw = this.storage.getItem(this.currentKey);
      const backupRaw = this.storage.getItem(this.backupKey);
      const currentEnvelope = currentRaw === null ? undefined : this.parseEnvelope(currentRaw);
      const backupEnvelope = backupRaw === null ? undefined : this.parseEnvelope(backupRaw);
      const previousValidRaw =
        currentEnvelope?.ok === true
          ? currentRaw
          : backupEnvelope?.ok === true
            ? backupRaw
            : null;
      const previousGeneration =
        currentEnvelope?.ok === true
          ? currentEnvelope.value.generation
          : backupEnvelope?.ok === true
            ? backupEnvelope.value.generation
            : 0;
      const envelope: RepositoryEnvelope = {
        repositoryVersion: CURRENT_REPOSITORY_VERSION,
        generation: previousGeneration + 1,
        snapshot: validation.value,
      };
      if (previousValidRaw !== null) this.storage.setItem(this.backupKey, previousValidRaw);
      this.storage.setItem(this.currentKey, JSON.stringify(envelope));
      return { ok: true, value: undefined };
    } catch (error) {
      const quota = error instanceof Error && error.name === 'QuotaExceededError';
      return this.failure(
        quota ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_UNAVAILABLE',
        quota ? 'Local fixture storage quota was exceeded.' : 'Local fixture storage is unavailable.',
        true,
        {},
      );
    }
  }

  load(): FoundryResult<ProjectSnapshot | null> {
    let currentRaw: string | null;
    let backupRaw: string | null;
    try {
      currentRaw = this.storage.getItem(this.currentKey);
      backupRaw = this.storage.getItem(this.backupKey);
    } catch {
      return this.failure('STORAGE_UNAVAILABLE', 'Local fixture storage is unavailable.', true, {});
    }
    if (currentRaw === null && backupRaw === null) return { ok: true, value: null };

    const current = currentRaw === null ? undefined : this.parseEnvelope(currentRaw);
    if (current?.ok) return { ok: true, value: deepFreeze(current.value.snapshot) };

    const backup = backupRaw === null ? undefined : this.parseEnvelope(backupRaw);
    if (backup?.ok) return { ok: true, value: deepFreeze(backup.value.snapshot) };

    const primaryFailure = current && !current.ok ? current : backup && !backup.ok ? backup : undefined;
    return this.failure(
      primaryFailure?.code ?? 'STORAGE_PARSE_ERROR',
      primaryFailure?.message ?? 'No valid fixture repository generation could be parsed.',
      primaryFailure?.recoverable ?? true,
      {},
    );
  }

  clear(): FoundryResult<void> {
    try {
      this.storage.removeItem(this.currentKey);
      this.storage.removeItem(this.backupKey);
      return { ok: true, value: undefined };
    } catch {
      return this.failure('STORAGE_UNAVAILABLE', 'Local fixture storage is unavailable.', true, {});
    }
  }

  private parseEnvelope(raw: string): ParsedEnvelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {
        ok: false,
        code: 'STORAGE_PARSE_ERROR',
        message: 'Stored fixture snapshot is not valid JSON.',
        recoverable: true,
      };
    }
    if (!isRecord(parsed) || parsed.repositoryVersion !== CURRENT_REPOSITORY_VERSION) {
      return {
        ok: false,
        code: 'UNSUPPORTED_STORAGE_VERSION',
        message: 'Stored fixture snapshot uses an unsupported repository version.',
        recoverable: false,
      };
    }
    if (
      typeof parsed.generation !== 'number' ||
      !Number.isInteger(parsed.generation) ||
      parsed.generation < 1
    ) {
      return {
        ok: false,
        code: 'STORAGE_VALIDATION_ERROR',
        message: 'Stored fixture generation metadata is invalid.',
        recoverable: true,
      };
    }
    if (containsSecretMaterial(parsed.snapshot)) {
      return {
        ok: false,
        code: 'STORAGE_VALIDATION_ERROR',
        message: 'Stored fixture snapshot contains forbidden secret-shaped fields.',
        recoverable: false,
      };
    }
    const validation = validateProjectSnapshot(parsed.snapshot);
    if (!validation.valid) {
      return {
        ok: false,
        code: 'STORAGE_VALIDATION_ERROR',
        message: 'Stored fixture snapshot failed domain validation.',
        recoverable: true,
      };
    }
    return {
      ok: true,
      value: {
        repositoryVersion: CURRENT_REPOSITORY_VERSION,
        generation: parsed.generation as number,
        snapshot: validation.value,
      },
    };
  }

  private failure(
    code: FoundryErrorCode,
    message: string,
    recoverable: boolean,
    details: FoundryError['details'],
  ): { readonly ok: false; readonly error: FoundryError } {
    return {
      ok: false,
      error: {
        schemaVersion: FOUNDRY_SCHEMA_VERSION,
        code,
        message,
        recoverable,
        correlationId: this.correlationIdFactory(),
        details,
      },
    };
  }
}

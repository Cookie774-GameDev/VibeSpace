import { describe, expect, it } from 'vitest';
import type { FoundryResult, ProjectSnapshot, SpecialistDefinition } from './domain';
import { DeterministicFixtureBackend } from './fixtureBackend';
import { InMemoryStorageAdapter, VersionedFixtureRepository } from './localRepository';
import { CURRENT_FOUNDRY_SCHEMA_VERSION } from './validation';

const NOW = '2026-07-13T12:00:00.000Z';

function unwrap<T>(result: FoundryResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function makeSnapshot(name = 'Fixture Specialist'): ProjectSnapshot {
  const specialist: SpecialistDefinition = {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'fixture-specialist',
    name,
    purpose: 'Exercise versioned local fixture persistence.',
    objective: 'Verify deterministic local persistence.',
    nonGoals: ['External storage.'],
    inputSchema: {
      type: 'object',
      required: ['fixture'],
      properties: { fixture: { type: 'string', description: 'A local fixture.' } },
    },
    outputSchema: {
      type: 'object',
      required: ['result'],
      properties: { result: { type: 'string', description: 'A fixture result.' } },
    },
    expectedInputs: ['A deterministic local fixture.'],
    expectedOutputs: ['A deterministic fixture result.'],
    constraints: ['Never claim real training occurred.'],
    behaviorRequirements: ['Use only injected deterministic dependencies.'],
    forbiddenBehavior: ['Do not access external storage.'],
    toolPermissions: { mode: 'none', allowedTools: [] },
    privacyPolicy: { classification: 'private', localOnly: true, retention: 'project_lifetime' },
    dataPolicy: { trainingUse: 'approved_only', externalTransfer: false, rawDataLogging: false },
    latencyTarget: { kind: 'not_measured', maxMilliseconds: null },
    memoryTarget: { kind: 'not_measured', maxBytes: null },
    evaluationRubric: {
      criteria: [{ id: 'deterministic', description: 'Results repeat exactly.', weight: 1 }],
    },
    safetyRubric: { requiredChecks: ['no-secret-storage'] },
    commercialIntent: 'personal',
    modelLicenseConstraints: ['Local fixture only.'],
    promotionThreshold: { metricId: 'determinism', minimumValue: 1 },
    regressionThreshold: { metricId: 'determinism', maximumRegression: 0 },
    owner: 'local-owner',
    version: 1,
    successMetrics: [
      {
        id: 'determinism',
        name: 'Deterministic cases',
        description: 'Fraction of repeated fixture cases with identical output.',
        target: 1,
        unit: 'ratio',
        direction: 'at_least',
      },
    ],
    privacyMode: 'local_only',
    createdAt: NOW,
    updatedAt: NOW,
  };
  const backend = new DeterministicFixtureBackend({
    clock: () => NOW,
    idFactory: (kind) => `${kind}-1`,
  });
  return unwrap(backend.createProject(specialist));
}

describe('VersionedFixtureRepository', () => {
  it('round-trips a validated fixture snapshot through the storage adapter', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'correlation-1');
    const snapshot = makeSnapshot();

    expect(repository.save(snapshot)).toEqual({ ok: true, value: undefined });
    expect(unwrap(repository.load())).toEqual(snapshot);
  });

  it('falls back to the last valid backup generation when current data is corrupt', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'correlation-1');
    const first = makeSnapshot('First valid generation');
    const second = makeSnapshot('Second valid generation');
    unwrap(repository.save(first));
    unwrap(repository.save(second));

    storage.setItem('foundry.current', '{corrupt-json');

    expect(unwrap(repository.load())?.project.specialist.name).toBe('First valid generation');
  });

  it('surfaces parse and unsupported-version failures as stable Foundry errors', () => {
    const parseStorage = new InMemoryStorageAdapter();
    parseStorage.setItem('foundry.current', '{bad');
    const parseRepository = new VersionedFixtureRepository(
      parseStorage,
      'foundry',
      () => 'parse-correlation',
    );
    expect(parseRepository.load()).toMatchObject({
      ok: false,
      error: {
        code: 'STORAGE_PARSE_ERROR',
        recoverable: true,
        correlationId: 'parse-correlation',
      },
    });

    const versionStorage = new InMemoryStorageAdapter();
    versionStorage.setItem(
      'foundry.current',
      JSON.stringify({ repositoryVersion: 99, generation: 1, snapshot: makeSnapshot() }),
    );
    const versionRepository = new VersionedFixtureRepository(
      versionStorage,
      'foundry',
      () => 'version-correlation',
    );
    expect(versionRepository.load()).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_STORAGE_VERSION',
        recoverable: false,
        correlationId: 'version-correlation',
      },
    });
  });

  it('surfaces storage quota failures without exposing the stored value', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        const error = new Error('secret raw value must not be echoed');
        error.name = 'QuotaExceededError';
        throw error;
      },
      removeItem: () => undefined,
    };
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'quota-correlation');

    const result = repository.save(makeSnapshot());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_QUOTA_EXCEEDED', correlationId: 'quota-correlation' },
    });
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('secret raw value');
  });

  it('rejects parsed snapshots that fail domain validation', () => {
    const storage = new InMemoryStorageAdapter();
    storage.setItem(
      'foundry.current',
      JSON.stringify({
        repositoryVersion: 1,
        generation: 1,
        snapshot: { ...makeSnapshot(), schemaVersion: 99 },
      }),
    );
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'invalid-correlation');

    expect(repository.load()).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_VALIDATION_ERROR', correlationId: 'invalid-correlation' },
    });
  });

  it('never serializes raw provider keys or secret-shaped fields', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'secret-correlation');
    const unsafe = {
      ...makeSnapshot(),
      providerKey: 'provider-secret-value',
    } as ProjectSnapshot;

    const result = repository.save(unsafe);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SECRET_MATERIAL_REJECTED', correlationId: 'secret-correlation' },
    });
    expect(storage.getItem('foundry.current')).toBeNull();
  });

  it('rejects secret material embedded in an otherwise valid text field', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'secret-value-correlation');
    const snapshot = makeSnapshot();
    const unsafe = {
      ...snapshot,
      project: {
        ...snapshot.project,
        specialist: { ...snapshot.project.specialist, purpose: 'sk-live_1234567890abcdefghijklmnop' },
      },
    } as ProjectSnapshot;

    expect(repository.save(unsafe)).toMatchObject({
      ok: false,
      error: { code: 'SECRET_MATERIAL_REJECTED', correlationId: 'secret-value-correlation' },
    });
    expect(storage.getItem('foundry.current')).toBeNull();
  });

  it('rejects invalid nested snapshot references', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'nested-correlation');
    const invalid = { ...makeSnapshot(), championVersionId: 'missing-version' } as ProjectSnapshot;

    expect(repository.save(invalid)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_VALIDATION_ERROR', correlationId: 'nested-correlation' },
    });
  });

  it('rejects fabricated approved feedback metadata', () => {
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(storage, 'foundry', () => 'feedback-correlation');
    const snapshot = makeSnapshot();
    const invalid = {
      ...snapshot,
      feedbackEvents: [{
        schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
        id: 'feedback-1',
        projectId: snapshot.project.id,
        rating: 'invented',
        evidenceHash: 'not-a-hash',
        consent: { approved: true },
        createdAt: NOW,
      }],
    } as unknown as ProjectSnapshot;

    expect(repository.save(invalid)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_VALIDATION_ERROR', correlationId: 'feedback-correlation' },
    });
  });
});

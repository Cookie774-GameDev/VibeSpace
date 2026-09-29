import { describe, expect, it } from 'vitest';
import type { FoundryResult, ProjectSnapshot } from './domain';
import { createFixtureBase, createFixtureDataset } from './demoFixtures';
import { DeterministicFixtureBackend } from './fixtureBackend';
import {
  deleteLocalFoundryDraft,
  FOUNDRY_DRAFT_CATALOG_KEY,
  FOUNDRY_DRAFT_PRIVATE_CASES_KEY,
  FOUNDRY_DRAFT_REPOSITORY_PREFIX,
} from './draftDeletion';
import { InMemoryStorageAdapter, VersionedFixtureRepository } from './localRepository';
import { VIBECODER_TEMPLATE } from './validation';

const NOW = '2026-09-29T05:00:00.000Z';

function unwrap<T>(result: FoundryResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function snapshots() {
  let nextId = 0;
  const backend = new DeterministicFixtureBackend({
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++nextId}`,
  });
  const keep = unwrap(backend.createProject(VIBECODER_TEMPLATE));
  const created = unwrap(
    backend.createProject({ ...VIBECODER_TEMPLATE, id: 'qa-local-draft', name: 'QA local draft' }),
  );
  unwrap(backend.attachBaseModel(created.project.id, createFixtureBase(NOW)));
  const draft = unwrap(
    backend.attachDatasetVersion(
      created.project.id,
      createFixtureDataset(created.project.id, NOW, created.project.specialist),
    ),
  );
  return { backend, keep, draft };
}

function input(
  storage: InMemoryStorageAdapter,
  draft: ProjectSnapshot,
  catalog: readonly ProjectSnapshot[],
) {
  return {
    storage,
    active: draft,
    catalog,
    adapterCount: 0,
    deploymentCount: 0,
    metadataSyncEnabled: false,
  };
}

describe('local Foundry draft deletion', () => {
  it('removes an active dataset draft without changing another specialist or its private cases', () => {
    const { keep, draft } = snapshots();
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(keep));
    unwrap(repository.save(draft));
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft, keep]));
    storage.setItem(
      FOUNDRY_DRAFT_PRIVATE_CASES_KEY,
      JSON.stringify({
        [draft.project.id]: [{ id: 'qa-case' }],
        [keep.project.id]: [{ id: 'keep-case' }],
      }),
    );

    const result = deleteLocalFoundryDraft(input(storage, draft, [draft, keep]));

    expect(result.active?.project.id).toBe(keep.project.id);
    expect(result.catalog.map((project) => project.project.id)).toEqual([keep.project.id]);
    expect(unwrap(repository.load())?.project.id).toBe(keep.project.id);
    expect(storage.getItem(`${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.backup`)).toBeNull();
    expect(JSON.parse(storage.getItem(FOUNDRY_DRAFT_PRIVATE_CASES_KEY) ?? '{}')).toEqual({
      [keep.project.id]: [{ id: 'keep-case' }],
    });
  });

  it('clears current and backup when the deleted draft is the only specialist', () => {
    const { draft } = snapshots();
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(draft));
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft]));

    const result = deleteLocalFoundryDraft(input(storage, draft, [draft]));

    expect(result.active).toBeNull();
    expect(result.catalog).toEqual([]);
    expect(unwrap(repository.load())).toBeNull();
    expect(storage.getItem(`${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.backup`)).toBeNull();
  });

  it('refuses deletion when training, adapters, deployments, metadata sync, or a native run can own artifacts', () => {
    const { draft, backend } = snapshots();
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft]));
    const originalCatalog = storage.getItem(FOUNDRY_DRAFT_CATALOG_KEY);

    unwrap(
      backend.startTraining(draft.project.id, {
        method: 'lora',
        config: {
          epochs: 1,
          learningRate: 0.0002,
          rank: 8,
          seed: 7,
          batchSize: 1,
          gradientAccumulationSteps: 1,
          sequenceLength: 256,
          validationSplit: 0.1,
        },
      }),
    );
    const trained = unwrap(backend.getProject(draft.project.id));
    expect(() => deleteLocalFoundryDraft(input(storage, trained, [trained]))).toThrow(
      /training|draft/i,
    );
    expect(() =>
      deleteLocalFoundryDraft({ ...input(storage, draft, [draft]), adapterCount: 1 }),
    ).toThrow(/adapter/i);
    expect(() =>
      deleteLocalFoundryDraft({ ...input(storage, draft, [draft]), deploymentCount: 1 }),
    ).toThrow(/deployment/i);
    expect(() =>
      deleteLocalFoundryDraft({ ...input(storage, draft, [draft]), metadataSyncEnabled: true }),
    ).toThrow(/sync/i);
    storage.setItem(
      'vibespace.model-foundry.real-adapters.v1',
      JSON.stringify([{ projectId: draft.project.id }]),
    );
    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft]))).toThrow(/adapter/i);
    storage.removeItem('vibespace.model-foundry.real-adapters.v1');
    storage.setItem(
      'vibespace.model-foundry.deployments.v1',
      JSON.stringify([{ projectId: draft.project.id }]),
    );
    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft]))).toThrow(/deployment/i);
    storage.removeItem('vibespace.model-foundry.deployments.v1');
    storage.setItem(
      'vibespace.model-foundry.native-runs.v1',
      JSON.stringify({ [draft.project.id]: { jobId: 'real-qa' } }),
    );
    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft]))).toThrow(/native run/i);
    expect(storage.getItem(FOUNDRY_DRAFT_CATALOG_KEY)).toBe(originalCatalog);
  });

  it('rolls back every touched storage key when catalog persistence fails', () => {
    const { keep, draft } = snapshots();
    class FailingStorage extends InMemoryStorageAdapter {
      failCatalogOnce = false;
      override setItem(key: string, value: string): void {
        if (key === FOUNDRY_DRAFT_CATALOG_KEY && this.failCatalogOnce) {
          this.failCatalogOnce = false;
          throw new Error('synthetic storage failure');
        }
        super.setItem(key, value);
      }
    }
    const storage = new FailingStorage();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(keep));
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft, keep]));
    const keys = [
      FOUNDRY_DRAFT_CATALOG_KEY,
      `${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.current`,
      `${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.backup`,
      FOUNDRY_DRAFT_PRIVATE_CASES_KEY,
    ];
    const before = keys.map((key) => storage.getItem(key));
    storage.failCatalogOnce = true;

    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft, keep]))).toThrow(/storage/i);
    expect(keys.map((key) => storage.getItem(key))).toEqual(before);
    expect(unwrap(repository.load())?.project.id).toBe(draft.project.id);
  });

  it('refuses to strand an uncatalogued backup when the draft is the only listed specialist', () => {
    const { keep, draft } = snapshots();
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(keep));
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft]));

    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft]))).toThrow(/backup/i);
    expect(unwrap(repository.load())?.project.id).toBe(draft.project.id);
  });

  it('refuses a stale draft when the current snapshot gained training state', () => {
    const { draft, backend } = snapshots();
    const storage = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      storage,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'test-correlation',
    );
    unwrap(repository.save(draft));
    storage.setItem(FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify([draft]));
    unwrap(
      backend.startTraining(draft.project.id, {
        method: 'lora',
        config: {
          epochs: 1,
          learningRate: 0.0002,
          rank: 8,
          seed: 7,
          batchSize: 1,
          gradientAccumulationSteps: 1,
          sequenceLength: 256,
          validationSplit: 0.1,
        },
      }),
    );
    const trained = unwrap(backend.getProject(draft.project.id));
    unwrap(repository.save(trained));

    expect(() => deleteLocalFoundryDraft(input(storage, draft, [draft]))).toThrow(
      /saved snapshot|changed/i,
    );
    expect(unwrap(repository.load())?.trainingJobs).toHaveLength(1);
  });
});

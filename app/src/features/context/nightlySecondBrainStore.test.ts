import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SECOND_BRAIN_CONFIG, type SecondBrainRun } from './nightlySecondBrain';
import {
  getNightlySecondBrainScope,
  resetNightlySecondBrainStoreForTests,
  useNightlySecondBrainStore,
} from './nightlySecondBrainStore';

const model = {
  id: 'local:model',
  label: 'Local model',
  local: true,
  provider: 'ollama',
  modelId: 'model',
};

function run(id: string, scheduledFor: number): SecondBrainRun {
  return {
    id,
    scheduledFor,
    startedAt: scheduledFor,
    completedAt: scheduledFor + 1,
    status: 'applied',
    mode: 'auto',
    model,
    changes: [],
    summary: 'Applied.',
  };
}

describe('Nightly Second Brain scoped persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetNightlySecondBrainStoreForTests();
  });

  it('keeps configuration and run history isolated by account, workspace, and project', () => {
    const first = 'account-a:workspace-a:project-a';
    const second = 'account-b:workspace-b:project-b';
    const store = useNightlySecondBrainStore.getState();

    store.setEnabled(first, true);
    store.setModel(first, model);
    store.recordRun(first, run('run-a', 100));

    expect(getNightlySecondBrainScope(first)).toMatchObject({
      config: { enabled: true, model },
      runs: [{ id: 'run-a' }],
    });
    expect(getNightlySecondBrainScope(second)).toEqual({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        sources: { ...DEFAULT_SECOND_BRAIN_CONFIG.sources },
      },
      runs: [],
    });
  });

  it('preserves the exact reviewed Context Map identity in pending persisted changes', async () => {
    const scope = 'account-a:workspace-a:project-a';
    useNightlySecondBrainStore.getState().recordRun(scope, {
      ...run('pending-map-change', 100),
      status: 'pending_approval',
      changes: [
        {
          id: 'change-a',
          target: 'context_map',
          targetMapId: 'map-reviewed',
          path: '/project/context_map.json',
          before: 'before',
          after: 'after',
          provenance: ['chat:1'],
          confidence: 0.9,
        },
      ],
    });

    const persisted = window.localStorage.getItem('vibespace-nightly-second-brain-v1');
    resetNightlySecondBrainStoreForTests();
    if (persisted) {
      window.localStorage.setItem('vibespace-nightly-second-brain-v1', persisted);
    }
    await useNightlySecondBrainStore.persist.rehydrate();

    expect(getNightlySecondBrainScope(scope).runs[0].changes[0]).toMatchObject({
      targetMapId: 'map-reviewed',
      path: '/project/context_map.json',
    });
  });

  it('does not project legacy global private runs into a newly active account scope', async () => {
    window.localStorage.setItem(
      'vibespace-nightly-second-brain-v1',
      JSON.stringify({
        state: {
          config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
          runs: [run('legacy-private-run', 100)],
        },
        version: 2,
      }),
    );

    await useNightlySecondBrainStore.persist.rehydrate();

    expect(getNightlySecondBrainScope('account-new:workspace-new:project-new')).toEqual({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        sources: { ...DEFAULT_SECOND_BRAIN_CONFIG.sources },
      },
      runs: [],
    });
  });

  it('recovers a corrupted scoped entry without exposing its payload', async () => {
    window.localStorage.setItem(
      'vibespace-nightly-second-brain-v1',
      JSON.stringify({
        state: {
          scopes: {
            'account-a:workspace-a:project-a': {
              config: { enabled: 'definitely', model: { provider: 42 } },
              runs: [{ id: 'private-corrupt-run', summary: { raw: 'private payload' } }],
            },
          },
        },
        version: 3,
      }),
    );

    await useNightlySecondBrainStore.persist.rehydrate();

    expect(getNightlySecondBrainScope('account-a:workspace-a:project-a')).toEqual({
      config: {
        ...DEFAULT_SECOND_BRAIN_CONFIG,
        sources: { ...DEFAULT_SECOND_BRAIN_CONFIG.sources },
      },
      runs: [],
    });
  });

  it('rejects prototype-polluting scope keys and reconstructs a null-prototype dictionary', async () => {
    const validScope = JSON.stringify({
      config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
      runs: [run('polluting-run', 100)],
    });
    window.localStorage.setItem(
      'vibespace-nightly-second-brain-v1',
      `{"state":{"scopes":{"__proto__":${validScope},"prototype":${validScope},"constructor":${validScope}}},"version":3}`,
    );

    await useNightlySecondBrainStore.persist.rehydrate();

    const scopes = useNightlySecondBrainStore.getState().scopes;
    expect(Object.getPrototypeOf(scopes)).toBeNull();
    expect(Object.keys(scopes)).toEqual([]);
    useNightlySecondBrainStore.getState().setEnabled('__proto__', true);
    expect(Object.keys(useNightlySecondBrainStore.getState().scopes)).toEqual([]);
  });

  it('drops oversized persisted model, change, run, and provenance strings', async () => {
    const safeRun = run('safe-run', 100);
    const baseChange = {
      id: 'change',
      target: 'related_markdown',
      path: 'C:\\project\\.vibespace\\second-brain.md',
      before: '',
      after: 'bounded fact',
      provenance: ['chat:1'],
      confidence: 0.9,
    };
    const unsafeRuns = [
      { ...safeRun, id: 'x'.repeat(513) },
      {
        ...safeRun,
        id: 'oversized-change',
        changes: [{ ...baseChange, after: 'x'.repeat(10_001) }],
      },
      {
        ...safeRun,
        id: 'oversized-provenance',
        changes: [{ ...baseChange, provenance: ['x'.repeat(513)] }],
      },
      { ...safeRun, id: 'oversized-retry', retryOf: 'x'.repeat(513) },
    ];
    window.localStorage.setItem(
      'vibespace-nightly-second-brain-v1',
      JSON.stringify({
        state: {
          scopes: {
            safe: {
              config: { ...DEFAULT_SECOND_BRAIN_CONFIG, enabled: true, model },
              runs: [safeRun, ...unsafeRuns],
            },
            'oversized-model': {
              config: {
                ...DEFAULT_SECOND_BRAIN_CONFIG,
                enabled: true,
                model: { ...model, modelId: 'x'.repeat(513) },
              },
              runs: [],
            },
          },
        },
        version: 3,
      }),
    );

    await useNightlySecondBrainStore.persist.rehydrate();

    expect(getNightlySecondBrainScope('safe').runs.map(({ id }) => id)).toEqual(['safe-run']);
    expect(useNightlySecondBrainStore.getState().scopes).not.toHaveProperty('oversized-model');
  });
});

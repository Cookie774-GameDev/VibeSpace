import { describe, expect, it } from 'vitest';
import { createFixtureBase, createFixtureDataset } from './demoFixtures';
import { DeterministicFixtureBackend } from './fixtureBackend';
import { foundryMetadataPayload } from './metadataSync';
import { VIBECODER_TEMPLATE } from './validation';

const NOW = '2026-07-14T00:00:00.000Z';

function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!result.ok) throw new Error('Fixture setup failed');
  return result.value;
}

describe('foundryMetadataPayload', () => {
  it('keeps approved dataset contents out of the optional sync payload', () => {
    let sequence = 0;
    const backend = new DeterministicFixtureBackend({ clock: () => NOW, idFactory: (kind) => `${kind}-${++sequence}` });
    const created = unwrap(backend.createProject(VIBECODER_TEMPLATE));
    const dataset = createFixtureDataset(created.project.id, NOW, created.project.specialist);
    unwrap(backend.attachBaseModel(created.project.id, createFixtureBase(NOW)));
    const snapshot = unwrap(backend.attachDatasetVersion(created.project.id, dataset));

    const payload = foundryMetadataPayload(snapshot);
    const serialized = JSON.stringify(payload);

    expect(payload).toMatchObject({ dataset: { manifestHash: dataset.manifestHash, includedCount: 1 } });
    expect(serialized).not.toContain(dataset.examples[0]!.input);
    expect(serialized).not.toContain(dataset.examples[0]!.expectedOutput);
    expect(Object.keys(payload).sort()).toEqual([
      'baseModel', 'championVersionId', 'dataset', 'evaluations', 'jobs',
      'localProjectId', 'modelVersions', 'promotionHistory', 'schemaVersion', 'updatedAt',
    ]);
  });
});

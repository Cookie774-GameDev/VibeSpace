import { describe, expect, it } from 'vitest';
import { buildDatasetVersion, buildLocalSyntheticVariation, parseScopedDatasetImport, redactDatasetText, scanDatasetText } from './datasetStudio';

const NOW = '2026-07-14T12:00:00.000Z';

function options() {
  return { projectId: 'project-1', datasetId: 'reviews', version: 1, parentVersionId: null, actorId: 'owner', consentApproved: true, consentPurpose: 'Approved local training.', now: NOW, seed: 7 } as const;
}

describe('Dataset Studio governance', () => {
  it('quarantines secrets and PII and supports explicit redaction', () => {
    const text = 'email me at person@example.com with sk-abcdefghijklmnopqrstuvwxyz1234';
    const findings = scanDatasetText(text);
    expect(findings.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['email', 'api_key']));
    const redacted = redactDatasetText(text, findings);
    expect(redacted).not.toContain('person@example.com');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
  });

  it('imports only the explicitly supplied JSONL rows', () => {
    const drafts = parseScopedDatasetImport('jsonl', '{"input":"a","output":"b"}\n{"input":"c","output":"d"}', 'local://selected.jsonl');
    expect(drafts).toHaveLength(2);
    expect(drafts.every(({ sourceKind }) => sourceKind === 'jsonl')).toBe(true);
  });

  it('builds an immutable valid version while excluding duplicates', async () => {
    const draft = { input: 'Review this function.', expectedOutput: 'No side effects.', exampleType: 'code_patch' as const, sourceKind: 'manual' as const, sourceReference: 'local://manual/1', license: 'user-owned', privacyClassification: 'private' as const, tags: ['review'] };
    const result = await buildDatasetVersion([draft, draft], options());
    expect(result.manifest.examples).toHaveLength(1);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.manifest.splitStrategy.statistics).toEqual({ train: 1, validation: 0, test: 0 });
    expect(Object.isFrozen(result.manifest)).toBe(true);
  });

  it('labels deterministic local variations as synthetic provenance', async () => {
    const draft = buildLocalSyntheticVariation({ input: 'Review this function.', expectedOutput: 'No side effects.', exampleType: 'code_patch', sourceKind: 'manual', sourceReference: 'local://manual/1', license: 'user-owned', privacyClassification: 'private', tags: ['review'] });
    const result = await buildDatasetVersion([draft], options());
    expect(result.manifest.examples[0]).toMatchObject({ synthetic: true, authorType: 'synthetic_generator', source: { kind: 'licensed', reference: expect.stringContaining('local-synthetic-template') } });
  });

  it('refuses to build when clean examples or explicit consent are missing', async () => {
    const unsafe = { input: 'password=hunter22', expectedOutput: 'Never store it.', exampleType: 'prompt_completion' as const, sourceKind: 'manual' as const, sourceReference: 'local://manual/1', license: 'user-owned', privacyClassification: 'private' as const, tags: [] };
    await expect(buildDatasetVersion([unsafe], options())).rejects.toThrow(/No clean/);
    await expect(buildDatasetVersion([{ ...unsafe, input: 'safe' }], { ...options(), consentApproved: false })).rejects.toThrow(/consent/);
  });
});

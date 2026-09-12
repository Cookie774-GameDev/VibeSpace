import { describe, expect, it } from 'vitest';
import type {
  BaseModelRecord,
  DatasetVersionManifest,
  SpecialistDefinition,
  TrainingJobSnapshot,
} from './domain';
import {
  CURRENT_FOUNDRY_SCHEMA_VERSION,
  MAX_IDENTIFIER_LENGTH,
  MAX_NAME_LENGTH,
  VIBECODER_TEMPLATE,
  validateBaseModel,
  validateDatasetVersion,
  validateSpecialist,
  validateTrainingJob,
} from './validation';

const NOW = '2026-07-13T12:00:00.000Z';
const HASH = 'a'.repeat(64);

function specialist(overrides: Partial<SpecialistDefinition> = {}): SpecialistDefinition {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'fixture-coder',
    name: 'Fixture Coder',
    purpose: 'Review small TypeScript changes with explicit constraints.',
    objective: 'Produce evidence-backed TypeScript review findings.',
    nonGoals: ['Running code or modifying repositories.'],
    inputSchema: {
      type: 'object',
      required: ['change'],
      properties: { change: { type: 'string', description: 'A local TypeScript change.' } },
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: { findings: { type: 'array', description: 'Evidence-backed findings.' } },
    },
    expectedInputs: ['A TypeScript change and its acceptance criteria.'],
    expectedOutputs: ['A concise review with file-scoped findings.'],
    constraints: ['Never claim to execute code or access files that were not provided.'],
    behaviorRequirements: ['Tie each finding to supplied evidence.'],
    forbiddenBehavior: ['Do not execute tools.'],
    toolPermissions: { mode: 'none', allowedTools: [] },
    privacyPolicy: { classification: 'private', localOnly: true, retention: 'project_lifetime' },
    dataPolicy: { trainingUse: 'approved_only', externalTransfer: false, rawDataLogging: false },
    latencyTarget: { kind: 'maximum', maxMilliseconds: 8_000 },
    memoryTarget: { kind: 'maximum', maxBytes: 1_073_741_824 },
    evaluationRubric: {
      criteria: [{ id: 'evidence', description: 'Finding is supported.', weight: 1 }],
    },
    safetyRubric: { requiredChecks: ['no-secret-disclosure'] },
    commercialIntent: 'personal',
    modelLicenseConstraints: ['Permissive local-use license required.'],
    promotionThreshold: { metricId: 'accepted-findings', minimumValue: 0.8 },
    regressionThreshold: { metricId: 'accepted-findings', maximumRegression: 0.05 },
    owner: 'local-owner',
    version: 1,
    successMetrics: [
      {
        id: 'accepted-findings',
        name: 'Accepted findings',
        description: 'Fraction of findings accepted by a reviewer.',
        target: 0.8,
        unit: 'ratio',
        direction: 'at_least',
      },
    ],
    privacyMode: 'local_only',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseModel(overrides: Partial<BaseModelRecord> = {}): BaseModelRecord {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'fixture-base',
    displayName: 'Fixture Base',
    backend: 'fixture',
    sourceUri: 'fixture://models/base',
    revision: 'fixture-rev-1',
    license: 'Apache-2.0',
    parameterCount: 1_000_000,
    quantization: 'fixture-int4',
    sizeBytes: 1024,
    checksum: { algorithm: 'sha256', value: HASH },
    minimumResources: { ramBytes: 2048, vramBytes: 0, diskBytes: 4096 },
    trustStatus: 'approved',
    compatibilityStatus: 'compatible',
    remoteCode: { supported: false, requested: false },
    createdAt: NOW,
    ...overrides,
  };
}

function dataset(overrides: Partial<DatasetVersionManifest> = {}): DatasetVersionManifest {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'dataset-v1',
    datasetId: 'dataset',
    version: 1,
    manifestHash: HASH,
    examples: [
      {
        id: 'example-1',
        projectId: 'project-1',
        datasetVersionId: 'dataset-v1',
        exampleType: 'prompt_completion',
        createdAt: NOW,
        input: 'Review this pure function.',
        expectedOutput: 'The function is deterministic.',
        split: 'train',
        labels: ['review'],
        tags: ['typescript'],
        contentHash: HASH,
        provenance: { sourceId: 'local-example-1', sourceVersion: '1' },
        authorType: 'user',
        synthetic: false,
        license: 'user-owned',
        privacyClassification: 'private',
        qualityStatus: 'approved',
        approvalStatus: 'approved',
        secretScanStatus: 'passed',
        duplicateGroupId: null,
        tokenEstimate: 12,
        testEvidence: 'fixture://evidence/example-1',
        reviewerId: 'local-owner',
        rejectionReason: null,
        source: {
          kind: 'user_authored',
          reference: 'local://examples/1',
          approved: true,
        },
        consent: {
          approved: true,
          actorId: 'local-owner',
          approvedAt: NOW,
          purpose: 'Local fixture training evaluation.',
        },
      },
    ],
    scanSummary: { status: 'passed', scanner: 'fixture-static-scan', issueCount: 0 },
    qualitySummary: { status: 'passed', score: 0.9, reviewedBy: 'local-owner' },
    fingerprint: HASH,
    parentVersionId: null,
    includedExampleIds: ['example-1'],
    excludedExampleIds: [],
    splitStrategy: {
      method: 'deterministic_hash',
      seed: 7,
      statistics: { train: 1, validation: 0, test: 0 },
    },
    licenseReport: { status: 'passed', licenses: ['user-owned'], issueCount: 0 },
    secretScanReport: { status: 'passed', scanner: 'fixture-static-scan', issueCount: 0 },
    lineage: { parentVersionId: null, sourceDatasetIds: [], feedbackEventIds: [] },
    createdAt: NOW,
    ...overrides,
  };
}

describe('model foundry validation', () => {
  it('exports a valid, local-only VibeCoder specialist with measurable criteria', () => {
    const result = validateSpecialist(VIBECODER_TEMPLATE);

    expect(result.valid).toBe(true);
    expect(VIBECODER_TEMPLATE.privacyMode).toBe('local_only');
    expect(VIBECODER_TEMPLATE.purpose.toLowerCase()).toContain('coding');
    expect(VIBECODER_TEMPLATE.successMetrics.length).toBeGreaterThan(0);
    expect(VIBECODER_TEMPLATE.successMetrics.every((metric) => Number.isFinite(metric.target))).toBe(true);
    expect(VIBECODER_TEMPLATE).toMatchObject({
      objective: expect.any(String),
      nonGoals: expect.any(Array),
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      toolPermissions: { mode: 'none' },
      privacyPolicy: { localOnly: true },
      dataPolicy: { externalTransfer: false },
      evaluationRubric: { criteria: expect.any(Array) },
      safetyRubric: { requiredChecks: expect.any(Array) },
      owner: expect.any(String),
      version: 1,
    });
  });

  it.each([
    ['', 'blank'],
    ['a'.repeat(MAX_IDENTIFIER_LENGTH + 1), 'long'],
    ['../escape', 'traversal'],
    ['folder/name', 'separator'],
    ['bad\\name', 'separator'],
    ['bad\u0000id', 'control'],
    ['model;rm', 'shell'],
  ])('rejects unsafe specialist ids (%s: %s) with a field path', (id) => {
    const result = validateSpecialist(specialist({ id }));

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path.join('.') === 'id')).toBe(true);
    }
  });

  it('rejects blank and excessively long human-facing text without throwing', () => {
    expect(() => validateSpecialist(specialist({ purpose: ' ' }))).not.toThrow();
    const result = validateSpecialist(
      specialist({ name: 'n'.repeat(MAX_NAME_LENGTH + 1), purpose: ' ' }),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['name', 'purpose']),
      );
    }
  });

  it('rejects invalid hashes, resources, schema versions, and remote-code requests', () => {
    const result = validateBaseModel(
      baseModel({
        schemaVersion: 99 as 1,
        checksum: { algorithm: 'sha256', value: 'not-a-hash' },
        sizeBytes: -1,
        minimumResources: { ramBytes: -1, vramBytes: 0, diskBytes: -1 },
        remoteCode: { supported: true as false, requested: true },
      }),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'schemaVersion',
          'checksum.value',
          'sizeBytes',
          'minimumResources.ramBytes',
          'minimumResources.diskBytes',
          'remoteCode.supported',
          'remoteCode.requested',
        ]),
      );
    }
  });

  it('rejects dataset manifests whose provenance IDs and split statistics do not reconcile', () => {
    const original = dataset();
    const result = validateDatasetVersion(
      dataset({
        examples: [{ ...original.examples[0], datasetVersionId: 'other-version' }],
        includedExampleIds: ['missing-example'],
        excludedExampleIds: ['example-1'],
        splitStrategy: {
          ...original.splitStrategy,
          statistics: { train: 0, validation: 1, test: 0 },
        },
      }),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'examples.0.datasetVersionId',
          'includedExampleIds',
          'excludedExampleIds',
          'splitStrategy.statistics.train',
          'splitStrategy.statistics.validation',
        ]),
      );
    }
  });

  it('rejects dataset examples without approved source, consent, hashes, or lineage', () => {
    const invalidExample = {
      ...dataset().examples[0]!,
      contentHash: 'bad',
      source: { ...dataset().examples[0]!.source, approved: false },
      consent: { ...dataset().examples[0]!.consent, approved: false, actorId: '' },
    };
    const result = validateDatasetVersion(
      dataset({
        manifestHash: 'bad',
        examples: [invalidExample],
        lineage: undefined as unknown as DatasetVersionManifest['lineage'],
      }),
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'manifestHash',
          'examples.0.contentHash',
          'examples.0.source.approved',
          'examples.0.consent.approved',
          'examples.0.consent.actorId',
          'lineage',
        ]),
      );
    }
  });

  it.each([
    [{ state: 'completed', progress: 0.99 }, 'progress'],
    [{ state: 'interrupted', recovery: { recoverable: false } }, 'recovery.recoverable'],
    [{ state: 'cancelled', cancellation: undefined }, 'cancellation'],
    [{ sequence: -1 }, 'sequence'],
  ])('rejects future-invalid training lifecycle combinations', (change, expectedPath) => {
    const job: TrainingJobSnapshot = {
      schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
      id: 'job-1',
      projectId: 'project-1',
      manifestId: 'manifest-1',
      backend: 'fixture',
      state: 'training',
      sequence: 2,
      progress: 0.5,
      createdAt: NOW,
      updatedAt: NOW,
      recovery: { recoverable: true },
      ...change,
    } as TrainingJobSnapshot;

    const result = validateTrainingJob(job);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path.join('.') === expectedPath)).toBe(true);
    }
  });
});

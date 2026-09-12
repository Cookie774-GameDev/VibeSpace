import type { BaseModelRecord, DatasetVersionManifest, EvaluationSuite, SpecialistDefinition } from './domain';
import { CURRENT_FOUNDRY_SCHEMA_VERSION } from './validation';

const HASH = 'b'.repeat(64);

export function createFixtureBase(now: string): BaseModelRecord {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION, id: 'fixture-base', displayName: 'Fixture Base',
    backend: 'fixture', sourceUri: 'fixture://models/base', revision: 'fixture-r1', license: 'Apache-2.0',
    parameterCount: 1_000_000, quantization: 'fixture-int4', sizeBytes: 1024,
    checksum: { algorithm: 'sha256', value: HASH }, minimumResources: { ramBytes: 1024, vramBytes: 0, diskBytes: 2048 },
    trustStatus: 'approved', compatibilityStatus: 'compatible', remoteCode: { supported: false, requested: false }, createdAt: now,
  };
}

export function createFixtureDataset(projectId: string, now: string, specialist?: SpecialistDefinition): DatasetVersionManifest {
  const input = specialist?.expectedInputs[0] ?? 'Review a pure TypeScript function.';
  const expectedOutput = specialist?.expectedOutputs[0] ?? 'Report only evidence-backed findings.';
  const tag = specialist?.id ?? 'code-review';
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION, id: 'dataset-v1', datasetId: 'vibecoder-examples', version: 1,
    manifestHash: HASH,
    examples: [{
      id: 'example-1', projectId, datasetVersionId: 'dataset-v1', exampleType: 'prompt_completion', createdAt: now,
      input, expectedOutput, split: 'train',
      labels: [tag], tags: [tag, 'fixture'], contentHash: HASH,
      provenance: { sourceId: 'local-example-1', sourceVersion: '1' }, authorType: 'user', synthetic: false,
      license: 'user-owned', privacyClassification: 'private', qualityStatus: 'approved', approvalStatus: 'approved',
      secretScanStatus: 'passed', duplicateGroupId: null, tokenEstimate: 12, testEvidence: 'fixture://evidence/example-1',
      reviewerId: 'local-owner', rejectionReason: null,
      source: { kind: 'user_authored', reference: 'local://example/1', approved: true },
      consent: { approved: true, actorId: 'local-owner', approvedAt: now, purpose: 'Local fixture training.' },
    }],
    scanSummary: { status: 'passed', scanner: 'fixture-static', issueCount: 0 },
    qualitySummary: { status: 'passed', score: 0.95, reviewedBy: 'local-owner' }, fingerprint: HASH,
    parentVersionId: null, includedExampleIds: ['example-1'], excludedExampleIds: [],
    splitStrategy: { method: 'deterministic_hash', seed: 7, statistics: { train: 1, validation: 0, test: 0 } },
    licenseReport: { status: 'passed', licenses: ['user-owned'], issueCount: 0 },
    secretScanReport: { status: 'passed', scanner: 'fixture-static', issueCount: 0 },
    lineage: { parentVersionId: null, sourceDatasetIds: [], feedbackEventIds: [] }, createdAt: now,
  };
}

export function createFixtureEvaluation(now: string, specialist?: SpecialistDefinition): EvaluationSuite {
  const metric = specialist?.successMetrics[0];
  const metricId = metric?.id ?? 'quality';
  const metricName = metric?.name ?? 'Review quality';
  const minimumValue = specialist?.promotionThreshold.minimumValue ?? 0.8;
  const allowedRegression = specialist?.regressionThreshold.maximumRegression ?? 0.05;
  const targetCapability = specialist?.id ?? 'evidence-backed-code-review';
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION, id: 'vibecoder-fixture-suite', name: 'VibeCoder fixture gates', version: 1,
    targetCapability, description: 'Deterministic local evaluation with a hidden case.',
    hiddenStatus: 'all_hidden', caseIds: ['hidden-case-1'], rubric: 'Meet quality threshold with no safety failures.',
    deterministicChecks: ['quality-threshold', 'safety-failure-count'], judgeConfiguration: { kind: 'deterministic_fixture', modelId: null },
    requiredSafetyCaseIds: ['hidden-case-1'], promotionThresholds: { [metricId]: minimumValue }, regressionThresholds: { [metricId]: allowedRegression },
    owner: 'local-owner', fingerprint: HASH, createdAt: now,
    metricDefinitions: [{ id: metricId, name: metricName, direction: 'higher_better', allowedRegression }],
    cases: [{
      id: 'hidden-case-1', hidden: true, contentHash: HASH, input: 'Hidden local fixture input.',
      permittedContext: ['No external context.'], expectedSchema: { type: 'object', required: ['findings'] },
      timeoutMilliseconds: 1000, outputCharacterLimit: 2000, allowedTools: [], forbiddenTools: ['network', 'shell'],
      privacyClassification: 'private', tags: ['code-review', 'safety'], difficulty: 'basic',
      expectedEvidence: [`${metricId} metric`, 'safety failure list'],
      fixtureEvidence: { baseMetrics: { [metricId]: 0.7 }, candidateMetrics: { [metricId]: Math.max(0.88, minimumValue) }, safetyFailures: [] },
    }],
  };
}

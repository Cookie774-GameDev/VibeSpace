import { describe, expect, it } from 'vitest';
import type {
  BaseModelRecord,
  DatasetVersionManifest,
  EvaluationSuite,
  FoundryResult,
  ProjectSnapshot,
  SpecialistDefinition,
} from './domain';
import { DeterministicFixtureBackend } from './fixtureBackend';
import { CURRENT_FOUNDRY_SCHEMA_VERSION } from './validation';

const NOW = '2026-07-13T12:00:00.000Z';
const HASH = 'b'.repeat(64);

function unwrap<T>(result: FoundryResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function idFactory() {
  const counts = new Map<string, number>();
  return (kind: string) => {
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    return `${kind}-${next}`;
  };
}

function specialist(): SpecialistDefinition {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'code-reviewer',
    name: 'Code Reviewer',
    purpose: 'Review narrow TypeScript changes.',
    objective: 'Produce evidence-backed review findings.',
    nonGoals: ['Executing code or changing files.'],
    inputSchema: {
      type: 'object',
      required: ['diff'],
      properties: { diff: { type: 'string', description: 'A local code diff.' } },
    },
    outputSchema: {
      type: 'object',
      required: ['findings'],
      properties: { findings: { type: 'array', description: 'Review findings.' } },
    },
    expectedInputs: ['A local TypeScript diff.'],
    expectedOutputs: ['File-scoped review findings.'],
    constraints: ['Do not claim tools were run.'],
    behaviorRequirements: ['Cite supplied evidence.'],
    forbiddenBehavior: ['Do not execute tools.'],
    toolPermissions: { mode: 'none', allowedTools: [] },
    privacyPolicy: { classification: 'private', localOnly: true, retention: 'project_lifetime' },
    dataPolicy: { trainingUse: 'approved_only', externalTransfer: false, rawDataLogging: false },
    latencyTarget: { kind: 'maximum', maxMilliseconds: 8_000 },
    memoryTarget: { kind: 'maximum', maxBytes: 1_073_741_824 },
    evaluationRubric: {
      criteria: [{ id: 'precision-rubric', description: 'Finding is supported.', weight: 1 }],
    },
    safetyRubric: { requiredChecks: ['no-secret-disclosure'] },
    commercialIntent: 'personal',
    modelLicenseConstraints: ['Permissive local-use license required.'],
    promotionThreshold: { metricId: 'precision', minimumValue: 0.8 },
    regressionThreshold: { metricId: 'precision', maximumRegression: 0.05 },
    owner: 'owner',
    version: 1,
    successMetrics: [
      {
        id: 'precision',
        name: 'Finding precision',
        description: 'Share of accepted findings.',
        target: 0.8,
        unit: 'ratio',
        direction: 'at_least',
      },
    ],
    privacyMode: 'local_only',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseModel(): BaseModelRecord {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'fixture-base',
    displayName: 'Fixture Base',
    backend: 'fixture',
    sourceUri: 'fixture://models/base',
    revision: 'fixture-r1',
    license: 'Apache-2.0',
    parameterCount: 1_000_000,
    quantization: 'fixture-int4',
    sizeBytes: 1024,
    checksum: { algorithm: 'sha256', value: HASH },
    minimumResources: { ramBytes: 1024, vramBytes: 0, diskBytes: 2048 },
    trustStatus: 'approved',
    compatibilityStatus: 'compatible',
    remoteCode: { supported: false, requested: false },
    createdAt: NOW,
  };
}

function dataset(): DatasetVersionManifest {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'dataset-v1',
    datasetId: 'code-reviews',
    version: 1,
    manifestHash: HASH,
    examples: [
      {
        id: 'example-1',
        projectId: 'project-1',
        datasetVersionId: 'dataset-v1',
        exampleType: 'prompt_completion',
        createdAt: NOW,
        input: 'Review a pure function.',
        expectedOutput: 'No side effects detected.',
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
        tokenEstimate: 10,
        testEvidence: 'fixture://evidence/example-1',
        reviewerId: 'owner',
        rejectionReason: null,
        source: { kind: 'user_authored', reference: 'local://example/1', approved: true },
        consent: {
          approved: true,
          actorId: 'owner',
          approvedAt: NOW,
          purpose: 'Local fixture lifecycle.',
        },
      },
    ],
    scanSummary: { status: 'passed', scanner: 'fixture-static', issueCount: 0 },
    qualitySummary: { status: 'passed', score: 0.9, reviewedBy: 'owner' },
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
    secretScanReport: { status: 'passed', scanner: 'fixture-static', issueCount: 0 },
    lineage: { parentVersionId: null, sourceDatasetIds: [], feedbackEventIds: [] },
    createdAt: NOW,
  };
}

function evaluationSuite(options: {
  candidateScore?: number;
  championScore?: number;
  safetyFailures?: readonly string[];
} = {}): EvaluationSuite {
  return {
    schemaVersion: CURRENT_FOUNDRY_SCHEMA_VERSION,
    id: 'suite-1',
    name: 'Fixture hidden review suite',
    version: 1,
    targetCapability: 'evidence-backed-code-review',
    description: 'Deterministic local fixture review checks.',
    hiddenStatus: 'contains_hidden_cases',
    caseIds: ['hidden-case-1'],
    rubric: 'Higher quality without safety failures.',
    deterministicChecks: ['metric-threshold', 'safety-failure-count'],
    judgeConfiguration: { kind: 'deterministic_fixture', modelId: null },
    requiredSafetyCaseIds: ['hidden-case-1'],
    promotionThresholds: { quality: 0.8 },
    regressionThresholds: { quality: 0.05 },
    owner: 'owner',
    fingerprint: HASH,
    createdAt: NOW,
    metricDefinitions: [
      {
        id: 'quality',
        name: 'Review quality',
        direction: 'higher_better',
        allowedRegression: 0.05,
      },
    ],
    cases: [
      {
        id: 'hidden-case-1',
        hidden: true,
        contentHash: HASH,
        input: 'Hidden local fixture input.',
        permittedContext: ['No external context.'],
        expectedSchema: { type: 'object', required: ['findings'] },
        timeoutMilliseconds: 1_000,
        outputCharacterLimit: 2_000,
        allowedTools: [],
        forbiddenTools: ['network', 'shell'],
        privacyClassification: 'private',
        tags: ['code-review', 'safety'],
        difficulty: 'basic',
        expectedEvidence: ['quality metric', 'safety failure list'],
        fixtureEvidence: {
          baseMetrics: { quality: 0.7 },
          candidateMetrics: { quality: options.candidateScore ?? 0.85 },
          ...(options.championScore === undefined
            ? {}
            : { championMetrics: { quality: options.championScore } }),
          safetyFailures: options.safetyFailures ?? [],
        },
      },
    ],
  };
}

function preparedBackend() {
  const backend = new DeterministicFixtureBackend({ clock: () => NOW, idFactory: idFactory() });
  const project = unwrap(backend.createProject(specialist()));
  unwrap(backend.attachBaseModel(project.project.id, baseModel()));
  unwrap(backend.attachDatasetVersion(project.project.id, dataset()));
  return { backend, projectId: project.project.id };
}

function completeCandidate(backend: DeterministicFixtureBackend, projectId: string) {
  const job = unwrap(
    backend.startTraining(projectId, {
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
  const states = [];
  for (let index = 0; index < 4; index += 1) {
    states.push(unwrap(backend.advanceTraining(projectId, job.id)));
  }
  const completed = states.at(-1)!;
  return { job, states, candidateId: completed.artifact!.modelVersionId };
}

describe('DeterministicFixtureBackend', () => {
  it('creates a validated private fixture project and attaches immutable inputs', () => {
    const { backend, projectId } = preparedBackend();
    const snapshot = unwrap(backend.getProject(projectId));

    expect(snapshot.fixtureLabel).toBe('fixture');
    expect(snapshot.project.specialist.privacyMode).toBe('local_only');
    expect(snapshot.baseModel?.backend).toBe('fixture');
    expect(Object.isFrozen(snapshot.datasetVersion)).toBe(true);
    expect(Object.isFrozen(snapshot.datasetVersion?.examples)).toBe(true);
  });

  it('rejects an unapproved or incompatible base model', () => {
    const backend = new DeterministicFixtureBackend({ clock: () => NOW, idFactory: idFactory() });
    const project = unwrap(backend.createProject(specialist()));

    const result = backend.attachBaseModel(project.project.id, {
      ...baseModel(),
      trustStatus: 'unreviewed',
      compatibilityStatus: 'incompatible',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'BASE_MODEL_NOT_APPROVED' } });
  });

  it('advances through explicit fixture states with monotonic sequence and progress', () => {
    const { backend, projectId } = preparedBackend();
    const { job, states } = completeCandidate(backend, projectId);

    expect(job).toMatchObject({ backend: 'fixture', state: 'queued', sequence: 0, progress: 0 });
    expect(states.map(({ state }) => state)).toEqual([
      'preparing',
      'training',
      'checkpointing',
      'completed',
    ]);
    expect(states.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(states.map(({ progress }) => progress)).toEqual([0.1, 0.5, 0.85, 1]);
    expect(states[2]?.checkpoint).toMatchObject({ backend: 'fixture' });
    expect(states[3]?.artifact).toMatchObject({
      backend: 'fixture',
      kind: 'adapter',
      truthfulLabel: 'fixture-only; no training or GPU work occurred',
    });
    expect(unwrap(backend.getProject(projectId)).trainingManifest).toMatchObject({
      backend: 'fixture',
      baseRevision: 'fixture-r1',
      datasetVersionId: 'dataset-v1',
    });
  });

  it('allows only one active job and never advances terminal jobs', () => {
    const { backend, projectId } = preparedBackend();
    const job = unwrap(
      backend.startTraining(projectId, {
        method: 'qlora',
        config: { epochs: 1, learningRate: 0.0002, rank: 4, seed: 11, batchSize: 1, gradientAccumulationSteps: 1, sequenceLength: 256, validationSplit: 0.1 },
      }),
    );

    expect(
      backend.startTraining(projectId, {
        method: 'lora',
        config: { epochs: 1, learningRate: 0.0002, rank: 8, seed: 12, batchSize: 1, gradientAccumulationSteps: 1, sequenceLength: 256, validationSplit: 0.1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'ACTIVE_JOB_EXISTS' } });

    for (let index = 0; index < 4; index += 1) unwrap(backend.advanceTraining(projectId, job.id));
    expect(backend.advanceTraining(projectId, job.id)).toMatchObject({
      ok: false,
      error: { code: 'JOB_TERMINAL' },
    });
  });

  it('cancels an active job exactly once', () => {
    const { backend, projectId } = preparedBackend();
    const job = unwrap(
      backend.startTraining(projectId, {
        method: 'lora',
        config: { epochs: 1, learningRate: 0.0002, rank: 8, seed: 7, batchSize: 1, gradientAccumulationSteps: 1, sequenceLength: 256, validationSplit: 0.1 },
      }),
    );
    unwrap(backend.advanceTraining(projectId, job.id));

    const cancelled = unwrap(backend.cancelTraining(projectId, job.id, 'owner', 'No longer needed.'));

    expect(cancelled).toMatchObject({
      state: 'cancelled',
      sequence: 2,
      cancellation: { actorId: 'owner', reason: 'No longer needed.' },
    });
    expect(backend.cancelTraining(projectId, job.id, 'owner', 'Again.')).toMatchObject({
      ok: false,
      error: { code: 'JOB_TERMINAL' },
    });
  });

  it('reconciles a persisted running fixture job as recoverable interrupted state', () => {
    const { backend, projectId } = preparedBackend();
    const job = unwrap(
      backend.startTraining(projectId, {
        method: 'lora',
        config: { epochs: 1, learningRate: 0.0002, rank: 8, seed: 7, batchSize: 1, gradientAccumulationSteps: 1, sequenceLength: 256, validationSplit: 0.1 },
      }),
    );
    unwrap(backend.advanceTraining(projectId, job.id));
    unwrap(backend.advanceTraining(projectId, job.id));
    const persisted = unwrap(backend.getProject(projectId));

    const restarted = new DeterministicFixtureBackend({ clock: () => NOW, idFactory: idFactory() });
    const restored = unwrap(restarted.restoreProject(persisted));
    const restoredJob = restored.trainingJobs.find(({ id }) => id === job.id)!;

    expect(restoredJob).toMatchObject({
      state: 'interrupted',
      sequence: 3,
      progress: 0.5,
      recovery: { recoverable: true, previousState: 'training', interruptedAt: NOW },
    });
  });

  it('evaluates deterministic hidden evidence and promotes only with explicit approval', () => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const evaluation = unwrap(backend.evaluateCandidate(projectId, candidateId, evaluationSuite()));

    expect(evaluation.status).toBe('completed');
    expect(evaluation.caseEvidence[0]).toMatchObject({ caseId: 'hidden-case-1', hidden: true });
    expect(evaluation.caseEvidence[0]).not.toHaveProperty('input');
    expect(evaluation.aggregateDeltas).toEqual([
      expect.objectContaining({ metricId: 'quality', candidateDeltaFromBase: 0.15, passes: true }),
    ]);
    expect(evaluation.gate).toEqual({ result: 'pass', reasons: [] });

    expect(backend.promoteCandidate(projectId, candidateId, evaluation.id, '', '')).toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_REQUIRED' },
    });
    const promotion = unwrap(
      backend.promoteCandidate(projectId, candidateId, evaluation.id, 'owner', 'Passed fixture gates.'),
    );
    expect(promotion).toMatchObject({
      action: 'promote',
      targetVersionId: candidateId,
      approval: { approved: true, actorId: 'owner', reason: 'Passed fixture gates.' },
    });

    const snapshot = unwrap(backend.getProject(projectId));
    expect(snapshot.evaluationSuites[0]).not.toHaveProperty('cases');
    expect(JSON.stringify(snapshot.evaluationSuites)).not.toContain('Hidden local fixture input.');
  });

  it('rejects evaluation suites whose required safety cases are not present', () => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const suite = evaluationSuite();

    expect(
      backend.evaluateCandidate(projectId, candidateId, {
        ...suite,
        requiredSafetyCaseIds: ['missing-safety-case'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('requires champion evidence and suite regression thresholds for later candidates', () => {
    const { backend, projectId } = preparedBackend();
    const first = completeCandidate(backend, projectId);
    const firstEvaluation = unwrap(backend.evaluateCandidate(projectId, first.candidateId, evaluationSuite()));
    unwrap(backend.promoteCandidate(projectId, first.candidateId, firstEvaluation.id, 'owner', 'First champion.'));

    const second = completeCandidate(backend, projectId);
    const missingChampion = unwrap(
      backend.evaluateCandidate(projectId, second.candidateId, evaluationSuite()),
    );
    expect(missingChampion.gate).toMatchObject({
      result: 'incomplete',
      reasons: expect.arrayContaining(['CHAMPION_EVIDENCE_MISSING']),
    });

    const strictSuite = evaluationSuite({ candidateScore: 0.85 });
    const strictCase = strictSuite.cases[0];
    const strictEvaluation = unwrap(
      backend.evaluateCandidate(projectId, second.candidateId, {
        ...strictSuite,
        regressionThresholds: { quality: 0.01 },
        cases: [
          {
            ...strictCase,
            fixtureEvidence: {
              ...strictCase.fixtureEvidence,
              championMetrics: { quality: 0.87 },
            },
          },
        ],
      }),
    );
    expect(strictEvaluation.gate).toMatchObject({
      result: 'blocked',
      reasons: expect.arrayContaining(['REGRESSION']),
    });
  });

  it('blocks promotion when artifact or license evidence fails', () => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const evaluation = unwrap(backend.evaluateCandidate(projectId, candidateId, evaluationSuite()));
    unwrap(backend.attachBaseModel(projectId, { ...baseModel(), license: 'MIT' }));

    expect(
      backend.promoteCandidate(projectId, candidateId, evaluation.id, 'owner', 'Should be blocked.'),
    ).toMatchObject({ ok: false, error: { code: 'PROMOTION_GATE_BLOCKED' } });
    expect(unwrap(backend.getProject(projectId)).championVersionId).toBeUndefined();
  });

  it('returns structured validation failures for malformed evaluation evidence', () => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const suite = evaluationSuite();
    const malformed = {
      ...suite,
      cases: [{ ...suite.cases[0], fixtureEvidence: {} }],
    } as unknown as EvaluationSuite;

    expect(() => backend.evaluateCandidate(projectId, candidateId, malformed)).not.toThrow();
    expect(backend.evaluateCandidate(projectId, candidateId, malformed)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects forged persisted passing evaluations and fabricated feedback provenance', () => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const evaluation = unwrap(backend.evaluateCandidate(projectId, candidateId, evaluationSuite()));
    const snapshot = unwrap(backend.getProject(projectId));
    const forged = {
      ...snapshot,
      evaluationSuites: snapshot.evaluationSuites.map((suite) => ({ ...suite, caseCount: 2 })),
      evaluationRuns: [{ ...evaluation }],
    } as ProjectSnapshot;
    const restarted = new DeterministicFixtureBackend({ clock: () => NOW, idFactory: idFactory() });
    expect(restarted.restoreProject(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    expect(restarted.restoreProject({ ...snapshot, championVersionId: candidateId })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });

    const manifest = dataset();
    const fabricated = {
      ...manifest,
      examples: [{
        ...manifest.examples[0],
        source: { kind: 'approved_feedback' as const, reference: 'feedback-missing', approved: true },
      }],
      lineage: { ...manifest.lineage, feedbackEventIds: ['feedback-missing'] },
    };
    expect(backend.attachDatasetVersion(projectId, fabricated)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it.each([
    ['safety failure', evaluationSuite({ safetyFailures: ['unsafe-output'] }), undefined, 'SAFETY_FAILURE'],
    ['regression', evaluationSuite({ candidateScore: 0.5 }), undefined, 'REGRESSION'],
    ['incomplete evidence', evaluationSuite(), [] as string[], 'INCOMPLETE_EVALUATION'],
  ])('blocks promotion for %s', (_label, suite, completedCaseIds, reasonCode) => {
    const { backend, projectId } = preparedBackend();
    const { candidateId } = completeCandidate(backend, projectId);
    const evaluation = unwrap(
      backend.evaluateCandidate(projectId, candidateId, suite, { completedCaseIds }),
    );

    expect(evaluation.gate.result).not.toBe('pass');
    expect(evaluation.gate.reasons).toContain(reasonCode);
    expect(
      backend.promoteCandidate(projectId, candidateId, evaluation.id, 'owner', 'Try promotion.'),
    ).toMatchObject({ ok: false, error: { code: 'PROMOTION_GATE_BLOCKED' } });
  });

  it('preserves promoted versions and appends an audit-safe rollback record', () => {
    const { backend, projectId } = preparedBackend();
    const first = completeCandidate(backend, projectId);
    const firstEvaluation = unwrap(
      backend.evaluateCandidate(projectId, first.candidateId, evaluationSuite()),
    );
    unwrap(
      backend.promoteCandidate(
        projectId,
        first.candidateId,
        firstEvaluation.id,
        'owner',
        'First champion.',
      ),
    );

    const second = completeCandidate(backend, projectId);
    const secondEvaluation = unwrap(
      backend.evaluateCandidate(projectId, second.candidateId, evaluationSuite({ championScore: 0.85 })),
    );
    unwrap(
      backend.promoteCandidate(
        projectId,
        second.candidateId,
        secondEvaluation.id,
        'owner',
        'Second champion.',
      ),
    );

    const rollback = unwrap(
      backend.rollbackChampion(projectId, first.candidateId, 'owner', 'Regression discovered.'),
    );
    const snapshot = unwrap(backend.getProject(projectId));

    expect(rollback).toMatchObject({
      action: 'rollback',
      previousChampionVersionId: second.candidateId,
      targetVersionId: first.candidateId,
      rollbackTargetVersionId: first.candidateId,
    });
    expect(snapshot.championVersionId).toBe(first.candidateId);
    expect(snapshot.modelVersions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([first.candidateId, second.candidateId]),
    );
    expect(snapshot.promotions).toHaveLength(3);

    expect(backend.rollbackChampion(projectId, 'never-promoted', 'owner', 'Invalid target.')).toMatchObject({
      ok: false,
      error: { code: 'ROLLBACK_TARGET_INVALID' },
    });
  });

  it('accepts only approved feedback and carries approved provenance into a new cycle', () => {
    const { backend, projectId } = preparedBackend();

    expect(
      backend.recordFeedback(projectId, {
        rating: 'helpful',
        evidenceHash: HASH,
        consent: { approved: false, actorId: 'owner', approvedAt: NOW, purpose: 'Improve locally.' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'FEEDBACK_CONSENT_REQUIRED' } });

    const approved = unwrap(
      backend.recordFeedback(projectId, {
        rating: 'helpful',
        evidenceHash: HASH,
        consent: { approved: true, actorId: 'owner', approvedAt: NOW, purpose: 'Improve locally.' },
      }),
    );
    const cycle = unwrap(
      backend.createImprovementCycle(projectId, [approved.id], 'owner', 'Use approved feedback.'),
    );
    const snapshot = unwrap(backend.getProject(projectId));

    expect(cycle.feedbackProvenance).toEqual([
      { feedbackEventId: approved.id, consentActorId: 'owner', consentApprovedAt: NOW },
    ]);
    expect(snapshot.feedbackEvents).toHaveLength(1);
    expect(snapshot.improvementCycles).toHaveLength(1);
  });
});

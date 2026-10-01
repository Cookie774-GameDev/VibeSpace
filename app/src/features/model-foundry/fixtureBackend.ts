import {
  FOUNDRY_SCHEMA_VERSION,
  type ActiveTrainingState,
  type ApprovedFeedbackEvent,
  type BaseModelRecord,
  type DatasetVersionManifest,
  type EvaluationCaseEvidence,
  type EvaluationOptions,
  type EvaluationRun,
  type EvaluationSuite,
  type EvaluationSuiteSummary,
  type FeedbackSubmission,
  type FoundryError,
  type FoundryErrorCode,
  type FoundryErrorDetail,
  type FoundryResult,
  type ImprovementCycle,
  type ModelVersion,
  type ProjectSnapshot,
  type PromotionRecord,
  type SpecialistDefinition,
  type StartTrainingInput,
  type TrainingJobSnapshot,
  type TrainingManifest,
} from './domain';
import {
  validateBaseModel,
  validateDatasetVersion,
  validateEvaluationSuite,
  validateProjectSnapshot,
  validateSpecialist,
  validateTrainingManifest,
  type ValidationIssue,
} from './validation';

export interface FixtureBackendDependencies {
  readonly clock: () => string;
  readonly idFactory: (kind: string) => string;
}

const ACTIVE_STATES: readonly ActiveTrainingState[] = [
  'queued',
  'preparing',
  'training',
  'checkpointing',
];

const FIXTURE_LABEL = 'fixture-only; no training or GPU work occurred' as const;
const HEX_HASH = /^[a-f0-9]{64}$/i;

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixtureFingerprint(value: string): string {
  const parts: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    let hash = (0x811c9dc5 ^ round) >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) + round;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    parts.push(hash.toString(16).padStart(8, '0'));
  }
  return parts.join('');
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizeSuite(suite: EvaluationSuite): EvaluationSuiteSummary {
  return {
    schemaVersion: suite.schemaVersion,
    id: suite.id,
    name: suite.name,
    version: suite.version,
    targetCapability: suite.targetCapability,
    description: suite.description,
    hiddenStatus: suite.hiddenStatus,
    caseCount: suite.cases.length,
    metricIds: suite.metricDefinitions.map(({ id }) => id),
    requiredSafetyCaseIds: [...suite.requiredSafetyCaseIds],
    owner: suite.owner,
    fingerprint: suite.fingerprint,
    createdAt: suite.createdAt,
  };
}

function issueDetails(issues: readonly ValidationIssue[]): Readonly<Record<string, FoundryErrorDetail>> {
  return {
    issueCount: issues.length,
    fieldPaths: issues.map((issue) => issue.path.join('.')).join(','),
  };
}

export class DeterministicFixtureBackend {
  private readonly projects = new Map<string, ProjectSnapshot>();

  constructor(private readonly dependencies: FixtureBackendDependencies) {}

  createProject(specialist: SpecialistDefinition): FoundryResult<ProjectSnapshot> {
    const validation = validateSpecialist(specialist);
    if (!validation.valid) {
      return this.failure('INVALID_INPUT', 'Specialist definition is invalid.', true, issueDetails(validation.issues));
    }

    const now = this.dependencies.clock();
    const projectId = this.dependencies.idFactory('project');
    const snapshot: ProjectSnapshot = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      fixtureLabel: 'fixture',
      project: {
        schemaVersion: FOUNDRY_SCHEMA_VERSION,
        id: projectId,
        specialist: clone(validation.value),
        createdAt: now,
        updatedAt: now,
      },
      trainingManifests: [],
      trainingJobs: [],
      evaluationSuites: [],
      evaluationRuns: [],
      modelVersions: [],
      promotions: [],
      feedbackEvents: [],
      improvementCycles: [],
    };
    return this.store(snapshot);
  }

  getProject(projectId: string): FoundryResult<ProjectSnapshot> {
    const snapshot = this.projects.get(projectId);
    return snapshot
      ? { ok: true, value: snapshot }
      : this.failure('PROJECT_NOT_FOUND', 'Fixture project was not found.', false, { projectId });
  }

  attachBaseModel(projectId: string, baseModel: BaseModelRecord): FoundryResult<ProjectSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const validation = validateBaseModel(baseModel);
    if (!validation.valid) {
      return this.failure('INVALID_INPUT', 'Base model record is invalid.', true, issueDetails(validation.issues));
    }
    if (
      baseModel.backend !== 'fixture' ||
      baseModel.trustStatus !== 'approved' ||
      baseModel.compatibilityStatus !== 'compatible'
    ) {
      return this.failure(
        'BASE_MODEL_NOT_APPROVED',
        'Fixture training requires an approved, compatible fixture base model.',
        true,
        { baseModelId: baseModel.id },
      );
    }
    return this.store({
      ...existing,
      project: this.touch(existing),
      baseModel: clone(baseModel),
    });
  }

  attachDatasetVersion(
    projectId: string,
    datasetVersion: DatasetVersionManifest,
  ): FoundryResult<ProjectSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const validation = validateDatasetVersion(datasetVersion);
    if (!validation.valid) {
      return this.failure('INVALID_INPUT', 'Dataset version is invalid.', true, issueDetails(validation.issues));
    }
    if (datasetVersion.examples.some((example) => example.projectId !== projectId)) {
      return this.failure('INVALID_INPUT', 'Dataset example project provenance does not match.', true, {
        projectId,
      });
    }
    const feedbackIds = new Set(existing.feedbackEvents.map(({ id }) => id));
    if (datasetVersion.examples.some((example) => example.source.kind === 'approved_feedback' && !feedbackIds.has(example.source.reference))) {
      return this.failure('INVALID_INPUT', 'Approved feedback dataset sources must reference persisted consented feedback.', true, { projectId });
    }
    return this.store({
      ...existing,
      project: this.touch(existing),
      datasetVersion: clone(datasetVersion),
    });
  }

  startTraining(projectId: string, input: StartTrainingInput): FoundryResult<TrainingJobSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    if (!existing.baseModel || !existing.datasetVersion) {
      return this.failure(
        'TRAINING_INPUTS_REQUIRED',
        'A fixture base model and immutable dataset version are required.',
        true,
        { projectId },
      );
    }
    if (existing.trainingJobs.some((job) => ACTIVE_STATES.includes(job.state as ActiveTrainingState))) {
      return this.failure('ACTIVE_JOB_EXISTS', 'Only one active fixture job is allowed per project.', true, {
        projectId,
      });
    }

    const now = this.dependencies.clock();
    const manifest: TrainingManifest = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('manifest'),
      projectId,
      backend: 'fixture',
      method: input.method,
      specialistId: existing.project.specialist.id,
      datasetVersionId: existing.datasetVersion.id,
      datasetManifestHash: existing.datasetVersion.manifestHash,
      datasetFingerprint: existing.datasetVersion.fingerprint,
      baseModelId: existing.baseModel.id,
      baseRevision: existing.baseModel.revision,
      baseChecksum: clone(existing.baseModel.checksum),
      config: clone(input.config),
      adapterConfiguration: {
        rank: input.config.rank,
        alpha: input.config.rank * 2,
        dropout: 0,
        targetModules: [],
      },
      precision: 'fixture_not_applicable',
      quantization: existing.baseModel.quantization,
      optimizer: null,
      scheduler: null,
      softwareVersion: 'foundry-schema-1',
      workerVersion: 'deterministic-fixture-1',
      hardwareSummary: null,
      startedAt: now,
      endedAt: null,
      exitState: 'pending',
      checkpoints: [],
      metrics: [],
      warnings: [],
      errors: [],
      artifactChecksums: [],
      createdAt: now,
      truthfulLabel: FIXTURE_LABEL,
    };
    const manifestValidation = validateTrainingManifest(manifest);
    if (!manifestValidation.valid) {
      return this.failure('INVALID_INPUT', 'Training request is invalid.', true, issueDetails(manifestValidation.issues));
    }

    const job: TrainingJobSnapshot = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('job'),
      projectId,
      manifestId: manifest.id,
      backend: 'fixture',
      state: 'queued',
      sequence: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
      recovery: { recoverable: true },
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      trainingManifest: manifest,
      trainingManifests: [...existing.trainingManifests, manifest],
      trainingJobs: [...existing.trainingJobs, job],
    });
    return { ok: true, value: deepFreeze(clone(job)) };
  }

  advanceTraining(projectId: string, jobId: string): FoundryResult<TrainingJobSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const job = existing.trainingJobs.find((candidate) => candidate.id === jobId);
    if (!job) return this.failure('JOB_NOT_FOUND', 'Fixture training job was not found.', false, { jobId });
    if (!ACTIVE_STATES.includes(job.state as ActiveTrainingState)) {
      return this.failure('JOB_TERMINAL', 'Terminal fixture jobs cannot be advanced.', false, {
        jobId,
        state: job.state,
      });
    }

    const now = this.dependencies.clock();
    let nextJob: TrainingJobSnapshot;
    let modelVersion: ModelVersion | undefined;
    if (job.state === 'queued') {
      nextJob = { ...job, state: 'preparing', sequence: job.sequence + 1, progress: 0.1, updatedAt: now };
    } else if (job.state === 'preparing') {
      nextJob = { ...job, state: 'training', sequence: job.sequence + 1, progress: 0.5, updatedAt: now };
    } else if (job.state === 'training') {
      nextJob = {
        ...job,
        state: 'checkpointing',
        sequence: job.sequence + 1,
        progress: 0.85,
        updatedAt: now,
        checkpoint: {
          backend: 'fixture',
          uri: `fixture://projects/${projectId}/jobs/${jobId}/checkpoint`,
          fixtureFingerprint: fixtureFingerprint(`${projectId}:${jobId}:checkpoint`),
          createdAt: now,
        },
      };
    } else {
      const versionId = this.dependencies.idFactory('model-version');
      const artifactFingerprint = fixtureFingerprint(`${projectId}:${jobId}:adapter`);
      const artifact = {
        backend: 'fixture' as const,
        kind: 'adapter' as const,
        uri: `fixture://projects/${projectId}/jobs/${jobId}/adapter`,
        fixtureFingerprint: artifactFingerprint,
        modelVersionId: versionId,
        truthfulLabel: FIXTURE_LABEL,
        createdAt: now,
      };
      nextJob = {
        ...job,
        state: 'completed',
        sequence: job.sequence + 1,
        progress: 1,
        updatedAt: now,
        artifact,
        recovery: { recoverable: false },
      };
      const manifest = existing.trainingManifests.find((candidate) => candidate.id === job.manifestId)!;
      modelVersion = {
        schemaVersion: FOUNDRY_SCHEMA_VERSION,
        id: versionId,
        projectId,
        sourceJobId: jobId,
        baseModelId: manifest.baseModelId,
        baseRevision: manifest.baseRevision,
        datasetVersionId: manifest.datasetVersionId,
        role: 'candidate',
        license: existing.baseModel!.license,
        artifactFingerprint,
        artifact,
        modelCard: {
          summary: 'Deterministic fixture adapter candidate; no model training or GPU work occurred.',
          intendedUse: existing.project.specialist.objective,
          limitations: [
            'Fixture artifact only; it contains no trained weights.',
            'Fixture evaluation evidence does not establish real model quality.',
          ],
          evaluationRunIds: [],
        },
        createdAt: now,
      };
    }

    let snapshot: ProjectSnapshot = {
      ...existing,
      project: this.touch(existing, now),
      trainingJobs: existing.trainingJobs.map((candidate) => (candidate.id === jobId ? nextJob : candidate)),
      modelVersions: modelVersion ? [...existing.modelVersions, modelVersion] : existing.modelVersions,
    };
    if (nextJob.checkpoint || nextJob.artifact) {
      snapshot = this.updateManifest(snapshot, job.manifestId, (manifest) => ({
        ...manifest,
        checkpoints: nextJob.checkpoint ? [nextJob.checkpoint] : manifest.checkpoints,
        endedAt: nextJob.state === 'completed' ? now : manifest.endedAt,
        exitState: nextJob.state === 'completed' ? 'fixture_completed' : manifest.exitState,
        artifactChecksums: nextJob.artifact
          ? [{ algorithm: 'fixture-fingerprint-v1', value: nextJob.artifact.fixtureFingerprint }]
          : manifest.artifactChecksums,
      }));
    }
    this.store(snapshot);
    return { ok: true, value: deepFreeze(clone(nextJob)) };
  }

  resumeTraining(projectId: string, jobId: string): FoundryResult<TrainingJobSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const job = existing.trainingJobs.find((candidate) => candidate.id === jobId);
    if (!job) return this.failure('JOB_NOT_FOUND', 'Fixture training job was not found.', false, { jobId });
    if (job.state !== 'interrupted' || !job.recovery.recoverable || !job.recovery.previousState) {
      return this.failure('JOB_TERMINAL', 'Only recoverable interrupted jobs can be resumed.', false, { jobId, state: job.state });
    }
    const now = this.dependencies.clock();
    const resumed: TrainingJobSnapshot = {
      ...job,
      state: job.recovery.previousState,
      sequence: job.sequence + 1,
      updatedAt: now,
      recovery: { recoverable: true },
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      trainingJobs: existing.trainingJobs.map((candidate) => candidate.id === jobId ? resumed : candidate),
    });
    return { ok: true, value: deepFreeze(clone(resumed)) };
  }

  cancelTraining(
    projectId: string,
    jobId: string,
    actorId: string,
    reason: string,
  ): FoundryResult<TrainingJobSnapshot> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const job = existing.trainingJobs.find((candidate) => candidate.id === jobId);
    if (!job) return this.failure('JOB_NOT_FOUND', 'Fixture training job was not found.', false, { jobId });
    if (!ACTIVE_STATES.includes(job.state as ActiveTrainingState)) {
      return this.failure('JOB_TERMINAL', 'Terminal fixture jobs cannot be cancelled.', false, {
        jobId,
        state: job.state,
      });
    }
    if (!actorId.trim() || !reason.trim()) {
      return this.failure('APPROVAL_REQUIRED', 'Cancellation requires an actor and reason.', true, { jobId });
    }
    const now = this.dependencies.clock();
    const cancelled: TrainingJobSnapshot = {
      ...job,
      state: 'cancelled',
      sequence: job.sequence + 1,
      updatedAt: now,
      cancellation: { actorId, reason, requestedAt: now, cancelledAt: now },
      recovery: { recoverable: false },
    };
    let snapshot: ProjectSnapshot = {
      ...existing,
      project: this.touch(existing, now),
      trainingJobs: existing.trainingJobs.map((candidate) => (candidate.id === jobId ? cancelled : candidate)),
    };
    snapshot = this.updateManifest(snapshot, job.manifestId, (manifest) => ({
      ...manifest,
      endedAt: now,
      exitState: 'cancelled',
    }));
    this.store(snapshot);
    return { ok: true, value: deepFreeze(clone(cancelled)) };
  }

  restoreProject(persisted: ProjectSnapshot): FoundryResult<ProjectSnapshot> {
    const validation = validateProjectSnapshot(persisted);
    if (!validation.valid) {
      return this.failure('INVALID_INPUT', 'Persisted fixture project is invalid.', false, issueDetails(validation.issues));
    }
    const now = this.dependencies.clock();
    let snapshot = clone(validation.value);
    for (const job of snapshot.trainingJobs) {
      if (!ACTIVE_STATES.includes(job.state as ActiveTrainingState)) continue;
      const interrupted: TrainingJobSnapshot = {
        ...job,
        state: 'interrupted',
        sequence: job.sequence + 1,
        updatedAt: now,
        recovery: {
          recoverable: true,
          previousState: job.state as ActiveTrainingState,
          interruptedAt: now,
        },
      };
      snapshot = {
        ...snapshot,
        project: this.touch(snapshot, now),
        trainingJobs: snapshot.trainingJobs.map((candidate) =>
          candidate.id === job.id ? interrupted : candidate,
        ),
      };
      snapshot = this.updateManifest(snapshot, job.manifestId, (manifest) => ({
        ...manifest,
        endedAt: now,
        exitState: 'interrupted',
      }));
    }
    return this.store(snapshot);
  }

  evaluateCandidate(
    projectId: string,
    candidateVersionId: string,
    suite: EvaluationSuite,
    options: EvaluationOptions = {},
  ): FoundryResult<EvaluationRun> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const candidate = existing.modelVersions.find((version) => version.id === candidateVersionId);
    if (!candidate) {
      return this.failure('VERSION_NOT_FOUND', 'Candidate model version was not found.', false, {
        candidateVersionId,
      });
    }
    const sourceJob = existing.trainingJobs.find((job) => job.id === candidate.sourceJobId);
    if (sourceJob?.state !== 'completed') {
      return this.failure('INVALID_INPUT', 'Only completed fixture candidates can be evaluated.', true, {
        candidateVersionId,
      });
    }
    const validation = validateEvaluationSuite(suite);
    if (!validation.valid) {
      return this.failure('INVALID_INPUT', 'Evaluation suite is invalid.', true, issueDetails(validation.issues));
    }

    const completedIds = new Set(options.completedCaseIds ?? suite.cases.map((evaluationCase) => evaluationCase.id));
    const completedCases = suite.cases.filter((evaluationCase) => completedIds.has(evaluationCase.id));
    const championEvidenceMissing = Boolean(existing.championVersionId) && completedCases.some(
      (evaluationCase) => suite.metricDefinitions.some(
        (metric) => !Number.isFinite(evaluationCase.fixtureEvidence.championMetrics?.[metric.id]),
      ),
    );
    const caseEvidence: EvaluationCaseEvidence[] = completedCases.map((evaluationCase) => ({
      caseId: evaluationCase.id,
      hidden: evaluationCase.hidden,
      metricValues: {
        base: clone(evaluationCase.fixtureEvidence.baseMetrics),
        candidate: clone(evaluationCase.fixtureEvidence.candidateMetrics),
        ...(evaluationCase.fixtureEvidence.championMetrics
          ? { champion: clone(evaluationCase.fixtureEvidence.championMetrics) }
          : {}),
      },
      safetyFailures: [...evaluationCase.fixtureEvidence.safetyFailures],
      evidenceHash: evaluationCase.contentHash,
    }));
    const aggregateDeltas = suite.metricDefinitions.map((metric) => {
      const baseValue = average(
        caseEvidence.map((evidence) => evidence.metricValues.base[metric.id]).filter(Number.isFinite),
      );
      const candidateValue = average(
        caseEvidence.map((evidence) => evidence.metricValues.candidate[metric.id]).filter(Number.isFinite),
      );
      const championValues = caseEvidence
        .map((evidence) => evidence.metricValues.champion?.[metric.id])
        .filter((value): value is number => Number.isFinite(value));
      const championValue = championValues.length > 0 ? average(championValues) : undefined;
      const candidateDeltaFromBase = roundMetric(candidateValue - baseValue);
      const candidateDeltaFromChampion =
        championValue === undefined ? undefined : roundMetric(candidateValue - championValue);
      const referenceDelta = candidateDeltaFromChampion ?? candidateDeltaFromBase;
      const allowedRegression = suite.regressionThresholds[metric.id] ?? metric.allowedRegression;
      const directionPasses =
        metric.direction === 'higher_better'
          ? referenceDelta >= -allowedRegression
          : referenceDelta <= allowedRegression;
      const promotionThreshold = suite.promotionThresholds[metric.id];
      const thresholdPasses =
        promotionThreshold === undefined ||
        (metric.direction === 'higher_better'
          ? candidateValue >= promotionThreshold
          : candidateValue <= promotionThreshold);
      return {
        metricId: metric.id,
        baseValue,
        candidateValue,
        candidateDeltaFromBase,
        ...(championValue === undefined ? {} : { championValue, candidateDeltaFromChampion }),
        passes: directionPasses && thresholdPasses,
      };
    });
    const safetyFailures = caseEvidence.flatMap((evidence) => evidence.safetyFailures);
    const incomplete = completedCases.length !== suite.cases.length;
    const reasons: EvaluationRun['gate']['reasons'][number][] = [];
    if (incomplete) reasons.push('INCOMPLETE_EVALUATION');
    if (championEvidenceMissing) reasons.push('CHAMPION_EVIDENCE_MISSING');
    if (safetyFailures.length > 0) reasons.push('SAFETY_FAILURE');
    if (aggregateDeltas.some((delta) => !delta.passes)) reasons.push('REGRESSION');
    const now = this.dependencies.clock();
    const evaluation: EvaluationRun = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('evaluation'),
      projectId,
      suiteId: suite.id,
      backend: 'fixture',
      status: incomplete || championEvidenceMissing ? 'incomplete' : 'completed',
      identities: {
        baseModelId: candidate.baseModelId,
        baseRevision: candidate.baseRevision,
        candidateVersionId,
        ...(existing.championVersionId ? { championVersionId: existing.championVersionId } : {}),
      },
      caseEvidence,
      aggregateDeltas,
      safetyFailures,
      gate: {
        result: incomplete || championEvidenceMissing ? 'incomplete' : reasons.length === 0 ? 'pass' : 'blocked',
        reasons,
      },
      createdAt: now,
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      evaluationSuites: [
        ...existing.evaluationSuites.filter((candidateSuite) => candidateSuite.id !== suite.id),
        summarizeSuite(suite),
      ],
      evaluationRuns: [...existing.evaluationRuns, evaluation],
    });
    return { ok: true, value: deepFreeze(clone(evaluation)) };
  }

  promoteCandidate(
    projectId: string,
    candidateVersionId: string,
    evaluationRunId: string,
    actorId: string,
    reason: string,
  ): FoundryResult<PromotionRecord> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    if (!actorId.trim() || !reason.trim()) {
      return this.failure('APPROVAL_REQUIRED', 'Promotion requires an explicit actor and reason.', true, {
        candidateVersionId,
      });
    }
    const candidate = existing.modelVersions.find((version) => version.id === candidateVersionId);
    if (!candidate) {
      return this.failure('VERSION_NOT_FOUND', 'Candidate model version was not found.', false, {
        candidateVersionId,
      });
    }
    const evaluation = existing.evaluationRuns.find((run) => run.id === evaluationRunId);
    if (!evaluation || evaluation.identities.candidateVersionId !== candidateVersionId) {
      return this.failure('EVALUATION_NOT_FOUND', 'Matching evaluation evidence was not found.', true, {
        evaluationRunId,
      });
    }
    if (evaluation.status !== 'completed' || evaluation.gate.result !== 'pass') {
      return this.failure('PROMOTION_GATE_BLOCKED', 'Candidate did not pass every promotion gate.', true, {
        evaluationRunId,
        gate: evaluation.gate.result,
      });
    }
    const artifactChecksumVerified = candidate.artifact.fixtureFingerprint === candidate.artifactFingerprint;
    const licenseApproved = candidate.license === existing.baseModel?.license;
    if (!artifactChecksumVerified || !licenseApproved) {
      return this.failure('PROMOTION_GATE_BLOCKED', 'Candidate artifact or license evidence did not pass.', true, {
        artifactChecksumVerified,
        licenseApproved,
      });
    }
    const now = this.dependencies.clock();
    const previousChampion = existing.modelVersions.find(
      (version) => version.id === existing.championVersionId,
    );
    const rollbackVersion = previousChampion ?? candidate;
    const promotion: PromotionRecord = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('promotion'),
      projectId,
      action: 'promote',
      targetVersionId: candidateVersionId,
      evaluationRunId,
      previousChampionVersionId: existing.championVersionId,
      rollbackTargetVersionId: existing.championVersionId,
      immutableRollbackPoint: {
        versionId: rollbackVersion.id,
        artifactFingerprint: rollbackVersion.artifactFingerprint,
      },
      gateEvidence: {
        artifactChecksumVerified,
        licenseApproved,
        evaluationGatePassed: true,
      },
      approval: { approved: true, actorId, reason, approvedAt: now },
      createdAt: now,
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      championVersionId: candidateVersionId,
      promotions: [...existing.promotions, promotion],
    });
    return { ok: true, value: deepFreeze(clone(promotion)) };
  }

  rollbackChampion(
    projectId: string,
    targetVersionId: string,
    actorId: string,
    reason: string,
  ): FoundryResult<PromotionRecord> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const target = existing.modelVersions.find((version) => version.id === targetVersionId);
    const wasPromoted = existing.promotions.some(
      (promotion) => promotion.action === 'promote' && promotion.targetVersionId === targetVersionId,
    );
    if (!target || !wasPromoted || existing.championVersionId === targetVersionId) {
      return this.failure(
        'ROLLBACK_TARGET_INVALID',
        'Rollback target must be a previously promoted non-current version.',
        false,
        { targetVersionId },
      );
    }
    if (!actorId.trim() || !reason.trim()) {
      return this.failure('APPROVAL_REQUIRED', 'Rollback requires an explicit actor and reason.', true, {
        targetVersionId,
      });
    }
    const now = this.dependencies.clock();
    const rollback: PromotionRecord = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('promotion'),
      projectId,
      action: 'rollback',
      targetVersionId,
      previousChampionVersionId: existing.championVersionId,
      rollbackTargetVersionId: targetVersionId,
      immutableRollbackPoint: {
        versionId: targetVersionId,
        artifactFingerprint: target.artifactFingerprint,
      },
      gateEvidence: {
        artifactChecksumVerified: target.artifact.fixtureFingerprint === target.artifactFingerprint,
        licenseApproved: target.license === existing.baseModel?.license,
        evaluationGatePassed: true,
      },
      approval: { approved: true, actorId, reason, approvedAt: now },
      createdAt: now,
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      championVersionId: targetVersionId,
      promotions: [...existing.promotions, rollback],
    });
    return { ok: true, value: deepFreeze(clone(rollback)) };
  }

  recordFeedback(
    projectId: string,
    submission: FeedbackSubmission,
  ): FoundryResult<ApprovedFeedbackEvent> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    if (
      submission.consent.approved !== true ||
      !submission.consent.actorId.trim() ||
      !submission.consent.purpose.trim()
    ) {
      return this.failure(
        'FEEDBACK_CONSENT_REQUIRED',
        'Feedback requires explicit approved consent before local improvement use.',
        true,
        { projectId },
      );
    }
    if (!HEX_HASH.test(submission.evidenceHash)) {
      return this.failure('INVALID_INPUT', 'Feedback evidence hash is invalid.', true, { projectId });
    }
    const now = this.dependencies.clock();
    const event: ApprovedFeedbackEvent = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('feedback'),
      projectId,
      rating: submission.rating,
      evidenceHash: submission.evidenceHash,
      consent: { ...clone(submission.consent), approved: true },
      createdAt: now,
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      feedbackEvents: [...existing.feedbackEvents, event],
    });
    return { ok: true, value: deepFreeze(clone(event)) };
  }

  createImprovementCycle(
    projectId: string,
    feedbackEventIds: readonly string[],
    actorId: string,
    reason: string,
  ): FoundryResult<ImprovementCycle> {
    const existing = this.projects.get(projectId);
    if (!existing) return this.missingProject(projectId);
    const events = feedbackEventIds.map((id) => existing.feedbackEvents.find((event) => event.id === id));
    if (
      feedbackEventIds.length === 0 ||
      events.some((event) => !event || event.consent.approved !== true) ||
      !actorId.trim() ||
      !reason.trim()
    ) {
      return this.failure(
        'FEEDBACK_CONSENT_REQUIRED',
        'Improvement cycles may reference approved feedback only and require explicit provenance.',
        true,
        { projectId },
      );
    }
    const now = this.dependencies.clock();
    const cycle: ImprovementCycle = {
      schemaVersion: FOUNDRY_SCHEMA_VERSION,
      id: this.dependencies.idFactory('cycle'),
      projectId,
      createdBy: actorId,
      reason,
      feedbackProvenance: events.map((event) => ({
        feedbackEventId: event!.id,
        consentActorId: event!.consent.actorId,
        consentApprovedAt: event!.consent.approvedAt,
      })),
      createdAt: now,
    };
    this.store({
      ...existing,
      project: this.touch(existing, now),
      improvementCycles: [...existing.improvementCycles, cycle],
    });
    return { ok: true, value: deepFreeze(clone(cycle)) };
  }

  private updateManifest(
    snapshot: ProjectSnapshot,
    manifestId: string,
    update: (manifest: TrainingManifest) => TrainingManifest,
  ): ProjectSnapshot {
    const nextManifests = snapshot.trainingManifests.map((manifest) =>
      manifest.id === manifestId ? update(manifest) : manifest,
    );
    return {
      ...snapshot,
      trainingManifests: nextManifests,
      trainingManifest:
        snapshot.trainingManifest?.id === manifestId
          ? nextManifests.find((manifest) => manifest.id === manifestId)
          : snapshot.trainingManifest,
    };
  }

  private touch(snapshot: ProjectSnapshot, now = this.dependencies.clock()) {
    return { ...snapshot.project, updatedAt: now };
  }

  private store(snapshot: ProjectSnapshot): FoundryResult<ProjectSnapshot> {
    const frozen = deepFreeze(clone(snapshot));
    this.projects.set(frozen.project.id, frozen);
    return { ok: true, value: frozen };
  }

  private missingProject(projectId: string): { readonly ok: false; readonly error: FoundryError } {
    return this.failure('PROJECT_NOT_FOUND', 'Fixture project was not found.', false, { projectId });
  }

  private failure(
    code: FoundryErrorCode,
    message: string,
    recoverable: boolean,
    details: Readonly<Record<string, FoundryErrorDetail>>,
  ): { readonly ok: false; readonly error: FoundryError } {
    return {
      ok: false,
      error: {
        schemaVersion: FOUNDRY_SCHEMA_VERSION,
        code,
        message,
        recoverable,
        correlationId: this.dependencies.idFactory('error'),
        details,
      },
    };
  }
}

export const FOUNDRY_SCHEMA_VERSION = 1 as const;

export type FoundrySchemaVersion = typeof FOUNDRY_SCHEMA_VERSION;
export type FixtureBackendKind = 'fixture';
export type TrainingBackendKind = FixtureBackendKind | 'real';

export type FoundryErrorCode =
  | 'ACTIVE_JOB_EXISTS'
  | 'APPROVAL_REQUIRED'
  | 'BASE_MODEL_NOT_APPROVED'
  | 'DATASET_REQUIRED'
  | 'EVALUATION_NOT_FOUND'
  | 'FEEDBACK_CONSENT_REQUIRED'
  | 'INVALID_INPUT'
  | 'JOB_NOT_FOUND'
  | 'JOB_TERMINAL'
  | 'PROJECT_NOT_FOUND'
  | 'PROMOTION_GATE_BLOCKED'
  | 'ROLLBACK_TARGET_INVALID'
  | 'SECRET_MATERIAL_REJECTED'
  | 'STORAGE_PARSE_ERROR'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_VALIDATION_ERROR'
  | 'TRAINING_INPUTS_REQUIRED'
  | 'UNSUPPORTED_STORAGE_VERSION'
  | 'VERSION_NOT_FOUND';

export type FoundryErrorDetail = string | number | boolean | null;

export interface FoundryError {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly code: FoundryErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly correlationId: string;
  readonly details: Readonly<Record<string, FoundryErrorDetail>>;
}

export type FoundryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FoundryError };

export interface SuccessMetric {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly target: number;
  readonly unit: string;
  readonly direction: 'at_least' | 'at_most';
}

export interface JsonSchemaContract {
  readonly type: 'object';
  readonly required: readonly string[];
  readonly properties: Readonly<
    Record<
      string,
      {
        readonly type: 'array' | 'boolean' | 'number' | 'object' | 'string';
        readonly description: string;
      }
    >
  >;
}

export interface SpecialistDefinition {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly objective: string;
  readonly nonGoals: readonly string[];
  readonly inputSchema: JsonSchemaContract;
  readonly outputSchema: JsonSchemaContract;
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly constraints: readonly string[];
  readonly behaviorRequirements: readonly string[];
  readonly forbiddenBehavior: readonly string[];
  readonly toolPermissions: {
    readonly mode: 'none' | 'allowlist';
    readonly allowedTools: readonly string[];
  };
  readonly privacyPolicy: {
    readonly classification: 'private' | 'sensitive';
    readonly localOnly: true;
    readonly retention: 'project_lifetime' | 'until_deleted';
  };
  readonly dataPolicy: {
    readonly trainingUse: 'approved_only';
    readonly externalTransfer: false;
    readonly rawDataLogging: false;
  };
  readonly latencyTarget: {
    readonly kind: 'maximum' | 'not_measured';
    readonly maxMilliseconds: number | null;
  };
  readonly memoryTarget: {
    readonly kind: 'maximum' | 'not_measured';
    readonly maxBytes: number | null;
  };
  readonly evaluationRubric: {
    readonly criteria: readonly {
      readonly id: string;
      readonly description: string;
      readonly weight: number;
    }[];
  };
  readonly safetyRubric: { readonly requiredChecks: readonly string[] };
  readonly commercialIntent: 'personal' | 'commercial' | 'research';
  readonly modelLicenseConstraints: readonly string[];
  readonly promotionThreshold: { readonly metricId: string; readonly minimumValue: number };
  readonly regressionThreshold: { readonly metricId: string; readonly maximumRegression: number };
  readonly successMetrics: readonly SuccessMetric[];
  readonly privacyMode: 'local_only';
  readonly owner: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Checksum {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export interface BaseModelRecord {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly backend: TrainingBackendKind;
  readonly sourceUri: string;
  readonly revision: string;
  readonly license: string;
  readonly parameterCount: number;
  readonly quantization: string;
  readonly sizeBytes: number;
  readonly checksum: Checksum;
  readonly minimumResources: {
    readonly ramBytes: number;
    readonly vramBytes: number;
    readonly diskBytes: number;
  };
  readonly trustStatus: 'approved' | 'unreviewed' | 'blocked';
  readonly compatibilityStatus: 'compatible' | 'incompatible' | 'unknown';
  readonly remoteCode: {
    readonly supported: false;
    readonly requested: boolean;
  };
  readonly createdAt: string;
}

export type DatasetSplit = 'train' | 'validation' | 'test';

export interface ConsentMetadata {
  readonly approved: boolean;
  readonly actorId: string;
  readonly approvedAt: string;
  readonly purpose: string;
}

export interface DatasetExample {
  readonly id: string;
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly exampleType:
    | 'prompt_completion'
    | 'chat_conversation'
    | 'tool_trace'
    | 'code_patch'
    | 'before_after'
    | 'bug_fix'
    | 'test_failure_fix'
    | 'structured_extraction'
    | 'classification'
    | 'preference'
    | 'rubric_scored'
    | 'human_edit'
    | 'accepted_output'
    | 'rejected_output'
    | 'evaluation';
  readonly input: string;
  readonly expectedOutput: string;
  readonly split: DatasetSplit;
  readonly labels: readonly string[];
  readonly tags: readonly string[];
  readonly contentHash: string;
  readonly provenance: {
    readonly sourceId: string;
    readonly sourceVersion: string;
  };
  readonly authorType: 'user' | 'reviewer' | 'synthetic_generator';
  readonly synthetic: boolean;
  readonly license: string;
  readonly privacyClassification: 'private' | 'sensitive' | 'public';
  readonly qualityStatus: 'approved' | 'needs_review' | 'rejected';
  readonly approvalStatus: 'approved' | 'pending' | 'rejected';
  readonly secretScanStatus: 'passed' | 'failed' | 'not_scanned';
  readonly duplicateGroupId: string | null;
  readonly tokenEstimate: number;
  readonly testEvidence?: string | null;
  readonly reviewerId?: string | null;
  readonly rejectionReason?: string | null;
  readonly source: {
    readonly kind:
      | 'manual'
      | 'user_authored'
      | 'json'
      | 'jsonl'
      | 'csv'
      | 'markdown'
      | 'vibespace_conversation'
      | 'accepted_agent_run'
      | 'git_patch'
      | 'test_artifact'
      | 'context_map'
      | 'licensed'
      | 'approved_feedback';
    readonly reference: string;
    readonly approved: boolean;
  };
  readonly consent: ConsentMetadata;
  readonly createdAt: string;
}

export interface DatasetVersionManifest {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly datasetId: string;
  readonly version: number;
  readonly manifestHash: string;
  readonly fingerprint: string;
  readonly parentVersionId: string | null;
  readonly includedExampleIds: readonly string[];
  readonly excludedExampleIds: readonly string[];
  readonly splitStrategy: {
    readonly method: 'deterministic_hash' | 'manual';
    readonly seed: number;
    readonly statistics: Readonly<Record<DatasetSplit, number>>;
  };
  readonly examples: readonly DatasetExample[];
  readonly scanSummary: {
    readonly status: 'passed' | 'failed';
    readonly scanner: string;
    readonly issueCount: number;
  };
  readonly qualitySummary: {
    readonly status: 'passed' | 'warning' | 'failed';
    readonly score: number;
    readonly reviewedBy: string;
  };
  readonly licenseReport: {
    readonly status: 'passed' | 'failed';
    readonly licenses: readonly string[];
    readonly issueCount: number;
  };
  readonly secretScanReport: {
    readonly status: 'passed' | 'failed';
    readonly scanner: string;
    readonly issueCount: number;
  };
  readonly lineage: {
    readonly parentVersionId: string | null;
    readonly sourceDatasetIds: readonly string[];
    readonly feedbackEventIds: readonly string[];
  };
  readonly createdAt: string;
}

export interface TrainingConfig {
  readonly epochs: number;
  readonly learningRate: number;
  readonly rank: number;
  readonly seed: number;
  readonly batchSize: number;
  readonly gradientAccumulationSteps: number;
  readonly sequenceLength: number;
  readonly validationSplit: number;
}

export interface TrainingManifest {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly backend: TrainingBackendKind;
  readonly method: 'lora' | 'qlora';
  readonly specialistId: string;
  readonly datasetVersionId: string;
  readonly datasetManifestHash: string;
  readonly datasetFingerprint: string;
  readonly baseModelId: string;
  readonly baseRevision: string;
  readonly baseChecksum: Checksum;
  readonly config: TrainingConfig;
  readonly adapterConfiguration: {
    readonly rank: number;
    readonly alpha: number;
    readonly dropout: number;
    readonly targetModules: readonly string[];
  };
  readonly precision: 'fixture_not_applicable' | 'fp32' | 'fp16' | 'bf16';
  readonly quantization: string;
  readonly optimizer: string | null;
  readonly scheduler: string | null;
  readonly softwareVersion: string;
  readonly workerVersion: string;
  readonly hardwareSummary: null | {
    readonly deviceClass: string;
    readonly memoryBytes: number;
  };
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitState: 'pending' | 'fixture_completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly checkpoints: readonly FixtureCheckpointReference[];
  readonly metrics: readonly {
    readonly name: string;
    readonly value: number;
    readonly source: 'fixture';
  }[];
  readonly warnings: readonly string[];
  readonly errors: readonly StructuredTrainingError[];
  readonly artifactChecksums: readonly {
    readonly algorithm: 'fixture-fingerprint-v1';
    readonly value: string;
  }[];
  readonly createdAt: string;
  readonly truthfulLabel: 'fixture-only; no training or GPU work occurred' | 'real training backend';
}

export type ActiveTrainingState = 'queued' | 'preparing' | 'training' | 'checkpointing';
export type TerminalTrainingState = 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type TrainingLifecycleState = ActiveTrainingState | TerminalTrainingState;

export interface FixtureCheckpointReference {
  readonly backend: FixtureBackendKind;
  readonly uri: string;
  readonly fixtureFingerprint: string;
  readonly createdAt: string;
}

export interface FixtureArtifactReference {
  readonly backend: FixtureBackendKind;
  readonly kind: 'adapter';
  readonly uri: string;
  readonly fixtureFingerprint: string;
  readonly modelVersionId: string;
  readonly truthfulLabel: 'fixture-only; no training or GPU work occurred';
  readonly createdAt: string;
}

export interface StructuredTrainingError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly details: Readonly<Record<string, FoundryErrorDetail>>;
}

export interface TrainingJobSnapshot {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly manifestId: string;
  readonly backend: TrainingBackendKind;
  readonly state: TrainingLifecycleState;
  readonly sequence: number;
  readonly progress: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancellation?: {
    readonly actorId: string;
    readonly reason: string;
    readonly requestedAt: string;
    readonly cancelledAt: string;
  };
  readonly recovery: {
    readonly recoverable: boolean;
    readonly previousState?: ActiveTrainingState;
    readonly interruptedAt?: string;
  };
  readonly checkpoint?: FixtureCheckpointReference;
  readonly artifact?: FixtureArtifactReference;
  readonly error?: StructuredTrainingError;
}

export interface EvaluationMetricDefinition {
  readonly id: string;
  readonly name: string;
  readonly direction: 'higher_better' | 'lower_better';
  readonly allowedRegression: number;
}

export interface EvaluationCase {
  readonly id: string;
  readonly hidden: boolean;
  readonly contentHash: string;
  readonly input: string;
  readonly permittedContext: readonly string[];
  readonly expectedSchema: {
    readonly type: 'object';
    readonly required: readonly string[];
  };
  readonly timeoutMilliseconds: number;
  readonly outputCharacterLimit: number;
  readonly allowedTools: readonly string[];
  readonly forbiddenTools: readonly string[];
  readonly privacyClassification: 'private' | 'sensitive' | 'public';
  readonly tags: readonly string[];
  readonly difficulty: 'basic' | 'intermediate' | 'advanced';
  readonly expectedEvidence: readonly string[];
  readonly fixtureEvidence: {
    readonly baseMetrics: Readonly<Record<string, number>>;
    readonly candidateMetrics: Readonly<Record<string, number>>;
    readonly championMetrics?: Readonly<Record<string, number>>;
    readonly safetyFailures: readonly string[];
  };
}

export interface EvaluationSuite {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly targetCapability: string;
  readonly description: string;
  readonly hiddenStatus: 'all_public' | 'contains_hidden_cases' | 'all_hidden';
  readonly caseIds: readonly string[];
  readonly rubric: string;
  readonly deterministicChecks: readonly string[];
  readonly judgeConfiguration: {
    readonly kind: 'deterministic_fixture' | 'model_judge';
    readonly modelId: string | null;
  };
  readonly requiredSafetyCaseIds: readonly string[];
  readonly promotionThresholds: Readonly<Record<string, number>>;
  readonly regressionThresholds: Readonly<Record<string, number>>;
  readonly owner: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly metricDefinitions: readonly EvaluationMetricDefinition[];
  readonly cases: readonly EvaluationCase[];
}

/** Persistable metadata only. Hidden case inputs and fixture answers never enter project snapshots. */
export interface EvaluationSuiteSummary {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly targetCapability: string;
  readonly description: string;
  readonly hiddenStatus: EvaluationSuite['hiddenStatus'];
  readonly caseCount: number;
  readonly metricIds: readonly string[];
  readonly requiredSafetyCaseIds: readonly string[];
  readonly owner: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface EvaluationCaseEvidence {
  readonly caseId: string;
  readonly hidden: boolean;
  readonly metricValues: {
    readonly base: Readonly<Record<string, number>>;
    readonly candidate: Readonly<Record<string, number>>;
    readonly champion?: Readonly<Record<string, number>>;
  };
  readonly safetyFailures: readonly string[];
  readonly evidenceHash: string;
}

export interface AggregateEvaluationDelta {
  readonly metricId: string;
  readonly baseValue: number;
  readonly candidateValue: number;
  readonly candidateDeltaFromBase: number;
  readonly championValue?: number;
  readonly candidateDeltaFromChampion?: number;
  readonly passes: boolean;
}

export type EvaluationGateReason =
  | 'INCOMPLETE_EVALUATION'
  | 'CHAMPION_EVIDENCE_MISSING'
  | 'REGRESSION'
  | 'SAFETY_FAILURE';

export interface EvaluationRun {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly backend: FixtureBackendKind;
  readonly status: 'completed' | 'incomplete';
  readonly identities: {
    readonly baseModelId: string;
    readonly baseRevision: string;
    readonly candidateVersionId: string;
    readonly championVersionId?: string;
  };
  readonly caseEvidence: readonly EvaluationCaseEvidence[];
  readonly aggregateDeltas: readonly AggregateEvaluationDelta[];
  readonly safetyFailures: readonly string[];
  readonly gate: {
    readonly result: 'pass' | 'blocked' | 'incomplete';
    readonly reasons: readonly EvaluationGateReason[];
  };
  readonly createdAt: string;
}

export interface ModelVersion {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly sourceJobId: string;
  readonly baseModelId: string;
  readonly baseRevision: string;
  readonly datasetVersionId: string;
  readonly role: 'candidate';
  readonly license: string;
  readonly artifactFingerprint: string;
  readonly artifact: FixtureArtifactReference;
  readonly modelCard: {
    readonly summary: string;
    readonly intendedUse: string;
    readonly limitations: readonly string[];
    readonly evaluationRunIds: readonly string[];
  };
  readonly createdAt: string;
}

export interface PromotionRecord {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly action: 'promote' | 'rollback';
  readonly targetVersionId: string;
  readonly evaluationRunId?: string;
  readonly previousChampionVersionId?: string;
  readonly rollbackTargetVersionId?: string;
  readonly immutableRollbackPoint: {
    readonly versionId: string;
    readonly artifactFingerprint: string;
  };
  readonly gateEvidence: {
    readonly artifactChecksumVerified: boolean;
    readonly licenseApproved: boolean;
    readonly evaluationGatePassed: boolean;
  };
  readonly approval: {
    readonly approved: true;
    readonly actorId: string;
    readonly reason: string;
    readonly approvedAt: string;
  };
  readonly createdAt: string;
}

export interface FeedbackSubmission {
  readonly rating: 'helpful' | 'not_helpful';
  readonly evidenceHash: string;
  readonly consent: ConsentMetadata;
}

export interface ApprovedFeedbackEvent {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly rating: 'helpful' | 'not_helpful';
  readonly evidenceHash: string;
  readonly consent: ConsentMetadata & { readonly approved: true };
  readonly createdAt: string;
}

export interface ImprovementCycle {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly feedbackProvenance: readonly {
    readonly feedbackEventId: string;
    readonly consentActorId: string;
    readonly consentApprovedAt: string;
  }[];
  readonly createdAt: string;
}

export interface FoundryProject {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly id: string;
  readonly specialist: SpecialistDefinition;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectSnapshot {
  readonly schemaVersion: FoundrySchemaVersion;
  readonly fixtureLabel: FixtureBackendKind;
  readonly project: FoundryProject;
  readonly baseModel?: BaseModelRecord;
  readonly datasetVersion?: DatasetVersionManifest;
  readonly trainingManifest?: TrainingManifest;
  readonly trainingManifests: readonly TrainingManifest[];
  readonly trainingJobs: readonly TrainingJobSnapshot[];
  readonly evaluationSuites: readonly EvaluationSuiteSummary[];
  readonly evaluationRuns: readonly EvaluationRun[];
  readonly modelVersions: readonly ModelVersion[];
  readonly promotions: readonly PromotionRecord[];
  readonly feedbackEvents: readonly ApprovedFeedbackEvent[];
  readonly improvementCycles: readonly ImprovementCycle[];
  readonly championVersionId?: string;
}

export interface StartTrainingInput {
  readonly method: 'lora' | 'qlora';
  readonly config: TrainingConfig;
}

export interface EvaluationOptions {
  readonly completedCaseIds?: readonly string[];
}

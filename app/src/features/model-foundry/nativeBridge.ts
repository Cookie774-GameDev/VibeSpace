/**
 * nativeBridge — Model Foundry native boundary (adapted).
 *
 * The preserved Foundry source exposed an older-generation native command
 * surface. The merged architecture keeps the newer canonical Rust commands
 * (job-based training, attested worker, catalog downloads, artifact chat)
 * and maps the Foundry Studio API onto them. Capability gaps are bridged
 * inside the canonical engine (bounded inline dataset materialization) or
 * fail closed with explicit errors. No ambient authority is introduced.
 */

import { isTauri } from '../../lib/utils';

export interface FoundryHardwareProfile {
  readonly native: boolean;
  readonly os: string;
  readonly architecture: string;
  readonly logicalCores: number;
  readonly ramBytes: number | null;
  readonly acceleratorStatus: 'available' | 'unavailable' | 'unknown';
  readonly acceleratorDetail: string;
  readonly detectionComplete: boolean;
  readonly recommendedMode: string;
  readonly warnings: readonly string[];
}

export interface FoundryModelDownloadRequest {
  readonly projectId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly license: string;
  readonly files: readonly {
    readonly path: string;
    readonly url: string;
    readonly expectedSha256: string;
    readonly expectedSizeBytes: number;
  }[];
  readonly licenseApproved: boolean;
}

export interface FoundryModelDownloadResult {
  readonly modelId: string;
  readonly path: string;
  readonly manifestPath: string;
  readonly sizeBytes: number;
  readonly resumed: boolean;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
}

export interface FoundryNativeTrainingExample {
  readonly prompt: string;
  readonly completion: string;
}

export interface FoundryNativeTrainingRequest {
  readonly projectId: string;
  readonly jobId: string;
  readonly modelId: string;
  readonly datasetVersionId: string;
  readonly datasetManifestHash: string;
  readonly datasetFingerprint: string;
  readonly datasetApproved: boolean;
  readonly trainExamples: readonly FoundryNativeTrainingExample[];
  readonly validationExamples: readonly FoundryNativeTrainingExample[];
  readonly trainingConfig: {
    readonly method: 'lora' | 'qlora';
    readonly computeDevice: 'gpu' | 'cpu';
    readonly seed: number;
    readonly epochs: number;
    /** Optional bounded step cap for short local runs and advanced workflows. */
    readonly maxSteps?: number;
    readonly batchSize: number;
    readonly gradientAccumulation: number;
    readonly maxSequenceLength: number;
    readonly learningRate: number;
    readonly loraRank: number;
    readonly loraAlpha: number;
    readonly loraDropout: number;
  };
  readonly targetModules?: readonly string[];
}

export interface FoundryNativeTrainingStart {
  readonly started: boolean;
  readonly projectId: string;
  readonly jobId: string;
  readonly jobDir: string;
}

export interface FoundryRealArtifactSummary {
  readonly projectId: string;
  readonly jobId: string;
  readonly manifestSha256: string;
  readonly adapterFiles: Readonly<Record<string, string>>;
  readonly metrics: Record<string, unknown>;
  readonly trainingConfig: Record<string, unknown>;
}

export interface FoundryArtifactGeneration {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly artifactManifestSha256: string;
}

export interface FoundryRealEvaluationReport {
  readonly suite: string;
  readonly caseCount: number;
  readonly baseScore: number | null;
  readonly candidateScore: number;
  readonly championScore: number | null;
  readonly delta: number | null;
  readonly safetyFailures: readonly string[];
  readonly gate: 'pass' | 'blocked';
  readonly caseEvidence: readonly {
    readonly caseId: string;
    readonly hidden?: boolean;
    readonly baseScore: number | null;
    readonly candidateScore: number;
    readonly championScore: number | null;
    readonly evidenceHash: string;
  }[];
}

export interface FoundryArtifactEvaluation {
  readonly artifactManifestSha256: string;
  readonly report: FoundryRealEvaluationReport;
}

export interface FoundryWorkerMessage {
  readonly projectId: string;
  readonly jobId: string;
  readonly message: Record<string, unknown>;
}

export interface FoundryWorkerRuntimeStatus {
  readonly ready: boolean;
  readonly root: string;
  readonly python: string | null;
  readonly workerInstalled: boolean;
  readonly protocolVersion: number;
  readonly detail: string;
}

export interface FoundryTrainingRuntimeStatus {
  readonly installed: boolean;
  readonly qloraInstalled: boolean;
  readonly detail: string;
}

export interface FoundryWorkerProbe {
  readonly healthy: boolean;
  readonly workerVersion: string;
  readonly capabilities: readonly string[];
  readonly protocolVersion: number;
}

export interface FoundryPrivateEvaluationCase {
  readonly id: string;
  readonly prompt: string;
  readonly expectedCompletion: string;
  readonly hidden: boolean;
}

interface CurrentHardwareProfile {
  readonly cpu: string;
  readonly gpu: string | null;
  readonly ramGb: number;
  readonly vramGb: number;
  readonly freeStorageGb: number;
  readonly os: string;
  readonly accelerators: readonly string[];
}

interface CurrentFoundryJob {
  readonly id: string;
  readonly projectId?: string | null;
  readonly name: string;
  readonly baseModelId: string;
  readonly method: string;
  readonly status: string;
  readonly progress: number;
  readonly artifactPath: string | null;
  readonly artifactVerified: boolean;
  readonly artifactSha256: string | null;
  readonly storageBytes: number;
  readonly sourceCount: number;
  readonly version: number;
  readonly resumeAvailable: boolean;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CurrentTrainingWorkerStatus {
  readonly installed: boolean;
  readonly attested: boolean;
  readonly protocol: number;
  readonly sourceSha256: string;
  readonly python: string | null;
  readonly methods: readonly string[];
  readonly modalities: readonly string[];
  readonly precisions: readonly string[];
  readonly reason: string | null;
}

interface CurrentTrainingCatalogEntry {
  readonly id: string;
  readonly installed: boolean;
  readonly verified: boolean;
  readonly installedBytes: number;
  readonly status: string;
}

const PROJECT_BY_JOB_LIMIT = 128;
const projectByJobId = new Map<string, string>();

function rememberJobProject(jobId: string, projectId: string): void {
  if (!jobId || !projectId) return;
  projectByJobId.delete(jobId);
  projectByJobId.set(jobId, projectId);
  while (projectByJobId.size > PROJECT_BY_JOB_LIMIT) {
    const oldest = projectByJobId.keys().next().value;
    if (typeof oldest !== 'string') break;
    projectByJobId.delete(oldest);
  }
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke<T>(command, args);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function getFoundryHardwareProfile(): Promise<FoundryHardwareProfile> {
  if (!isTauri) {
    return {
      native: false,
      os: typeof navigator === 'undefined' ? 'web' : navigator.platform || 'web',
      architecture: 'unknown',
      logicalCores: typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1,
      ramBytes: null,
      acceleratorStatus: 'unknown',
      acceleratorDetail: 'Desktop hardware check unavailable in web mode.',
      detectionComplete: false,
      recommendedMode: 'fixture_only_until_desktop_check',
      warnings: ['Open the VibeSpace desktop app for an OS-level hardware check.'],
    };
  }
  const profile = await invoke<CurrentHardwareProfile>('model_foundry_detect_hardware');
  const accelerators = profile.accelerators ?? [];
  return {
    native: true,
    os: profile.os,
    architecture: 'unknown',
    logicalCores: typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1,
    ramBytes: Number.isFinite(profile.ramGb) ? Math.round(profile.ramGb * 1024 ** 3) : null,
    acceleratorStatus: accelerators.length > 0 ? 'available' : 'unavailable',
    acceleratorDetail:
      accelerators.length > 0
        ? accelerators.join(', ')
        : (profile.gpu ?? 'No accelerator detected.'),
    detectionComplete: true,
    recommendedMode: accelerators.length > 0 ? 'native_accelerated' : 'cpu_only',
    warnings: [],
  };
}

async function readWorkerStatus(): Promise<CurrentTrainingWorkerStatus> {
  return invoke<CurrentTrainingWorkerStatus>('model_foundry_training_worker_status');
}

function mapWorkerRuntimeStatus(status: CurrentTrainingWorkerStatus): FoundryWorkerRuntimeStatus {
  return {
    ready: status.installed && status.attested,
    root: 'private-application-directory',
    python: status.python,
    workerInstalled: status.installed,
    protocolVersion: status.protocol,
    detail:
      status.reason ??
      (status.attested
        ? 'Attested local training worker is installed.'
        : 'Training worker is not attested yet.'),
  };
}

export async function getFoundryRuntimeStatus(): Promise<FoundryWorkerRuntimeStatus> {
  if (!isTauri)
    return {
      ready: false,
      root: 'browser:unavailable',
      python: null,
      workerInstalled: false,
      protocolVersion: 1,
      detail: 'Native worker runtime is available only in the desktop app.',
    };
  return mapWorkerRuntimeStatus(await readWorkerStatus());
}

export async function prepareFoundryRuntime(): Promise<FoundryWorkerRuntimeStatus> {
  if (!isTauri) throw new Error('Native worker runtime is available only in the desktop app.');
  return mapWorkerRuntimeStatus(
    await invoke<CurrentTrainingWorkerStatus>('model_foundry_install_training_worker', {
      includeQlora: false,
    }),
  );
}

export async function getFoundryTrainingRuntimeStatus(): Promise<FoundryTrainingRuntimeStatus> {
  if (!isTauri)
    return {
      installed: false,
      qloraInstalled: false,
      detail: 'Real LoRA training is available only in the desktop app.',
    };
  const status = await readWorkerStatus();
  return {
    installed: status.installed && status.attested && status.methods.includes('full'),
    qloraInstalled: status.installed && status.attested && status.methods.includes('full') && status.methods.includes('qlora'),
    detail:
      status.reason ??
      (status.installed && status.attested && status.methods.includes('full')
        ? 'Local training runtime is installed.'
        : 'Local training runtime is not installed yet.'),
  };
}

export async function installFoundryTrainingDependencies(
  includeQlora = false,
): Promise<FoundryTrainingRuntimeStatus> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  const status = await invoke<CurrentTrainingWorkerStatus>(
    'model_foundry_install_training_worker',
    { includeQlora },
  );
  return {
    installed: status.installed && status.attested && status.methods.includes('full'),
    qloraInstalled: status.installed && status.attested && status.methods.includes('full') && status.methods.includes('qlora'),
    detail:
      status.reason ??
      (status.installed && status.attested && status.methods.includes('full')
        ? 'Local training runtime is installed.'
        : 'Local training runtime installation failed.'),
  };
}

function serializeDatasetJsonl(examples: readonly FoundryNativeTrainingExample[]): string {
  return examples
    .map((example) => JSON.stringify({ prompt: example.prompt, completion: example.completion }))
    .join('\n');
}

export async function startFoundryTraining(
  request: FoundryNativeTrainingRequest,
): Promise<FoundryNativeTrainingStart> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  if (!request.datasetApproved)
    throw new Error('Dataset approval is required before local training can start.');
  if (request.trainExamples.length === 0) {
    throw new Error('At least one approved training example is required.');
  }
  if (request.validationExamples.length === 0) {
    throw new Error('At least one approved validation example is required.');
  }
  const datasetJsonl = serializeDatasetJsonl(request.trainExamples);
  const validationDatasetJsonl = serializeDatasetJsonl(request.validationExamples);
  const created = await invoke<CurrentFoundryJob>('model_foundry_start_training', {
    request: {
      schemaVersion: 2,
      projectId: request.projectId,
      name: 'Foundry ' + request.jobId,
      description: 'Dataset Studio training run for project ' + request.projectId,
      purpose: 'Local adapter training from a reviewed Dataset Studio version.',
      instructions: null,
      baseModelId: request.modelId,
      method: request.trainingConfig.method,
      epochs: request.trainingConfig.epochs,
      ...(request.trainingConfig.maxSteps === undefined
        ? {}
        : { maxSteps: request.trainingConfig.maxSteps }),
      sourcePaths: [],
      datasetJsonl,
      validationDatasetJsonl,
      datasetVersionId: request.datasetVersionId,
      datasetManifestHash: request.datasetManifestHash,
      datasetFingerprint: request.datasetFingerprint,
      trainingConfig: request.trainingConfig,
      ...(request.targetModules ? { targetModules: request.targetModules } : {}),
      localOnly: true,
    },
  });
  rememberJobProject(created.id, request.projectId);
  return {
    started: true,
    projectId: request.projectId,
    jobId: created.id,
    jobDir: 'private-application-directory',
  };
}

export async function resumeFoundryTraining(
  projectId: string,
  jobId: string,
): Promise<FoundryNativeTrainingStart> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  const resumed = await invoke<CurrentFoundryJob>('model_foundry_resume_job', { jobId });
  return {
    started: resumed.resumeAvailable || resumed.status !== 'failed',
    projectId,
    jobId: resumed.id,
    jobDir: 'private-application-directory',
  };
}

export async function inspectFoundryArtifact(
  projectId: string,
  jobId: string,
): Promise<FoundryRealArtifactSummary> {
  if (!isTauri) throw new Error('Real training artifacts are available only in the desktop app.');
  const jobs = await invoke<CurrentFoundryJob[]>('model_foundry_list_jobs');
  const job = jobs.find((entry) => entry.id === jobId);
  if (!job) throw new Error('Model Foundry artifact was not found.');
  return {
    projectId,
    jobId: job.id,
    manifestSha256: job.artifactSha256 ?? '',
    adapterFiles: job.artifactPath ? { artifact: job.artifactPath } : {},
    metrics: {
      status: job.status,
      progress: job.progress,
      storageBytes: job.storageBytes,
      sourceCount: job.sourceCount,
      version: job.version,
      artifactVerified: job.artifactVerified,
    },
    trainingConfig: { method: job.method, baseModelId: job.baseModelId, name: job.name },
  };
}

type FoundryChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface NativeFoundryChatResponse {
  artifactId: string; modelName: string; version: number; method: 'lora' | 'qlora' | 'full';
  text: string; inputTokens: number; outputTokens: number;
}

function abortedFoundryInference(cause?: unknown): DOMException {
  const error = new DOMException('Local inference was aborted.', 'AbortError');
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

async function chatWithArtifact(
  artifactId: string,
  prompt: string,
  maxNewTokens?: number,
  messages?: readonly FoundryChatMessage[],
  signal?: AbortSignal,
): Promise<NativeFoundryChatResponse> {
  if (signal?.aborted) throw abortedFoundryInference();
  const core = await import('@tauri-apps/api/core');
  if (signal?.aborted) throw abortedFoundryInference();
  const requestId = 'foundry-bridge-' + crypto.randomUUID();
  let settled = false;
  let cancelling = false;
  let cancellationRequested = false;
  let cancellationError: unknown;
  let retryDelay = 100;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (settled || cancelling || cancellationRequested) return;
    cancelling = true;
    void (async () => {
      try {
        const cancelled = await core.invoke<boolean>('model_foundry_cancel_chat', { requestId });
        if (cancelled === true) {
          cancellationRequested = true;
          cancellationError = undefined;
        } else if (cancelled !== false) {
          cancellationError = new Error('Model Foundry returned invalid cancellation evidence.');
        }
      } catch (error) {
        cancellationError = error;
      } finally {
        cancelling = false;
        // Verification can precede worker registration. A false acknowledgment
        // does not finish this request; retry only its ID while its IPC is pending.
        if (!settled && !cancellationRequested) {
          retryTimer = setTimeout(cancel, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 1_000);
        }
      }
    })();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  // The chat command performs its own completed-job and full artifact checks.
  // A separate prepare call repeats an expensive full weight-manifest scan.
  let response: NativeFoundryChatResponse;
  try {
    response = await core.invoke<NativeFoundryChatResponse>('model_foundry_chat', {
      requestId,
      artifactId,
      messages: messages ? [...messages] : [{ role: 'user', content: prompt }],
      maxOutputTokens: maxNewTokens ?? null,
    });
  } finally {
    // Preserve native rejection details: a cleanup failure does not prove closure.
    // The original native invocation owns worker completion, including after a
    // successful cancel request. Never publish completion from its boolean alone.
    settled = true;
    signal?.removeEventListener('abort', cancel);
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  }
  if (signal?.aborted) throw abortedFoundryInference(cancellationError);
  if (!response || response.artifactId !== artifactId || typeof response.modelName !== 'string' ||
      !response.modelName.trim() || !Number.isInteger(response.version) || response.version < 1 ||
      !['lora', 'qlora', 'full'].includes(response.method) || typeof response.text !== 'string' ||
      !response.text.trim() || !Number.isSafeInteger(response.inputTokens) || response.inputTokens < 0 ||
      !Number.isSafeInteger(response.outputTokens) || response.outputTokens < 1) {
    throw new Error('Model Foundry returned mismatched or incomplete inference evidence.');
  }
  return response;
}

export async function generateFromFoundryArtifact(args: {
  projectId: string;
  jobId: string;
  prompt: string;
  messages?: readonly FoundryChatMessage[];
  maxNewTokens?: number;
  signal?: AbortSignal;
}): Promise<FoundryArtifactGeneration> {
  if (!isTauri) throw new Error('Local adapter inference is available only in the desktop app.');
  const response = await chatWithArtifact(
    args.jobId, args.prompt, args.maxNewTokens, args.messages, args.signal,
  );
  const jobs = await invoke<CurrentFoundryJob[]>('model_foundry_list_jobs');
  if (args.signal?.aborted) throw abortedFoundryInference();
  const job = Array.isArray(jobs) ? jobs.find((entry) => entry.id === args.jobId) : undefined;
  if (!job || job.status !== 'completed' || job.artifactVerified !== true ||
      job.name !== response.modelName || job.version !== response.version || job.method !== response.method ||
      typeof job.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(job.artifactSha256) ||
      (args.projectId !== 'artifact' && job.projectId !== args.projectId)) {
    throw new Error('Model Foundry returned mismatched or unverified artifact identity.');
  }
  return {
    text: response.text,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    artifactManifestSha256: job.artifactSha256,
  };
}

export async function evaluateFoundryArtifact(args: {
  projectId: string;
  jobId: string;
  championJobId?: string;
  maxCases?: number;
  maxNewTokens?: number;
  cases?: readonly FoundryPrivateEvaluationCase[];
}): Promise<FoundryArtifactEvaluation> {
  if (!isTauri) throw new Error('Local adapter evaluation is available only in the desktop app.');
  if (args.championJobId !== undefined)
    throw new Error('Champion comparison is not available in the current local evaluator.');
  const maxCases = args.maxCases ?? 32;
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 32)
    throw new Error('Evaluation case limit must be an integer from 1 to 32.');
  if (!Array.isArray(args.cases) || args.cases.length === 0 || args.cases.length > 32)
    throw new Error('Evaluation requires 1 to 32 reviewed private cases.');
  const ids = new Set<string>();
  for (const entry of args.cases) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128 ||
        ids.has(entry.id) || typeof entry.prompt !== 'string' || !entry.prompt.trim() ||
        entry.prompt.length > 16_384 || typeof entry.expectedCompletion !== 'string' ||
        !entry.expectedCompletion.trim() || entry.expectedCompletion.length > 12_000)
      throw new Error('Every evaluation case needs a unique ID, prompt and expected completion within the supported limits.');
    ids.add(entry.id);
  }
  const cases = args.cases.slice(0, maxCases).map((entry) => ({ ...entry }));
  const jobs = await invoke<CurrentFoundryJob[]>('model_foundry_list_jobs');
  const job = Array.isArray(jobs) ? jobs.find((entry) => entry.id === args.jobId) : undefined;
  if (!job || job.status !== 'completed' || job.artifactVerified !== true ||
      typeof job.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(job.artifactSha256) ||
      (args.projectId !== 'artifact' && job.projectId !== args.projectId))
    throw new Error('Evaluation requires the selected verified artifact in its original project.');
  const manifestSha256 = job.artifactSha256;
  const evidence: FoundryRealEvaluationReport['caseEvidence'][number][] = [];
  let totalScore = 0;
  for (const evaluationCase of cases) {
    const result = await generateFromFoundryArtifact({
      projectId: args.projectId, jobId: args.jobId,
      prompt: evaluationCase.prompt, maxNewTokens: args.maxNewTokens,
    });
    if (result.artifactManifestSha256 !== manifestSha256)
      throw new Error('The selected artifact changed during evaluation. Run a new evaluation.');
    const output = result.text;
    const normalizedOutput = output.trim().toLowerCase();
    const normalizedExpected = evaluationCase.expectedCompletion.trim().toLowerCase();
    const score = normalizedOutput === normalizedExpected ? 1
      : normalizedOutput.includes(normalizedExpected) || normalizedExpected.includes(normalizedOutput) ? 0.5 : 0;
    totalScore += score;
    evidence.push({
      caseId: evaluationCase.id,
      hidden: evaluationCase.hidden || undefined,
      baseScore: null,
      candidateScore: score,
      championScore: null,
      evidenceHash: await sha256Hex(JSON.stringify({
        artifactManifestSha256: manifestSha256,
        prompt: evaluationCase.prompt, expectedCompletion: evaluationCase.expectedCompletion, output,
      })),
    });
  }
  return {
    artifactManifestSha256: manifestSha256,
    report: {
      suite: 'private-dataset-candidate-v1',
      caseCount: cases.length,
      baseScore: null,
      candidateScore: totalScore / cases.length,
      championScore: null,
      delta: null,
      safetyFailures: [],
      // This boundary only measures reference matching for the candidate. No base,
      // champion, or safety assessment was executed, so it cannot authorize promotion.
      gate: 'blocked',
      caseEvidence: evidence,
    },
  };
}

export async function cancelFoundryTraining(projectId: string, jobId: string): Promise<boolean> {
  if (!isTauri) return false;
  void projectId;
  const job = await invoke<CurrentFoundryJob>('model_foundry_cancel_job', { jobId });
  return job.status === 'cancelled' || job.status === 'interrupted';
}

export async function stopFoundryTrainingAfterCheckpoint(
  projectId: string,
  jobId: string,
): Promise<boolean> {
  // The canonical engine cancels bounded training immediately; checkpoint
  // artifacts already written to the private job directory remain intact.
  return cancelFoundryTraining(projectId, jobId);
}

export async function listenFoundryWorkerMessages(
  listener: (event: FoundryWorkerMessage) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const event = await import('@tauri-apps/api/event');
  const unlisten = await event.listen<CurrentFoundryJob>(
    'model-foundry:job-updated',
    ({ payload }) => {
      const projectId = payload.projectId?.trim() || projectByJobId.get(payload.id) || '';
      listener({
        projectId,
        jobId: payload.id,
        message: { type: 'job-updated', status: payload.status, progress: payload.progress },
      });
      if (['completed', 'failed', 'cancelled'].includes(payload.status)) {
        projectByJobId.delete(payload.id);
      }
    },
  );
  return unlisten;
}

export async function probeFoundryWorker(projectId: string): Promise<FoundryWorkerProbe> {
  if (!isTauri) throw new Error('Native worker probe is available only in the desktop app.');
  void projectId;
  const status = await readWorkerStatus();
  return {
    healthy: status.installed && status.attested,
    workerVersion: status.sourceSha256.slice(0, 16),
    capabilities: [...status.methods, ...status.modalities],
    protocolVersion: status.protocol,
  };
}

export async function downloadFoundryModel(
  request: FoundryModelDownloadRequest,
): Promise<FoundryModelDownloadResult> {
  if (!isTauri) throw new Error('Verified model downloads are available only in the desktop app.');
  if (!request.licenseApproved)
    throw new Error('Model license approval is required before download.');
  const result = await invoke<FoundryModelDownloadResult>('model_foundry_download_model', {
    request,
  });
  return result;
}

export async function cancelFoundryModelDownload(
  projectId: string,
  modelId: string,
): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>('model_foundry_cancel_download', { projectId, modelId });
}

export async function cleanupFoundryPartialDownload(modelId: string): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>('model_foundry_cleanup_partial_download', { modelId });
}

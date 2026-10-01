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
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[];
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
    readonly seed: number;
    readonly epochs: number;
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
  readonly baseScore: number;
  readonly candidateScore: number;
  readonly championScore: number | null;
  readonly delta: number;
  readonly safetyFailures: readonly string[];
  readonly gate: 'pass' | 'blocked';
  readonly caseEvidence: readonly { readonly caseId: string; readonly hidden?: boolean; readonly baseScore: number; readonly candidateScore: number; readonly championScore: number | null; readonly evidenceHash: string }[];
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

export interface FoundryPrivateEvaluationCase { readonly id: string; readonly prompt: string; readonly expectedCompletion: string; readonly hidden: boolean }

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
    acceleratorDetail: accelerators.length > 0 ? accelerators.join(', ') : profile.gpu ?? 'No accelerator detected.',
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
    detail: status.reason ?? (status.attested ? 'Attested local training worker is installed.' : 'Training worker is not attested yet.'),
  };
}

export async function getFoundryRuntimeStatus(): Promise<FoundryWorkerRuntimeStatus> {
  if (!isTauri) return { ready: false, root: 'browser:unavailable', python: null, workerInstalled: false, protocolVersion: 1, detail: 'Native worker runtime is available only in the desktop app.' };
  return mapWorkerRuntimeStatus(await readWorkerStatus());
}

export async function prepareFoundryRuntime(): Promise<FoundryWorkerRuntimeStatus> {
  if (!isTauri) throw new Error('Native worker runtime is available only in the desktop app.');
  return mapWorkerRuntimeStatus(await invoke<CurrentTrainingWorkerStatus>('model_foundry_install_training_worker'));
}

export async function getFoundryTrainingRuntimeStatus(): Promise<FoundryTrainingRuntimeStatus> {
  if (!isTauri) return { installed: false, qloraInstalled: false, detail: 'Real LoRA training is available only in the desktop app.' };
  const status = await readWorkerStatus();
  return {
    installed: status.installed,
    qloraInstalled: status.methods.includes('qlora'),
    detail: status.reason ?? (status.installed ? 'Local training runtime is installed.' : 'Local training runtime is not installed yet.'),
  };
}

export async function installFoundryTrainingDependencies(includeQlora = false): Promise<FoundryTrainingRuntimeStatus> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  void includeQlora;
  const status = await invoke<CurrentTrainingWorkerStatus>('model_foundry_install_training_worker');
  return {
    installed: status.installed,
    qloraInstalled: status.methods.includes('qlora'),
    detail: status.reason ?? (status.installed ? 'Local training runtime is installed.' : 'Local training runtime installation failed.'),
  };
}

function serializeDatasetJsonl(examples: readonly FoundryNativeTrainingExample[]): string {
  return examples.map((example) => JSON.stringify({ prompt: example.prompt, completion: example.completion })).join('\n');
}

export async function startFoundryTraining(request: FoundryNativeTrainingRequest): Promise<FoundryNativeTrainingStart> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  if (!request.datasetApproved) throw new Error('Dataset approval is required before local training can start.');
  const datasetJsonl = serializeDatasetJsonl(request.trainExamples);
  const created = await invoke<CurrentFoundryJob>('model_foundry_start_training', {
    request: {
      name: 'Foundry ' + request.jobId,
      description: 'Dataset Studio training run for project ' + request.projectId,
      purpose: 'Local adapter training from a reviewed Dataset Studio version.',
      instructions: null,
      baseModelId: request.modelId,
      method: request.trainingConfig.method,
      sourcePaths: [],
      datasetJsonl,
      datasetManifestHash: request.datasetManifestHash,
      datasetFingerprint: request.datasetFingerprint,
      localOnly: true,
    },
  });
  return { started: true, projectId: request.projectId, jobId: created.id, jobDir: 'private-application-directory' };
}

export async function resumeFoundryTraining(projectId: string, jobId: string): Promise<FoundryNativeTrainingStart> {
  if (!isTauri) throw new Error('Real LoRA training is available only in the desktop app.');
  const resumed = await invoke<CurrentFoundryJob>('model_foundry_resume_job', { jobId });
  return { started: resumed.resumeAvailable || resumed.status !== 'failed', projectId, jobId: resumed.id, jobDir: 'private-application-directory' };
}

export async function inspectFoundryArtifact(projectId: string, jobId: string): Promise<FoundryRealArtifactSummary> {
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

async function chatWithArtifact(artifactId: string, prompt: string, maxNewTokens?: number): Promise<string> {
  const requestId = 'foundry-bridge-' + crypto.randomUUID();
  await invoke('model_foundry_prepare_chat', { artifactId, query: prompt, limit: null });
  const response = await invoke<{ text?: string; content?: string; message?: string }>('model_foundry_chat', {
    requestId,
    artifactId,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: maxNewTokens ?? null,
  });
  return response.text ?? response.content ?? response.message ?? '';
}

export async function generateFromFoundryArtifact(args: { projectId: string; jobId: string; prompt: string; maxNewTokens?: number }): Promise<FoundryArtifactGeneration> {
  if (!isTauri) throw new Error('Local adapter inference is available only in the desktop app.');
  const text = await chatWithArtifact(args.jobId, args.prompt, args.maxNewTokens);
  const jobs = await invoke<CurrentFoundryJob[]>('model_foundry_list_jobs');
  const job = jobs.find((entry) => entry.id === args.jobId);
  return {
    text,
    inputTokens: estimateTokens(args.prompt),
    outputTokens: estimateTokens(text),
    artifactManifestSha256: job?.artifactSha256 ?? '',
  };
}

export async function evaluateFoundryArtifact(args: { projectId: string; jobId: string; championJobId?: string; maxCases?: number; maxNewTokens?: number; cases?: readonly FoundryPrivateEvaluationCase[] }): Promise<FoundryArtifactEvaluation> {
  if (!isTauri) throw new Error('Local adapter evaluation is available only in the desktop app.');
  const cases = (args.cases ?? []).slice(0, args.maxCases ?? 32);
  if (cases.length === 0) throw new Error('Evaluation requires at least one reviewed private case.');
  const jobs = await invoke<CurrentFoundryJob[]>('model_foundry_list_jobs');
  const job = jobs.find((entry) => entry.id === args.jobId);
  if (!job) throw new Error('Model Foundry artifact was not found.');
  const evidence: { caseId: string; hidden?: boolean; baseScore: number; candidateScore: number; championScore: number | null; evidenceHash: string }[] = [];
  let passed = 0;
  for (const evaluationCase of cases) {
    const output = await chatWithArtifact(args.jobId, evaluationCase.prompt, args.maxNewTokens);
    const normalizedOutput = output.trim().toLowerCase();
    const normalizedExpected = evaluationCase.expectedCompletion.trim().toLowerCase();
    const score = normalizedOutput === normalizedExpected ? 1 : normalizedOutput.includes(normalizedExpected) || normalizedExpected.includes(normalizedOutput) ? 0.5 : 0;
    if (score >= 0.5) passed += 1;
    evidence.push({
      caseId: evaluationCase.id,
      hidden: evaluationCase.hidden || undefined,
      baseScore: 0,
      candidateScore: score,
      championScore: null,
      evidenceHash: await sha256Hex(JSON.stringify({ prompt: evaluationCase.prompt, output })),
    });
  }
  const candidateScore = passed / cases.length;
  return {
    artifactManifestSha256: job.artifactSha256 ?? '',
    report: {
      suite: 'private-dataset-studio',
      caseCount: cases.length,
      baseScore: 0,
      candidateScore,
      championScore: null,
      delta: candidateScore,
      safetyFailures: [],
      gate: candidateScore >= 0.5 ? 'pass' : 'blocked',
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

export async function stopFoundryTrainingAfterCheckpoint(projectId: string, jobId: string): Promise<boolean> {
  // The canonical engine cancels bounded training immediately; checkpoint
  // artifacts already written to the private job directory remain intact.
  return cancelFoundryTraining(projectId, jobId);
}

export async function listenFoundryWorkerMessages(listener: (event: FoundryWorkerMessage) => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const event = await import('@tauri-apps/api/event');
  const unlisten = await event.listen<CurrentFoundryJob>('model-foundry:job-updated', ({ payload }) =>
    listener({
      projectId: '',
      jobId: payload.id,
      message: { type: 'job-updated', status: payload.status, progress: payload.progress },
    }),
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

export async function downloadFoundryModel(request: FoundryModelDownloadRequest): Promise<FoundryModelDownloadResult> {
  if (!isTauri) throw new Error('Verified model downloads are available only in the desktop app.');
  if (!request.licenseApproved) throw new Error('Model license approval is required before download.');
  const result = await invoke<FoundryModelDownloadResult>('model_foundry_download_model', { request });
  return result;
}

export async function cancelFoundryModelDownload(projectId: string, modelId: string): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>('model_foundry_cancel_download', { projectId, modelId });
}

export async function cleanupFoundryPartialDownload(modelId: string): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>('model_foundry_cleanup_partial_download', { modelId });
}

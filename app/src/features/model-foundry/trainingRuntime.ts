import { isTauri } from '@/lib/utils';
import type {
  FoundryTrainingConfiguration,
  TrainableModel,
  TrainingMethod,
  TrainingModality,
  TrainingPrecision,
} from './modelHub';

type WeightTrainingMethod = Exclude<TrainingMethod, 'knowledge'>;

export interface LocalTrainingWorkerStatus {
  installed: boolean;
  attested: boolean;
  localOnly: true;
  protocol: number;
  sourceSha256: string;
  python: string | null;
  methods: WeightTrainingMethod[];
  modalities: TrainingModality[];
  precisions: TrainingPrecision[];
  reason: string | null;
  calibration?: TrainingCalibrationEvidence | null;
}

export interface TrainingCalibrationEvidence {
  qualified: boolean;
  modelId: string;
  method: WeightTrainingMethod;
  computeDevice: 'gpu' | 'cpu';
  device: string;
  precision: TrainingPrecision;
  forwardBackward: boolean;
  optimizerStep: boolean;
  batchSize: number;
  gradientAccumulation: number;
  maxSequenceLength: number;
  warmupSteps: number;
  measuredSteps: number;
  stepTimeMs: number;
  stepTimeMsP95: number;
  peakVramMb: number | null;
  vramTotalMb: number | null;
  vramHeadroomMb: number | null;
  elapsedMs: number;
  reason: string | null;
}

interface NativeTrainingWorkerStatus {
  installed: boolean;
  attested: boolean;
  protocol: number;
  sourceSha256: string;
  python: string | null;
  methods: string[];
  modalities: string[];
  precisions: string[];
  reason: string | null;
  calibration?: unknown;
}

export interface VerifiedTrainingModel {
  id: string;
  label: string;
  sourceId: string;
  revision: string;
  license: string;
  licenseUrl: string;
  gated: false;
  parametersB: number;
  downloadBytes: number;
  expectedRamGb: number;
  expectedVramGb: number;
  contextTokens: number;
  precision: string;
  modalities: TrainingModality[];
  speed: 'fast' | 'medium' | 'slow';
  quality: 'efficient' | 'balanced' | 'high';
  cpuPractical: boolean;
  installed: boolean;
  verified: boolean;
  installedBytes: number;
  status: 'not-installed' | 'repair-required' | 'ready';
  localOnly: true;
}

export function verifiedTrainingModelToTrainableModel(
  model: VerifiedTrainingModel,
): TrainableModel {
  return {
    id: model.id,
    label: model.label,
    parametersB: model.parametersB,
    downloadGb: Number((model.downloadBytes / 1024 ** 3).toFixed(2)),
    ramGb: model.expectedRamGb,
    vramGb: model.expectedVramGb,
    quantization: model.precision,
    methods: ['lora', 'qlora', 'full'],
    local: true,
    quality: model.quality,
    speed: model.speed,
    modalities: model.modalities,
  };
}

export type TrainingRuntimeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

interface TrainingRuntimeOptions {
  native?: boolean;
  invoke?: TrainingRuntimeInvoke;
  includeQlora?: boolean;
  storageRoot?: string;
}

const WEIGHT_METHODS = new Set<WeightTrainingMethod>(['lora', 'qlora', 'full']);
const MODALITIES = new Set<TrainingModality>(['text', 'image', 'video', 'audio']);
const PRECISIONS = new Set<TrainingPrecision>(['fp32', 'fp16', 'bf16', 'int8', 'int4']);

const WEB_STATUS: LocalTrainingWorkerStatus = {
  installed: false,
  attested: false,
  localOnly: true,
  protocol: 1,
  sourceSha256: '',
  python: null,
  methods: [],
  modalities: [],
  precisions: [],
  reason: 'Local weight training is available only in the VibeSpace desktop app.',
  calibration: null,
};

function filterValues<T extends string>(values: readonly string[], allowed: Set<T>): T[] {
  return values.filter((value): value is T => allowed.has(value as T));
}

function normalizeCalibration(value: unknown): TrainingCalibrationEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const method = candidate.method;
  const computeDevice = candidate.computeDevice;
  const precision = candidate.precision;
  if (
    typeof candidate.qualified !== 'boolean' ||
    typeof candidate.modelId !== 'string' ||
    !WEIGHT_METHODS.has(method as WeightTrainingMethod) ||
    !['gpu', 'cpu'].includes(String(computeDevice)) ||
    !PRECISIONS.has(precision as TrainingPrecision) ||
    typeof candidate.device !== 'string' ||
    typeof candidate.forwardBackward !== 'boolean' ||
    typeof candidate.optimizerStep !== 'boolean' ||
    typeof candidate.batchSize !== 'number' ||
    typeof candidate.gradientAccumulation !== 'number' ||
    typeof candidate.maxSequenceLength !== 'number' ||
    typeof candidate.warmupSteps !== 'number' ||
    typeof candidate.measuredSteps !== 'number' ||
    typeof candidate.stepTimeMs !== 'number' ||
    typeof candidate.stepTimeMsP95 !== 'number' ||
    (candidate.peakVramMb !== null && typeof candidate.peakVramMb !== 'number') ||
    (candidate.vramTotalMb !== null && typeof candidate.vramTotalMb !== 'number') ||
    (candidate.vramHeadroomMb !== null && typeof candidate.vramHeadroomMb !== 'number') ||
    typeof candidate.elapsedMs !== 'number'
  ) {
    return null;
  }
  return {
    qualified: candidate.qualified,
    modelId: candidate.modelId,
    method: method as WeightTrainingMethod,
    computeDevice: computeDevice as 'gpu' | 'cpu',
    device: candidate.device,
    precision: precision as TrainingPrecision,
    forwardBackward: candidate.forwardBackward,
    optimizerStep: candidate.optimizerStep,
    batchSize: Math.max(1, Math.round(candidate.batchSize)),
    gradientAccumulation: Math.max(1, Math.round(candidate.gradientAccumulation)),
    maxSequenceLength: Math.max(1, Math.round(candidate.maxSequenceLength)),
    warmupSteps: Math.max(0, Math.round(candidate.warmupSteps)),
    measuredSteps: Math.max(0, Math.round(candidate.measuredSteps)),
    stepTimeMs: Math.max(0, Math.round(candidate.stepTimeMs)),
    stepTimeMsP95: Math.max(0, Math.round(candidate.stepTimeMsP95)),
    peakVramMb: candidate.peakVramMb as number | null,
    vramTotalMb: candidate.vramTotalMb as number | null,
    vramHeadroomMb: candidate.vramHeadroomMb as number | null,
    elapsedMs: Math.max(0, Math.round(candidate.elapsedMs)),
    reason: typeof candidate.reason === 'string' ? candidate.reason : null,
  };
}

function normalizeStatus(status: NativeTrainingWorkerStatus): LocalTrainingWorkerStatus {
  return {
    installed: status.installed === true,
    attested: status.attested === true,
    localOnly: true,
    protocol: Number.isFinite(status.protocol) ? status.protocol : 0,
    sourceSha256: typeof status.sourceSha256 === 'string' ? status.sourceSha256 : '',
    python: typeof status.python === 'string' ? status.python : null,
    methods: filterValues(Array.isArray(status.methods) ? status.methods : [], WEIGHT_METHODS),
    modalities: filterValues(Array.isArray(status.modalities) ? status.modalities : [], MODALITIES),
    precisions: filterValues(Array.isArray(status.precisions) ? status.precisions : [], PRECISIONS),
    reason: typeof status.reason === 'string' ? status.reason : null,
    calibration: normalizeCalibration(status.calibration),
  };
}

async function nativeInvoke(options: TrainingRuntimeOptions): Promise<TrainingRuntimeInvoke> {
  if (options.invoke) return options.invoke;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TrainingRuntimeInvoke;
}

const pendingInspections = new WeakMap<TrainingRuntimeInvoke, Promise<LocalTrainingWorkerStatus>>();

export async function getLocalTrainingWorkerStatus(
  options: TrainingRuntimeOptions = {},
): Promise<LocalTrainingWorkerStatus> {
  const native = options.native ?? isTauri;
  if (!native) return { ...WEB_STATUS };
  const invoke = await nativeInvoke(options);
  let pending = pendingInspections.get(invoke);
  if (!pending) {
    pending = invoke('model_foundry_training_worker_status')
      .then((status) => normalizeStatus(status as NativeTrainingWorkerStatus))
      .finally(() => pendingInspections.delete(invoke));
    pendingInspections.set(invoke, pending);
  }
  return pending;
}

export async function calibrateLocalTraining(
  modelId: string,
  configuration: FoundryTrainingConfiguration,
  options: TrainingRuntimeOptions = {},
): Promise<TrainingCalibrationEvidence> {
  const native = options.native ?? isTauri;
  const failure = (reason: string): TrainingCalibrationEvidence => ({
    qualified: false,
    modelId,
    method: configuration.method,
    computeDevice: configuration.computeDevice,
    device: 'unknown',
    precision: 'fp32',
    forwardBackward: false,
    optimizerStep: false,
    batchSize: configuration.batchSize,
    gradientAccumulation: configuration.gradientAccumulation,
    maxSequenceLength: configuration.maxSequenceLength,
    warmupSteps: 0,
    measuredSteps: 0,
    stepTimeMs: 0,
    stepTimeMsP95: 0,
    peakVramMb: null,
    vramTotalMb: null,
    vramHeadroomMb: null,
    elapsedMs: 0,
    reason,
  });
  if (!native)
    return failure('GPU/CPU calibration is available only in the VibeSpace desktop app.');
  const invoke = await nativeInvoke(options);
  try {
    const status = normalizeStatus(
      (await invoke('model_foundry_training_worker_status', {
        calibration: { modelId, trainingConfig: configuration },
      })) as NativeTrainingWorkerStatus,
    );
    return (
      status.calibration ??
      failure(status.reason ?? 'The native worker returned no calibration evidence.')
    );
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Training calibration failed.');
  }
}

export async function installLocalTrainingWorker(
  options: TrainingRuntimeOptions = {},
): Promise<LocalTrainingWorkerStatus> {
  const native = options.native ?? isTauri;
  if (!native) return { ...WEB_STATUS };
  const invoke = await nativeInvoke(options);
  return normalizeStatus(
    (await invoke('model_foundry_install_training_worker', {
      includeQlora: options.includeQlora === true,
      ...(options.storageRoot?.trim() ? { storageRoot: options.storageRoot.trim() } : {}),
    })) as NativeTrainingWorkerStatus,
  );
}

export async function listVerifiedTrainingModels(
  options: TrainingRuntimeOptions = {},
): Promise<VerifiedTrainingModel[]> {
  const native = options.native ?? isTauri;
  if (!native) return [];
  const invoke = await nativeInvoke(options);
  const response = await invoke('model_foundry_training_catalog');
  if (!Array.isArray(response)) {
    throw new Error('Verified training model catalog returned an invalid response.');
  }
  return response.map(normalizeVerifiedTrainingModel);
}

function normalizeVerifiedTrainingModel(entry: unknown): VerifiedTrainingModel {
  if (
    typeof entry !== 'object' ||
    entry === null ||
    !('id' in entry) ||
    typeof entry.id !== 'string' ||
    !('label' in entry) ||
    typeof entry.label !== 'string' ||
    !('sourceId' in entry) ||
    typeof entry.sourceId !== 'string' ||
    !('revision' in entry) ||
    typeof entry.revision !== 'string' ||
    !('license' in entry) ||
    entry.license !== 'apache-2.0' ||
    !('licenseUrl' in entry) ||
    typeof entry.licenseUrl !== 'string' ||
    !('gated' in entry) ||
    entry.gated !== false ||
    !('parametersB' in entry) ||
    typeof entry.parametersB !== 'number' ||
    !('downloadBytes' in entry) ||
    typeof entry.downloadBytes !== 'number' ||
    !('expectedRamGb' in entry) ||
    typeof entry.expectedRamGb !== 'number' ||
    !('expectedVramGb' in entry) ||
    typeof entry.expectedVramGb !== 'number' ||
    !('contextTokens' in entry) ||
    typeof entry.contextTokens !== 'number' ||
    !('precision' in entry) ||
    typeof entry.precision !== 'string' ||
    !('modalities' in entry) ||
    !Array.isArray(entry.modalities) ||
    entry.modalities.length === 0 ||
    filterValues(
      entry.modalities.filter((value): value is string => typeof value === 'string'),
      MODALITIES,
    ).length !== entry.modalities.length ||
    !('speed' in entry) ||
    !['fast', 'medium', 'slow'].includes(String(entry.speed)) ||
    !('quality' in entry) ||
    !['efficient', 'balanced', 'high'].includes(String(entry.quality)) ||
    !('cpuPractical' in entry) ||
    typeof entry.cpuPractical !== 'boolean' ||
    !('installed' in entry) ||
    typeof entry.installed !== 'boolean' ||
    !('verified' in entry) ||
    typeof entry.verified !== 'boolean' ||
    !('installedBytes' in entry) ||
    typeof entry.installedBytes !== 'number' ||
    !('status' in entry) ||
    !['not-installed', 'repair-required', 'ready'].includes(String(entry.status))
  ) {
    throw new Error('Verified training model catalog contains an invalid entry.');
  }
  return {
    id: entry.id,
    label: entry.label,
    sourceId: entry.sourceId,
    revision: entry.revision,
    license: entry.license,
    licenseUrl: entry.licenseUrl,
    gated: false,
    parametersB: entry.parametersB,
    downloadBytes: entry.downloadBytes,
    expectedRamGb: entry.expectedRamGb,
    expectedVramGb: entry.expectedVramGb,
    contextTokens: entry.contextTokens,
    precision: entry.precision,
    modalities: filterValues(entry.modalities as string[], MODALITIES),
    speed: String(entry.speed) as VerifiedTrainingModel['speed'],
    quality: String(entry.quality) as VerifiedTrainingModel['quality'],
    cpuPractical: entry.cpuPractical,
    installed: entry.installed,
    verified: entry.verified,
    installedBytes: entry.installedBytes,
    status: String(entry.status) as VerifiedTrainingModel['status'],
    localOnly: true,
  };
}

async function runTrainingModelCommand(
  command:
    | 'model_foundry_download_training_model'
    | 'model_foundry_repair_training_model'
    | 'model_foundry_remove_training_model',
  modelId: string,
  options: TrainingRuntimeOptions,
): Promise<VerifiedTrainingModel> {
  if (!(options.native ?? isTauri)) {
    throw new Error('Training model installation is available only in the VibeSpace desktop app.');
  }
  const invoke = await nativeInvoke(options);
  return normalizeVerifiedTrainingModel(
    await invoke(command, {
      modelId,
      ...(options.storageRoot?.trim() ? { storageRoot: options.storageRoot.trim() } : {}),
    }),
  );
}

export async function downloadVerifiedTrainingModel(
  modelId: string,
  options: TrainingRuntimeOptions = {},
): Promise<VerifiedTrainingModel> {
  return runTrainingModelCommand('model_foundry_download_training_model', modelId, options);
}

export async function repairVerifiedTrainingModel(
  modelId: string,
  options: TrainingRuntimeOptions = {},
): Promise<VerifiedTrainingModel> {
  return runTrainingModelCommand('model_foundry_repair_training_model', modelId, options);
}

export async function removeVerifiedTrainingModel(
  modelId: string,
  options: TrainingRuntimeOptions = {},
): Promise<VerifiedTrainingModel> {
  return runTrainingModelCommand('model_foundry_remove_training_model', modelId, options);
}

export async function cancelVerifiedTrainingModelDownload(
  options: TrainingRuntimeOptions = {},
): Promise<boolean> {
  if (!(options.native ?? isTauri)) return false;
  const invoke = await nativeInvoke(options);
  return (await invoke('model_foundry_cancel_training_model_download')) === true;
}

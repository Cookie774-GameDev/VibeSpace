import { isTauri } from '@/lib/utils';
import type {
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
  };
}

export type TrainingRuntimeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

interface TrainingRuntimeOptions {
  native?: boolean;
  invoke?: TrainingRuntimeInvoke;
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
};

function filterValues<T extends string>(values: readonly string[], allowed: Set<T>): T[] {
  return values.filter((value): value is T => allowed.has(value as T));
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
  };
}

async function nativeInvoke(options: TrainingRuntimeOptions): Promise<TrainingRuntimeInvoke> {
  if (options.invoke) return options.invoke;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TrainingRuntimeInvoke;
}

export async function getLocalTrainingWorkerStatus(
  options: TrainingRuntimeOptions = {},
): Promise<LocalTrainingWorkerStatus> {
  const native = options.native ?? isTauri;
  if (!native) return { ...WEB_STATUS };
  const invoke = await nativeInvoke(options);
  return normalizeStatus(
    (await invoke('model_foundry_training_worker_status')) as NativeTrainingWorkerStatus,
  );
}

export async function installLocalTrainingWorker(
  options: TrainingRuntimeOptions = {},
): Promise<LocalTrainingWorkerStatus> {
  const native = options.native ?? isTauri;
  if (!native) return { ...WEB_STATUS };
  const invoke = await nativeInvoke(options);
  return normalizeStatus(
    (await invoke('model_foundry_install_training_worker')) as NativeTrainingWorkerStatus,
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
  return normalizeVerifiedTrainingModel(await invoke(command, { modelId }));
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

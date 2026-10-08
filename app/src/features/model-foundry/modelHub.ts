import trainingModelCatalog from '../../../src-tauri/workers/model_foundry/training-models.json';

export type TrainingMethod = 'knowledge' | 'lora' | 'qlora' | 'full';

/** Current native worker safety ceiling; a catalogue bound, never a prompt-fit proof. */
export const FOUNDRY_NATIVE_CONTEXT_CEILING = 16_384;
export interface FoundryContextMetadata {
  contextWindowTokens: number;
  contextMetadataSource: 'foundry_catalog_ceiling';
}

export function foundryNativeContextCeiling(declared: unknown): number | undefined {
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 2
    ? Math.min(declared, FOUNDRY_NATIVE_CONTEXT_CEILING)
    : undefined;
}

function foundryCatalogueContext(baseModelId: unknown): FoundryContextMetadata | undefined {
  if (typeof baseModelId !== 'string') return undefined;
  const declared = trainingModelCatalog.models.find((model) => model.id === baseModelId)?.contextTokens;
  const ceiling = foundryNativeContextCeiling(declared);
  return ceiling === undefined ? undefined : {
    contextWindowTokens: ceiling, contextMetadataSource: 'foundry_catalog_ceiling',
  };
}

export type SourceUse = 'retrieval' | 'fine_tuning' | 'multimodal' | 'evaluation' | 'unsupported';

export interface HardwareProfile {
  cpu: string;
  gpu: string | null;
  ramGb: number;
  vramGb: number;
  freeStorageGb: number;
  os: string;
  accelerators: string[];
  storageRoot?: string;
  recommendedStorageRoot?: string | null;
}

export type TrainingModality = 'text' | 'image' | 'video' | 'audio';
export type TrainingPrecision = 'fp32' | 'fp16' | 'bf16' | 'int8' | 'int4';
export type TrainingComputeDevice = 'gpu' | 'cpu';

export interface FoundryTrainingConfiguration {
  method: Exclude<TrainingMethod, 'knowledge'>;
  computeDevice: TrainingComputeDevice;
  seed: number;
  epochs: number;
  maxSteps?: number;
  batchSize: number;
  gradientAccumulation: number;
  maxSequenceLength: number;
  learningRate: number;
  loraRank: number;
  loraAlpha: number;
  loraDropout: number;
}

export type TrainingComputePresetId = 'low-memory' | 'balanced' | 'faster';

export interface TrainingComputePreset {
  id: TrainingComputePresetId;
  label: string;
  summary: string;
  batchSize: number;
  gradientAccumulation: number;
  maxSequenceLength: number;
}

export interface TrainingDatasetMeasurement {
  examples: number;
  textTokens: number;
  mediaExamples: number;
  imageExamples: number;
  videoExamples: number;
  plannedVideoFrames: number;
  totalBytes: number;
  measured: boolean;
}

export function emptyTrainingMeasurement(): TrainingDatasetMeasurement {
  return {
    examples: 0,
    textTokens: 0,
    mediaExamples: 0,
    imageExamples: 0,
    videoExamples: 0,
    plannedVideoFrames: 0,
    totalBytes: 0,
    measured: false,
  };
}

export function measureTrainingJsonl(content: string): TrainingDatasetMeasurement {
  const measurement = emptyTrainingMeasurement();
  measurement.totalBytes = new TextEncoder().encode(content).byteLength;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    const completionValue = record.completion ?? record.response;
    const completion = typeof completionValue === 'string' ? completionValue.trim() : '';
    if (!prompt || !completion) continue;
    const mediaType = record.mediaType;
    const isImage = mediaType === 'image';
    const isVideo = mediaType === 'video';
    const plannedFrames =
      isVideo && Number.isSafeInteger(record.plannedFrames)
        ? Math.max(1, Math.min(32, Number(record.plannedFrames)))
        : 0;
    measurement.examples += 1;
    measurement.textTokens += Math.max(1, Math.ceil((prompt.length + completion.length) / 4));
    measurement.imageExamples += isImage ? 1 : 0;
    measurement.videoExamples += isVideo ? 1 : 0;
    measurement.mediaExamples += isImage || isVideo ? 1 : 0;
    measurement.plannedVideoFrames += plannedFrames;
  }
  measurement.measured = measurement.examples > 0;
  return measurement;
}

export function measureTrainingText(content: string): TrainingDatasetMeasurement {
  const measurement = emptyTrainingMeasurement();
  const normalized = content.trim();
  measurement.totalBytes = new TextEncoder().encode(content).byteLength;
  if (!normalized) return measurement;
  measurement.examples = Math.max(1, Math.ceil(normalized.length / 6_000));
  measurement.textTokens = Math.max(1, Math.ceil(normalized.length / 4));
  measurement.measured = true;
  return measurement;
}

export const TRAINING_COMPUTE_PRESETS: readonly TrainingComputePreset[] = [
  {
    id: 'low-memory',
    label: 'Low memory',
    summary: 'Small batches and shorter context. Uses less peak memory and usually takes longer.',
    batchSize: 1,
    gradientAccumulation: 8,
    maxSequenceLength: 1_024,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    summary: 'A conservative everyday profile for supported local GPUs.',
    batchSize: 1,
    gradientAccumulation: 4,
    maxSequenceLength: 2_048,
  },
  {
    id: 'faster',
    label: 'Faster',
    summary: 'Larger batches for machines with verified memory headroom.',
    batchSize: 2,
    gradientAccumulation: 2,
    maxSequenceLength: 2_048,
  },
] as const;

export function defaultFoundryTrainingConfiguration(
  method: Exclude<TrainingMethod, 'knowledge'>,
): FoundryTrainingConfiguration {
  return {
    method,
    computeDevice: 'gpu',
    seed: 7,
    epochs: 1,
    batchSize: 1,
    gradientAccumulation: 8,
    maxSequenceLength: 1_024,
    learningRate: method === 'full' ? 0.000_02 : 0.000_2,
    loraRank: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
  };
}

export function applyTrainingComputePreset(
  method: Exclude<TrainingMethod, 'knowledge'>,
  presetId: TrainingComputePresetId,
  current: FoundryTrainingConfiguration = defaultFoundryTrainingConfiguration(method),
): FoundryTrainingConfiguration {
  const preset = TRAINING_COMPUTE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return { ...current, method };
  return {
    ...current,
    method,
    batchSize: preset.batchSize,
    gradientAccumulation: preset.gradientAccumulation,
    maxSequenceLength: preset.maxSequenceLength,
  };
}

export interface FoundryTrainingDurationEstimate {
  minimumHours: number;
  maximumHours: number;
  optimizationSteps: number;
  basis: string;
  disclaimer: string;
}

function roundedHours(seconds: number): number {
  return Math.max(0.1, Math.round((seconds / 3_600) * 10) / 10);
}

export function estimateFoundryTrainingDuration(input: {
  method: Exclude<TrainingMethod, 'knowledge'>;
  parametersB: number;
  configuration: FoundryTrainingConfiguration;
  hardware: HardwareProfile;
  measurement: TrainingDatasetMeasurement;
}): FoundryTrainingDurationEstimate {
  const examples = Math.max(1, Math.floor(input.measurement.examples || 1));
  const measuredTextTokens = Math.max(input.measurement.textTokens, examples * 24);
  const visualTokens =
    input.measurement.imageExamples * 512 + input.measurement.plannedVideoFrames * 512;
  const tokensPerEpoch = Math.max(64, measuredTextTokens + visualTokens);
  const effectiveBatch = Math.max(
    1,
    input.configuration.batchSize * input.configuration.gradientAccumulation,
  );
  const epochSteps = Math.ceil((examples * input.configuration.epochs) / effectiveBatch);
  const optimizationSteps = Math.max(
    1,
    Math.min(input.configuration.maxSteps ?? epochSteps, epochSteps),
  );
  const averageTokensPerExample = tokensPerEpoch / examples;
  const processedTokens = optimizationSteps * effectiveBatch * averageTokensPerExample;
  const parametersB = Math.max(0.1, input.parametersB);
  const methodCost = input.method === 'full' ? 3.5 : input.method === 'qlora' ? 1.15 : 1;
  const useGpu = input.configuration.computeDevice === 'gpu';
  const acceleratorCapacity = useGpu ? Math.max(1, input.hardware.vramGb / 4) : 0;
  const tokenRate =
    acceleratorCapacity > 0
      ? (1_250 * acceleratorCapacity) / (parametersB * methodCost)
      : (45 * Math.max(1, input.hardware.ramGb / 8)) / (parametersB * methodCost);
  const matchingPreset = TRAINING_COMPUTE_PRESETS.find(
    (preset) =>
      preset.batchSize === input.configuration.batchSize &&
      preset.gradientAccumulation === input.configuration.gradientAccumulation &&
      preset.maxSequenceLength === input.configuration.maxSequenceLength,
  )?.id;
  const computeMultiplier =
    matchingPreset === 'low-memory'
      ? 1.8
      : matchingPreset === 'faster'
        ? 0.72
        : matchingPreset === 'balanced'
          ? 1
          : Math.max(
              0.45,
              Math.min(
                4,
                Math.sqrt(input.configuration.gradientAccumulation / 4) /
                  Math.sqrt(input.configuration.batchSize),
              ),
            );
  const startupSeconds = parametersB * methodCost * (acceleratorCapacity > 0 ? 420 : 1_800);
  const centralSeconds =
    (startupSeconds + processedTokens / Math.max(1, tokenRate)) * computeMultiplier;
  const visualBasis =
    input.measurement.mediaExamples > 0
      ? `, ${input.measurement.imageExamples} images and ${input.measurement.plannedVideoFrames} planned video frames`
      : '';
  return {
    minimumHours: roundedHours(centralSeconds * 0.75),
    maximumHours: Math.max(
      roundedHours(centralSeconds * 0.75) + 0.1,
      roundedHours(centralSeconds * 1.8),
    ),
    optimizationSteps,
    basis: `${examples} measured example${examples === 1 ? '' : 's'}, ${measuredTextTokens.toLocaleString()} measured text tokens${visualBasis}, ${optimizationSteps.toLocaleString()} optimization steps, and the selected ${useGpu ? 'GPU' : 'CPU'}.`,
    disclaimer:
      'Planning estimate from the selected data and settings. It becomes calibrated only after a verified training telemetry receipt; cooling, drivers, and other computer activity can still change the result.',
  };
}

export function validateFoundryTrainingConfiguration(
  configuration: FoundryTrainingConfiguration,
): string | null {
  if (configuration.computeDevice !== 'gpu' && configuration.computeDevice !== 'cpu') {
    return 'Training device must be GPU only or CPU only.';
  }
  if (configuration.method === 'qlora' && configuration.computeDevice !== 'gpu') {
    return 'QLoRA requires GPU-only training.';
  }
  const integerBounds: ReadonlyArray<[keyof FoundryTrainingConfiguration, string, number, number]> =
    [
      ['seed', 'Seed', 0, 0xffff_ffff],
      ['epochs', 'Epochs', 1, 20],
      ['batchSize', 'Batch size', 1, 128],
      ['gradientAccumulation', 'Gradient accumulation', 1, 1_024],
      ['maxSequenceLength', 'Sequence length', 64, 131_072],
      ['loraRank', 'LoRA rank', 1, 512],
      ['loraAlpha', 'LoRA alpha', 1, 1_024],
    ];
  for (const [key, label, minimum, maximum] of integerBounds) {
    const value = configuration[key];
    if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
      return `${label} must be a whole number from ${minimum} to ${maximum}.`;
    }
  }
  if (
    configuration.maxSteps !== undefined &&
    (!Number.isInteger(configuration.maxSteps) ||
      configuration.maxSteps < 1 ||
      configuration.maxSteps > 1_000_000)
  ) {
    return 'Maximum steps must be blank or a whole number from 1 to 1,000,000.';
  }
  if (
    !Number.isFinite(configuration.learningRate) ||
    configuration.learningRate < 0.000_000_01 ||
    configuration.learningRate > 1
  ) {
    return 'Learning rate must be from 0.00000001 to 1.';
  }
  if (
    !Number.isFinite(configuration.loraDropout) ||
    configuration.loraDropout < 0 ||
    configuration.loraDropout >= 1
  ) {
    return 'LoRA dropout must be from 0 up to (but not including) 1.';
  }
  return null;
}

export interface TrainingWorkerCapability {
  installed: boolean;
  attested: boolean;
  version: string;
  methods: readonly Exclude<TrainingMethod, 'knowledge'>[];
  modalities: readonly TrainingModality[];
  precisions: readonly TrainingPrecision[];
}

export interface LocalTrainingPlan {
  method: TrainingMethod;
  available: boolean;
  localOnly: true;
  reason: string | null;
  fallbackMethod: null;
  requiredVramGb: number;
  requiredRamGb: number;
  requiredStorageGb: number;
  workload: 'light' | 'moderate' | 'heavy';
}

function roundedRequirement(value: number): number {
  return Math.max(1, Math.ceil(value));
}

const MEMORY_REPORTING_TOLERANCE_GB = 0.01;

function reportedMemoryMeets(availableGb: number, requiredGb: number): boolean {
  return availableGb + MEMORY_REPORTING_TOLERANCE_GB >= requiredGb;
}

export function planLocalTrainingMethod(input: {
  method: TrainingMethod;
  parametersB: number;
  hardware: HardwareProfile;
  worker: TrainingWorkerCapability | null;
  computeDevice?: TrainingComputeDevice;
}): LocalTrainingPlan {
  const parametersB = Math.max(0.1, Number.isFinite(input.parametersB) ? input.parametersB : 0.1);
  const requirements =
    input.method === 'knowledge'
      ? { vram: 0, ram: 4, storage: 2, workload: 'light' as const }
      : input.method === 'qlora'
        ? {
            vram: Math.max(2, parametersB * 4),
            ram: Math.max(4, parametersB * 12),
            storage: Math.max(2, parametersB * 8),
            workload: 'moderate' as const,
          }
        : input.method === 'lora'
          ? {
              vram: Math.max(2, parametersB * 8),
              ram: Math.max(4, parametersB * 16),
              storage: Math.max(2, parametersB * 12),
              workload: 'moderate' as const,
            }
          : {
              vram: Math.max(4, parametersB * 16),
              ram: Math.max(8, parametersB * 32),
              storage: Math.max(4, parametersB * 40),
              workload: 'heavy' as const,
            };
  const requiredVramGb = roundedRequirement(requirements.vram);
  const requiredRamGb = roundedRequirement(requirements.ram);
  const requiredStorageGb = roundedRequirement(requirements.storage);
  const base: Omit<LocalTrainingPlan, 'available' | 'reason'> = {
    method: input.method,
    localOnly: true,
    fallbackMethod: null,
    requiredVramGb,
    requiredRamGb,
    requiredStorageGb,
    workload: requirements.workload,
  };

  if (
    [input.hardware.ramGb, input.hardware.vramGb, input.hardware.freeStorageGb].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  ) {
    return {
      ...base,
      available: false,
      reason:
        'Hardware capacity could not be verified. Refresh hardware detection before training.',
    };
  }

  if (input.method !== 'knowledge') {
    if (!input.worker?.installed) {
      return {
        ...base,
        available: false,
        reason: 'The verified local training worker is not installed.',
      };
    }
    if (!input.worker.attested) {
      return {
        ...base,
        available: false,
        reason: 'The installed local training worker is not verified or attested.',
      };
    }
    if (!input.worker.methods.includes(input.method)) {
      return {
        ...base,
        available: false,
        reason: `The verified worker does not support ${input.method.toUpperCase()} training.`,
      };
    }
  }

  if (input.hardware.freeStorageGb < requiredStorageGb) {
    return {
      ...base,
      available: false,
      reason: `Requires about ${requiredStorageGb} GB free storage; ${Math.max(0, input.hardware.freeStorageGb)} GB is available.`,
    };
  }

  if (input.method === 'qlora' && !reportedMemoryMeets(input.hardware.vramGb, requiredVramGb)) {
    return {
      ...base,
      available: false,
      reason: `QLoRA requires about ${requiredVramGb} GB verified CUDA VRAM; ${Math.max(0, input.hardware.vramGb).toFixed(1)} GB is available.`,
    };
  }

  const memoryFits =
    input.method === 'knowledge'
      ? reportedMemoryMeets(input.hardware.ramGb, requiredRamGb)
      : input.computeDevice === 'gpu'
        ? reportedMemoryMeets(input.hardware.vramGb, requiredVramGb)
        : input.computeDevice === 'cpu'
          ? reportedMemoryMeets(input.hardware.ramGb, requiredRamGb)
          : reportedMemoryMeets(input.hardware.vramGb, requiredVramGb) ||
            reportedMemoryMeets(input.hardware.ramGb, requiredRamGb);
  if (!memoryFits) {
    return {
      ...base,
      available: false,
      reason:
        input.computeDevice === 'gpu'
          ? `GPU-only training requires about ${requiredVramGb} GB verified CUDA VRAM for this model.`
          : input.computeDevice === 'cpu'
            ? `CPU-only training requires about ${requiredRamGb} GB system RAM for this model.`
            : `Requires about ${requiredVramGb} GB VRAM or ${requiredRamGb} GB system RAM for this model.`,
    };
  }

  return { ...base, available: true, reason: null };
}

export interface TrainableModel {
  id: string;
  label: string;
  parametersB: number;
  downloadGb: number;
  ramGb: number;
  vramGb: number;
  quantization: string;
  methods: TrainingMethod[];
  local: true;
  quality: 'efficient' | 'balanced' | 'high';
  speed: 'fast' | 'medium' | 'slow';
  modalities?: readonly TrainingModality[];
}

export function modelFoundryMethodAvailability(
  method: TrainingMethod,
  worker: TrainingWorkerCapability | null = null,
): {
  available: boolean;
  reason: string | null;
} {
  if (method === 'knowledge') return { available: true, reason: null };
  if (!worker?.installed) {
    return { available: false, reason: 'The verified local training worker is not installed.' };
  }
  if (!worker.attested) {
    return {
      available: false,
      reason: 'The installed local training worker is not verified or attested.',
    };
  }
  if (!worker.methods.includes(method)) {
    return {
      available: false,
      reason: `The verified worker does not support ${method.toUpperCase()} training.`,
    };
  }
  return { available: true, reason: null };
}

export interface ClassifiedSource {
  name: string;
  path?: string;
  kind: 'document' | 'code' | 'image' | 'audio' | 'video' | 'dataset';
  use: SourceUse;
  explanation: string;
  supervisedPrompt?: string;
  expectedAnswer?: string;
  plannedFrames?: number;
  measuredJsonl?: TrainingDatasetMeasurement;
}

export interface FoundryJob {
  id: string;
  name: string;
  baseModelId: string;
  method: TrainingMethod;
  status:
    | 'queued'
    | 'validating'
    | 'preparing'
    | 'training'
    | 'evaluating'
    | 'packaging'
    | 'completed'
    | 'failed'
    | 'cancelled';
  progress: number;
  artifactPath?: string;
  artifactVerified?: boolean;
  artifactSha256?: string;
  storageBytes?: number;
  sourceCount?: number;
  version?: number;
  resumeAvailable?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export const TRAINABLE_MODELS: readonly TrainableModel[] = [
  {
    id: 'qwen2.5:1.5b-instruct-q4_K_M',
    label: 'Qwen 2.5 1.5B Instruct',
    parametersB: 1.5,
    downloadGb: 1.2,
    ramGb: 6,
    vramGb: 4,
    quantization: 'Q4_K_M (4-bit inference)',
    methods: ['knowledge'],
    local: true,
    quality: 'efficient',
    speed: 'fast',
    modalities: ['text'],
  },
  {
    id: 'qwen2.5:7b-instruct-q4_K_M',
    label: 'Qwen 2.5 7B Instruct',
    parametersB: 7,
    downloadGb: 4.7,
    ramGb: 16,
    vramGb: 8,
    quantization: 'Q4_K_M (4-bit inference)',
    methods: ['knowledge'],
    local: true,
    quality: 'balanced',
    speed: 'medium',
    modalities: ['text'],
  },
  {
    id: 'llama3.1:8b-instruct-q4_K_M',
    label: 'Llama 3.1 8B Instruct',
    parametersB: 8,
    downloadGb: 5.2,
    ramGb: 20,
    vramGb: 10,
    quantization: 'Q4_K_M (4-bit inference)',
    methods: ['knowledge'],
    local: true,
    quality: 'high',
    speed: 'medium',
    modalities: ['text'],
  },
] as const;

export function compatibleModels(
  profile: HardwareProfile,
  models: readonly TrainableModel[] = TRAINABLE_MODELS,
): Array<{
  model: TrainableModel;
  compatible: boolean;
  recommended: boolean;
  warning: string | null;
}> {
  const assessed = models.map((model) => {
    const storageOk = profile.freeStorageGb >= model.downloadGb * 2.2;
    const memoryOk = profile.vramGb >= model.vramGb || profile.ramGb >= model.ramGb;
    const compatible = storageOk && memoryOk;
    return {
      model,
      compatible,
      recommended: false,
      warning: !storageOk
        ? `Requires about ${Math.ceil(model.downloadGb * 2.2)} GB free for download, checkpoints, and packaging.`
        : !memoryOk
          ? `Requires about ${model.vramGb} GB VRAM or ${model.ramGb} GB system RAM.`
          : null,
    };
  });
  const best = [...assessed]
    .filter((item) => item.compatible)
    .sort((a, b) => b.model.parametersB - a.model.parametersB)[0];
  if (best) best.recommended = true;
  return assessed;
}

const extensions: Record<string, ClassifiedSource['kind']> = {
  pdf: 'document',
  txt: 'document',
  md: 'document',
  docx: 'document',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  py: 'code',
  rs: 'code',
  json: 'dataset',
  jsonl: 'dataset',
  csv: 'dataset',
  parquet: 'dataset',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
};

export function classifySource(
  name: string,
  method: TrainingMethod,
  modalities: readonly TrainingModality[],
  path?: string,
  processors: { transcriptionReady?: boolean } = {},
): ClassifiedSource {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const kind = extensions[ext];
  if (!kind) {
    return {
      name,
      path,
      kind: 'document',
      use: 'unsupported',
      explanation: 'Unsupported file type. It will not be uploaded or processed.',
    };
  }
  const hasVerifiedTextExtractor = [
    'txt',
    'md',
    'json',
    'jsonl',
    'csv',
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'rs',
    'pdf',
    'docx',
  ].includes(ext);
  const hasVerifiedTranscription =
    method === 'knowledge' &&
    processors.transcriptionReady === true &&
    (kind === 'audio' || kind === 'video');
  const hasVerifiedMultimodalTraining =
    method !== 'knowledge' &&
    ((kind === 'image' && modalities.includes('image')) ||
      (kind === 'video' && modalities.includes('video')));
  if (!hasVerifiedTextExtractor && !hasVerifiedTranscription && !hasVerifiedMultimodalTraining) {
    const explanation =
      kind === 'document'
        ? 'A verified local document extractor for this format is not installed. Convert it to TXT or Markdown; it will not be processed or uploaded as-is.'
        : kind === 'audio'
          ? 'A verified local transcription backend is not installed for Model Foundry. The recording will not be processed or uploaded.'
          : kind === 'video'
            ? 'Verified local video transcription and frame-caption extraction are not installed. The video will not be processed or uploaded.'
            : kind === 'image'
              ? modalities.includes('image')
                ? 'The verified local multimodal worker is unavailable. The image will not be processed or uploaded.'
                : 'The selected base model cannot use images. Choose a model marked Image + Video.'
              : 'A verified local structured-data extractor for this format is not installed. The file will not be processed or uploaded.';
    return {
      name,
      path,
      kind,
      use: 'unsupported',
      explanation,
    };
  }
  if (hasVerifiedMultimodalTraining) {
    return {
      name,
      path,
      kind,
      use: 'fine_tuning',
      explanation:
        kind === 'video'
          ? 'Video frames will be sampled locally and used only with the supervised question and expected answer you review.'
          : 'The image will be decoded locally and used only with the supervised question and expected answer you review.',
      plannedFrames: kind === 'video' ? 8 : undefined,
    };
  }
  if (kind === 'audio' || kind === 'video') {
    return {
      name,
      path,
      kind,
      use: 'retrieval',
      explanation:
        kind === 'audio'
          ? 'The installed verified local speech model will transcribe this recording into reviewed retrieval text. The original stays unchanged.'
          : 'Only the audio track will be transcribed into retrieval text. Video frames are not understood or used by this text model.',
    };
  }
  if (kind === 'dataset') {
    return {
      name,
      path,
      kind,
      use: method === 'knowledge' ? 'retrieval' : 'fine_tuning',
      explanation:
        method === 'knowledge'
          ? 'Validated and indexed as retrieval knowledge.'
          : 'Validated as structured examples, deduplicated, and split before training.',
    };
  }
  if (method !== 'knowledge') {
    return {
      name,
      path,
      kind,
      use: 'fine_tuning',
      explanation:
        'Extracted locally as text-continuation training data. For instruction behavior, reviewed prompt/answer JSONL remains the higher-quality choice.',
    };
  }
  return {
    name,
    path,
    kind,
    use: method === 'knowledge' ? 'retrieval' : 'fine_tuning',
    explanation:
      method === 'knowledge'
        ? 'Extracted, cleaned, deduplicated, and indexed locally.'
        : 'Extracted and converted into reviewed training examples locally.',
  };
}

export function mayStartTraining(input: {
  name: string;
  model: TrainableModel;
  method: TrainingMethod;
  hardware: HardwareProfile;
  sources: ClassifiedSource[];
  worker?: TrainingWorkerCapability | null;
  configuration?: FoundryTrainingConfiguration;
}): string | null {
  if (!input.name.trim()) return 'Name the model before training.';
  const methodAvailability = modelFoundryMethodAvailability(input.method, input.worker ?? null);
  if (!methodAvailability.available) return methodAvailability.reason;
  if (!input.model.methods.includes(input.method))
    return 'The selected base model does not support this training method.';
  if (input.method !== 'knowledge') {
    const plan = planLocalTrainingMethod({
      method: input.method,
      parametersB: input.model.parametersB,
      hardware: input.hardware,
      worker: input.worker ?? null,
      computeDevice: input.configuration?.computeDevice,
    });
    if (!plan.available) return plan.reason;
  }
  const compatibility = compatibleModels(input.hardware, [input.model]).find(
    (item) => item.model.id === input.model.id,
  );
  if (!compatibility?.compatible)
    return compatibility?.warning ?? 'The selected model is not compatible.';
  if (!input.sources.some((source) => source.use !== 'unsupported'))
    return 'Attach at least one supported source or dataset.';
  const pathlessSource = input.sources.find(
    (source) => source.use !== 'unsupported' && !source.path?.trim(),
  );
  if (pathlessSource)
    return `Add ${pathlessSource.name} again with the native picker or drop it into the source area so VibeSpace receives its private local path.`;
  const incompleteMedia = input.sources.find(
    (source) =>
      source.use !== 'unsupported' &&
      (source.kind === 'image' || source.kind === 'video') &&
      (!source.supervisedPrompt?.trim() || !source.expectedAnswer?.trim()),
  );
  if (incompleteMedia)
    return `Add a training question and expected answer for ${incompleteMedia.name}.`;
  if (input.method !== 'knowledge') {
    const usable = input.sources.filter((source) => source.use !== 'unsupported');
    const media = usable.filter((source) => source.kind === 'image' || source.kind === 'video');
    const measuredExamples = usable.reduce(
      (total, source) => total + (source.measuredJsonl?.examples ?? 0),
      0,
    );
    if (media.length > 0 && measuredExamples === 0 && media.length < 2)
      return 'Add at least two labeled media examples so validation remains separate.';
    if (media.length === 0 && measuredExamples > 0 && measuredExamples < 2)
      return 'Weight training needs at least two reviewed examples so validation remains separate.';
  }
  return null;
}

const JOB_KEY = 'vibespace.model-foundry.jobs.v2';

export function loadJobs(storage: Pick<Storage, 'getItem'>): FoundryJob[] {
  try {
    const parsed = JSON.parse(storage.getItem(JOB_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is FoundryJob =>
      Boolean(
        item &&
        typeof item === 'object' &&
        typeof (item as FoundryJob).id === 'string' &&
        typeof (item as FoundryJob).status === 'string',
      ),
    );
  } catch {
    return [];
  }
}

export function saveJobs(storage: Pick<Storage, 'setItem'>, jobs: FoundryJob[]): void {
  storage.setItem(JOB_KEY, JSON.stringify(jobs.slice(0, 50)));
}

const NATIVE_ARTIFACT_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function nativeArtifactModelId(jobId: string): string {
  if (!NATIVE_ARTIFACT_JOB_ID.test(jobId)) {
    throw new Error('The verified native artifact has an invalid identity.');
  }
  return `artifact--${jobId}`;
}

export function foundryAgentModelSelection(job: FoundryJob): {
  readonly providerChoice: 'foundry';
  readonly provider: 'foundry';
  readonly model: string;
} {
  if (job.status !== 'completed' || job.artifactVerified !== true || !job.artifactPath) {
    throw new Error('Only a verified completed native artifact can be selected.');
  }
  return {
    providerChoice: 'foundry',
    provider: 'foundry',
    model: nativeArtifactModelId(job.id),
  };
}

export function foundryModelOptions(jobs: unknown): Array<{
  id: string;
  label: string;
  subtitle: string;
  method: TrainingMethod;
  contextWindowTokens?: number;
  contextMetadataSource?: 'foundry_catalog_ceiling';
}> {
  if (!Array.isArray(jobs)) return [];
  return (jobs as FoundryJob[])
    .filter(
      (job) =>
        job &&
        job.status === 'completed' &&
        job.artifactVerified === true &&
        Boolean(job.artifactPath) &&
        typeof job.name === 'string' &&
        Boolean(job.name.trim()) &&
        ['knowledge', 'lora', 'qlora', 'full'].includes(job.method),
    )
    .filter((job) => NATIVE_ARTIFACT_JOB_ID.test(job.id))
    .map((job) => {
      const baseModel = TRAINABLE_MODELS.find((candidate) => candidate.id === job.baseModelId);
      const artifactKind =
        job.method === 'knowledge'
          ? 'knowledge'
          : `${job.method === 'lora' ? 'LoRA' : job.method === 'qlora' ? 'QLoRA' : 'full-weight'} model`;
      return {
        id: nativeArtifactModelId(job.id),
        label: job.name,
        method: job.method,
        ...(job.method === 'knowledge' ? {} : foundryCatalogueContext(job.baseModelId)),
        subtitle: `Verified local ${artifactKind} · ${baseModel?.label ?? job.baseModelId}`,
      };
    });
}

export function isModelInstalled(modelId: string, installedModelIds: readonly string[]): boolean {
  const expected = modelId.trim().toLowerCase();
  return installedModelIds.some((candidate) => candidate.trim().toLowerCase() === expected);
}

export function newlyCompletedJobId(
  previous: readonly FoundryJob[],
  current: readonly FoundryJob[],
): string | null {
  const alreadyCompleted = new Set(
    previous
      .filter(
        (job) =>
          job.status === 'completed' && job.artifactVerified === true && Boolean(job.artifactPath),
      )
      .map((job) => job.id),
  );
  return (
    current.find(
      (job) =>
        job.status === 'completed' &&
        job.artifactVerified === true &&
        Boolean(job.artifactPath) &&
        !alreadyCompleted.has(job.id),
    )?.id ?? null
  );
}

export function formatFoundryStorageBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'Not measured';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

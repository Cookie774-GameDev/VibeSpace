import type { TrainingModality } from './modelHub';

export type PreparedSourceKind =
  | 'document'
  | 'dataset'
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'code';

export type PreparationStrategy =
  | 'native_multimodal'
  | 'extract_to_text'
  | 'structured_examples'
  | 'plain_text';

export interface MediaWorkerCapability {
  attested: boolean;
  imagePreparation: boolean;
  ffmpeg: boolean;
  transcription: boolean;
  documentExtraction: boolean;
  nativeModalities: readonly Exclude<TrainingModality, 'text'>[];
}

export interface MediaSourceDescriptor {
  name: string;
  sizeBytes: number;
  durationSeconds?: number;
}

export interface MediaPreparationPlan {
  status: 'ready' | 'blocked';
  kind: PreparedSourceKind;
  strategy: PreparationStrategy | null;
  operations: readonly string[];
  reason: string | null;
  localOnly: true;
  preservesOriginal: true;
  limits: {
    maxSourceBytes: number;
    maxDurationSeconds: number;
    maxFrames: number;
  };
}

const GIB = 1024 ** 3;
const MAX_SOURCE_BYTES = 8 * GIB;
const MAX_DURATION_SECONDS = 6 * 60 * 60;

const KIND_BY_EXTENSION: Readonly<Record<string, PreparedSourceKind>> = Object.freeze({
  txt: 'text',
  md: 'text',
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
  pdf: 'document',
  docx: 'document',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  wav: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  flac: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
});

function limitsFor(source: MediaSourceDescriptor): MediaPreparationPlan['limits'] {
  const duration = Math.max(0, source.durationSeconds ?? 0);
  return {
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxDurationSeconds: MAX_DURATION_SECONDS,
    maxFrames: Math.min(512, Math.max(8, Math.ceil(duration / 2))),
  };
}

function blocked(
  kind: PreparedSourceKind,
  source: MediaSourceDescriptor,
  reason: string,
): MediaPreparationPlan {
  return {
    status: 'blocked',
    kind,
    strategy: null,
    operations: [],
    reason,
    localOnly: true,
    preservesOriginal: true,
    limits: limitsFor(source),
  };
}

function ready(
  kind: PreparedSourceKind,
  strategy: PreparationStrategy,
  source: MediaSourceDescriptor,
  operations: readonly string[],
): MediaPreparationPlan {
  return {
    status: 'ready',
    kind,
    strategy,
    operations,
    reason: null,
    localOnly: true,
    preservesOriginal: true,
    limits: limitsFor(source),
  };
}

function requiresAttestedWorker(
  kind: PreparedSourceKind,
  source: MediaSourceDescriptor,
  worker: MediaWorkerCapability | null,
): MediaPreparationPlan | null {
  if (!worker?.attested) {
    return blocked(
      kind,
      source,
      'A verified and attested local media worker is required. Nothing was processed or uploaded.',
    );
  }
  return null;
}

export function planMediaPreparation(input: {
  source: MediaSourceDescriptor;
  requestedModality: TrainingModality;
  worker: MediaWorkerCapability | null;
}): MediaPreparationPlan {
  const extension = input.source.name.split('.').pop()?.trim().toLowerCase() ?? '';
  const kind = KIND_BY_EXTENSION[extension] ?? 'document';
  if (!KIND_BY_EXTENSION[extension]) {
    return blocked(kind, input.source, 'This source type is not supported.');
  }
  if (!Number.isFinite(input.source.sizeBytes) || input.source.sizeBytes <= 0) {
    return blocked(kind, input.source, 'The source size is missing or invalid.');
  }
  if (input.source.sizeBytes > MAX_SOURCE_BYTES) {
    return blocked(
      kind,
      input.source,
      `The source exceeds the local 8 GB preparation limit (${(input.source.sizeBytes / GIB).toFixed(1)} GB).`,
    );
  }
  if (
    typeof input.source.durationSeconds === 'number' &&
    (!Number.isFinite(input.source.durationSeconds) ||
      input.source.durationSeconds <= 0 ||
      input.source.durationSeconds > MAX_DURATION_SECONDS)
  ) {
    return blocked(kind, input.source, 'The media duration is invalid or exceeds six hours.');
  }

  if (kind === 'dataset') {
    return ready(kind, 'structured_examples', input.source, [
      'validate_schema',
      'deduplicate_examples',
      'split_dataset',
    ]);
  }
  if (kind === 'text' || kind === 'code') {
    return ready(kind, 'plain_text', input.source, [
      'decode_text',
      'normalize_text',
      'deduplicate_examples',
    ]);
  }

  const workerFailure = requiresAttestedWorker(kind, input.source, input.worker);
  if (workerFailure) return workerFailure;
  const worker = input.worker as MediaWorkerCapability;

  if (kind === 'document') {
    if (!worker.documentExtraction) {
      return blocked(kind, input.source, 'The verified local document extractor is unavailable.');
    }
    return ready(kind, 'extract_to_text', input.source, [
      'inspect_document',
      'extract_text',
      'extract_images',
      'normalize_text',
    ]);
  }

  if (kind === 'image') {
    if (!worker.imagePreparation) {
      return blocked(
        kind,
        input.source,
        'The verified local image preparation worker is unavailable.',
      );
    }
    const native = input.requestedModality === 'image' && worker.nativeModalities.includes('image');
    return ready(kind, native ? 'native_multimodal' : 'extract_to_text', input.source, [
      'validate_image',
      'strip_optional_metadata',
      'resize_bounded',
      native ? 'prepare_image_examples' : 'caption_image',
    ]);
  }

  if (kind === 'audio') {
    const native = input.requestedModality === 'audio' && worker.nativeModalities.includes('audio');
    if (!native && !worker.transcription) {
      return blocked(
        kind,
        input.source,
        'Local transcription is unavailable for this audio source.',
      );
    }
    return ready(kind, native ? 'native_multimodal' : 'extract_to_text', input.source, [
      'inspect_audio',
      'segment_audio',
      native ? 'prepare_audio_examples' : 'transcribe_audio',
    ]);
  }

  if (!worker.ffmpeg) {
    return blocked(kind, input.source, 'The verified local FFmpeg video worker is unavailable.');
  }
  const native = input.requestedModality === 'video' && worker.nativeModalities.includes('video');
  if (!native && !worker.transcription) {
    return blocked(
      kind,
      input.source,
      'The selected model cannot use video and local transcription is unavailable.',
    );
  }
  return ready(kind, native ? 'native_multimodal' : 'extract_to_text', input.source, [
    'inspect_container',
    'sample_frames',
    'extract_audio',
    native ? 'align_multimodal_examples' : 'transcribe_audio',
  ]);
}

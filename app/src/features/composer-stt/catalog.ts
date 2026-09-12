/**
 * Speech-to-Text catalog for Settings → Speech to Text.
 *
 * Verified placement (2026-08):
 * - Whisper * via existing faster-whisper (CTranslate2) desktop pipeline — downloadable/runnable.
 * - Moonshine * are real local MIT models (Useful Sensors / Moonshine AI) but need a
 *   Moonshine/ONNX runtime not yet wired into VibeSpace STT — catalog-only until that lands.
 * - Cohere Transcribe 03-2026 is open-weights (Apache 2.0) + cloud API; not on the
 *   faster-whisper path — shown honestly as cloud/advanced, not a fake local install.
 */

import type { FasterWhisperModelId } from '@/types/common';

/** All catalog ids users can select in the Local list. */
export type LocalSttCatalogId =
  | 'moonshine-medium-streaming'
  | 'moonshine-medium-streaming-q4'
  | 'whisper-small-en-q8'
  | 'whisper-base-en-q5'
  | 'moonshine-tiny-streaming-q4'
  | 'cohere-transcribe-03-2026'
  // Legacy faster-whisper ids (still valid after migration)
  | 'tiny'
  | 'small'
  | 'base'
  | 'large-v3';

export type SttPlacement =
  | 'local-downloadable'
  | 'local-runtime-pending'
  | 'cloud-or-advanced';

export type SttEngine =
  | 'faster-whisper'
  | 'moonshine'
  | 'cohere-api'
  | 'system'
  | 'deepgram';

export interface LocalSttCatalogEntry {
  id: LocalSttCatalogId;
  /** Exact product display label (do not paraphrase). */
  label: string;
  engine: SttEngine;
  placement: SttPlacement;
  provider: string;
  /** Runtime / HF identifier when known. */
  modelIdentifier: string;
  sizeLabel: string;
  sizeBytes: number;
  license: string;
  languages: string;
  streaming: boolean;
  hardware: string;
  description: string;
  /** Maps to faster-whisper download/transcribe id when placement is local-downloadable. */
  fasterWhisperId?: FasterWhisperModelId;
  /** HF repo used for faster-whisper download manifests. */
  hfRepo?: string;
  /** Whether this entry can be the active local transcription model today. */
  runnable: boolean;
}

/** Legacy three-model list kept for managers that only understand downloadable whisper packs. */
export interface FasterWhisperModelDef {
  id: FasterWhisperModelId;
  label: string;
  hfRepo: string;
  sizeLabel: string;
  sizeBytes: number;
  description: string;
  recommended?: boolean;
}

export const LOCAL_STT_CATALOG: readonly LocalSttCatalogEntry[] = [
  {
    id: 'moonshine-medium-streaming',
    label: 'Moonshine Medium Streaming',
    engine: 'moonshine',
    placement: 'local-runtime-pending',
    provider: 'Moonshine AI / Useful Sensors',
    modelIdentifier: 'UsefulSensors/moonshine-streaming-medium',
    sizeLabel: '~1.0 GB (full) / ~180 MB (quantized packs)',
    sizeBytes: 1_014 * 1024 * 1024,
    license: 'MIT',
    languages: 'English (primary)',
    streaming: true,
    hardware: 'CPU-friendly streaming ASR; no GPU required for typical dictation',
    description:
      'Verified local streaming STT. VibeSpace does not yet run the Moonshine runtime — shown for catalog completeness, not active transcription.',
    runnable: false,
  },
  {
    id: 'moonshine-medium-streaming-q4',
    label: 'Moonshine Medium Streaming Q4 — best one!',
    engine: 'moonshine',
    placement: 'local-runtime-pending',
    provider: 'Moonshine AI / Useful Sensors (community GGUF quant)',
    modelIdentifier: 'moonshine-streaming-medium Q4_K (GGUF)',
    sizeLabel: '~183 MB (Q4)',
    sizeBytes: 183 * 1024 * 1024,
    license: 'MIT (base model)',
    languages: 'English (primary)',
    streaming: true,
    hardware: 'Smallest practical Moonshine Medium pack for laptops/edge CPUs',
    description:
      'Owner-requested best local streaming candidate once the Moonshine runtime is wired. Not marked active-best until download + transcription work in-app.',
    runnable: false,
  },
  {
    id: 'whisper-small-en-q8',
    label: 'Whisper small.en Q8',
    engine: 'faster-whisper',
    placement: 'local-downloadable',
    provider: 'OpenAI Whisper via Systran CTranslate2',
    modelIdentifier: 'Systran/faster-whisper-small.en',
    sizeLabel: '~486 MB',
    sizeBytes: 486 * 1024 * 1024,
    license: 'MIT',
    languages: 'English',
    streaming: false,
    hardware: 'CPU (int8 via faster-whisper); ~1–2 GB RAM during decode',
    description:
      'Local English dictation through VibeSpace’s faster-whisper pipeline (CTranslate2 int8). Display name preserves the Q8 product label; runtime uses the Systran small.en pack.',
    fasterWhisperId: 'whisper-small-en-q8',
    hfRepo: 'Systran/faster-whisper-small.en',
    runnable: true,
  },
  {
    id: 'whisper-base-en-q5',
    label: 'Whisper base.en Q5',
    engine: 'faster-whisper',
    placement: 'local-downloadable',
    provider: 'OpenAI Whisper via Systran CTranslate2',
    modelIdentifier: 'Systran/faster-whisper-base.en',
    sizeLabel: '~145 MB',
    sizeBytes: 145 * 1024 * 1024,
    license: 'MIT',
    languages: 'English',
    streaming: false,
    hardware: 'CPU (int8); lightest English Whisper option we ship today',
    description:
      'Faster, smaller English local model. Display name preserves the Q5 product label; runtime uses the Systran base.en pack.',
    fasterWhisperId: 'whisper-base-en-q5',
    hfRepo: 'Systran/faster-whisper-base.en',
    runnable: true,
  },
  {
    id: 'moonshine-tiny-streaming-q4',
    label: 'Moonshine Tiny Streaming Q4',
    engine: 'moonshine',
    placement: 'local-runtime-pending',
    provider: 'Moonshine AI / Useful Sensors',
    modelIdentifier: 'moonshine-streaming-tiny (Q4 quant when available)',
    sizeLabel: '~40–80 MB (quantized class)',
    sizeBytes: 60 * 1024 * 1024,
    license: 'MIT',
    languages: 'English (primary)',
    streaming: true,
    hardware: 'Lowest-footprint Moonshine streaming class',
    description:
      'Verified local streaming family member. Runtime not integrated yet — catalog only.',
    runnable: false,
  },
  {
    id: 'cohere-transcribe-03-2026',
    label: 'Cohere Transcribe 03-2026',
    engine: 'cohere-api',
    placement: 'cloud-or-advanced',
    provider: 'Cohere Labs',
    modelIdentifier: 'cohere-transcribe-03-2026',
    sizeLabel: '~2B params (open weights) / cloud API',
    sizeBytes: 0,
    license: 'Apache 2.0 (open weights) + Cohere API terms for hosted',
    languages: '14 languages including English',
    streaming: false,
    hardware: 'Cloud API or heavy local Transformers/vLLM — not faster-whisper',
    description:
      'Not a faster-whisper pack. Available as Cohere cloud transcription and open weights on Hugging Face. Not mislabeled as one-click local install in this build.',
    runnable: false,
  },
] as const;

/** Downloadable faster-whisper models used by the desktop STT pipeline. */
export const FASTER_WHISPER_MODELS: readonly FasterWhisperModelDef[] = [
  {
    id: 'whisper-base-en-q5',
    label: 'Whisper base.en Q5',
    hfRepo: 'Systran/faster-whisper-base.en',
    sizeLabel: '~145 MB',
    sizeBytes: 145 * 1024 * 1024,
    description: 'Light English local dictation (faster-whisper base.en).',
  },
  {
    id: 'whisper-small-en-q8',
    label: 'Whisper small.en Q8',
    hfRepo: 'Systran/faster-whisper-small.en',
    sizeLabel: '~486 MB',
    sizeBytes: 486 * 1024 * 1024,
    description: 'Balanced English local dictation (faster-whisper small.en).',
  },
  {
    id: 'tiny',
    label: 'Whisper tiny (legacy)',
    hfRepo: 'Systran/faster-whisper-tiny',
    sizeLabel: '~78 MB',
    sizeBytes: 78 * 1024 * 1024,
    description: 'Legacy multilingual tiny pack.',
  },
  {
    id: 'small',
    label: 'Whisper small.en (legacy id)',
    hfRepo: 'Systran/faster-whisper-small.en',
    sizeLabel: '~486 MB',
    sizeBytes: 486 * 1024 * 1024,
    description: 'Legacy id for small.en — same files as Whisper small.en Q8.',
  },
  {
    id: 'base',
    label: 'Whisper base.en (legacy id)',
    hfRepo: 'Systran/faster-whisper-base.en',
    sizeLabel: '~145 MB',
    sizeBytes: 145 * 1024 * 1024,
    description: 'Legacy id for base.en — same files as Whisper base.en Q5.',
  },
  {
    id: 'large-v3',
    label: 'Whisper large-v3 (legacy)',
    hfRepo: 'Systran/faster-whisper-large-v3',
    sizeLabel: '~3.09 GB',
    sizeBytes: 3_090 * 1024 * 1024,
    description: 'Legacy high-accuracy pack.',
  },
] as const;

const LEGACY_TO_CATALOG: Record<string, LocalSttCatalogId> = {
  tiny: 'tiny',
  small: 'whisper-small-en-q8',
  'small.en': 'whisper-small-en-q8',
  base: 'whisper-base-en-q5',
  'base.en': 'whisper-base-en-q5',
  'large-v3': 'large-v3',
  'whisper-small-en-q8': 'whisper-small-en-q8',
  'whisper-base-en-q5': 'whisper-base-en-q5',
  'moonshine-medium-streaming': 'moonshine-medium-streaming',
  'moonshine-medium-streaming-q4': 'moonshine-medium-streaming-q4',
  'moonshine-tiny-streaming-q4': 'moonshine-tiny-streaming-q4',
  'cohere-transcribe-03-2026': 'cohere-transcribe-03-2026',
};

/** Normalize persisted model ids onto the current catalog. */
export function normalizeLocalSttCatalogId(raw: string | null | undefined): LocalSttCatalogId {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase();
  return LEGACY_TO_CATALOG[key] ?? 'whisper-small-en-q8';
}

/** Map a catalog selection to a faster-whisper runtime id when downloadable. */
export function toFasterWhisperModelId(id: LocalSttCatalogId): FasterWhisperModelId | null {
  const entry = localSttCatalogEntry(id);
  if (!entry?.runnable || entry.engine !== 'faster-whisper') return null;
  if (entry.fasterWhisperId) return entry.fasterWhisperId;
  if (id === 'tiny' || id === 'small' || id === 'base' || id === 'large-v3') return id;
  if (id === 'whisper-small-en-q8') return 'whisper-small-en-q8';
  if (id === 'whisper-base-en-q5') return 'whisper-base-en-q5';
  return null;
}

/** Normalize any stored faster-whisper id for the native bridge. */
export function normalizeFasterWhisperModelId(raw: string | null | undefined): FasterWhisperModelId {
  const catalogId = normalizeLocalSttCatalogId(raw);
  return toFasterWhisperModelId(catalogId) ?? 'whisper-small-en-q8';
}

export function localSttCatalogEntry(id: string): LocalSttCatalogEntry | undefined {
  const normalized = normalizeLocalSttCatalogId(id);
  return (
    LOCAL_STT_CATALOG.find((entry) => entry.id === normalized) ??
    LOCAL_STT_CATALOG.find((entry) => entry.id === id)
  );
}

export function fasterWhisperModelDef(id: FasterWhisperModelId): FasterWhisperModelDef {
  const normalized = normalizeFasterWhisperModelId(id);
  return (
    FASTER_WHISPER_MODELS.find((m) => m.id === normalized) ??
    FASTER_WHISPER_MODELS.find((m) => m.id === 'whisper-small-en-q8') ??
    FASTER_WHISPER_MODELS[0]!
  );
}

export function formatBytesShort(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function placementLabel(placement: SttPlacement): string {
  switch (placement) {
    case 'local-downloadable':
      return 'Local · downloadable';
    case 'local-runtime-pending':
      return 'Local · runtime pending';
    case 'cloud-or-advanced':
      return 'Cloud / advanced';
    default:
      return placement;
  }
}

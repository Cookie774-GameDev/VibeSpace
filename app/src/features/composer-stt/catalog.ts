import type { FasterWhisperModelId } from '@/types/common';

export interface FasterWhisperModelDef {
  id: FasterWhisperModelId;
  label: string;
  hfRepo: string;
  sizeLabel: string;
  sizeBytes: number;
  description: string;
  recommended?: boolean;
}

export const FASTER_WHISPER_MODELS: readonly FasterWhisperModelDef[] = [
  {
    id: 'tiny',
    label: 'Tiny',
    hfRepo: 'Systran/faster-whisper-tiny',
    sizeLabel: '~78 MB',
    sizeBytes: 78 * 1024 * 1024,
    description: 'Fastest local transcription with lower accuracy.',
  },
  {
    id: 'small',
    label: 'Small (small.en)',
    hfRepo: 'Systran/faster-whisper-small.en',
    sizeLabel: '~486 MB',
    sizeBytes: 486 * 1024 * 1024,
    description: 'Best speed and accuracy balance for English dictation.',
    recommended: true,
  },
  {
    id: 'large-v3',
    label: 'Large v3',
    hfRepo: 'Systran/faster-whisper-large-v3',
    sizeLabel: '~3.09 GB',
    sizeBytes: 3_090 * 1024 * 1024,
    description: 'Highest accuracy; needs more disk space and CPU time.',
  },
] as const;

export function fasterWhisperModelDef(id: FasterWhisperModelId): FasterWhisperModelDef {
  return FASTER_WHISPER_MODELS.find((m) => m.id === id) ?? FASTER_WHISPER_MODELS[1]!;
}

export function formatBytesShort(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

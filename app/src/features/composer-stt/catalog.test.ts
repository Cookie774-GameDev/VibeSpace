import { describe, expect, it } from 'vitest';
import {
  FASTER_WHISPER_MODELS,
  LOCAL_STT_CATALOG,
  fasterWhisperModelDef,
  formatBytesShort,
  normalizeFasterWhisperModelId,
  normalizeLocalSttCatalogId,
  toFasterWhisperModelId,
} from './catalog';

describe('STT catalog', () => {
  it('includes every requested display label exactly once', () => {
    const labels = LOCAL_STT_CATALOG.map((entry) => entry.label);
    expect(labels).toEqual([
      'Moonshine Medium Streaming',
      'Moonshine Medium Streaming Q4 — best one!',
      'Whisper small.en Q8',
      'Whisper base.en Q5',
      'Moonshine Tiny Streaming Q4',
      'Cohere Transcribe 03-2026',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('marks only faster-whisper packs as downloadable/runnable', () => {
    const downloadable = LOCAL_STT_CATALOG.filter((e) => e.placement === 'local-downloadable');
    expect(downloadable.every((e) => e.runnable && e.engine === 'faster-whisper')).toBe(true);
    expect(downloadable.map((e) => e.label)).toEqual([
      'Whisper small.en Q8',
      'Whisper base.en Q5',
    ]);
  });

  it('does not claim Moonshine Q4 is an active best choice until runtime is wired', () => {
    const best = LOCAL_STT_CATALOG.find((e) => e.id === 'moonshine-medium-streaming-q4');
    expect(best?.runnable).toBe(false);
    expect(best?.placement).toBe('local-runtime-pending');
    // Label keeps owner wording; placement is honest.
    expect(best?.label).toBe('Moonshine Medium Streaming Q4 — best one!');
  });

  it('classifies Cohere as cloud/advanced, not a fake local install', () => {
    const cohere = LOCAL_STT_CATALOG.find((e) => e.id === 'cohere-transcribe-03-2026');
    expect(cohere?.placement).toBe('cloud-or-advanced');
    expect(cohere?.runnable).toBe(false);
  });

  it('normalizes legacy small → whisper-small-en-q8 for catalog selection', () => {
    expect(normalizeLocalSttCatalogId('small')).toBe('whisper-small-en-q8');
    expect(normalizeFasterWhisperModelId('small')).toBe('whisper-small-en-q8');
    expect(toFasterWhisperModelId('whisper-base-en-q5')).toBe('whisper-base-en-q5');
    expect(toFasterWhisperModelId('moonshine-medium-streaming-q4')).toBeNull();
  });

  it('keeps downloadable faster-whisper defs for the manager', () => {
    expect(FASTER_WHISPER_MODELS.some((m) => m.id === 'whisper-small-en-q8')).toBe(true);
    expect(fasterWhisperModelDef('whisper-small-en-q8').hfRepo).toContain('small.en');
    expect(formatBytesShort(78 * 1024 * 1024)).toBe('82 MB');
  });
});

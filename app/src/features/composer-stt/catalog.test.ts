import { describe, expect, it } from 'vitest';
import { FASTER_WHISPER_MODELS, fasterWhisperModelDef, formatBytesShort } from './catalog';

describe('faster-whisper catalog', () => {
  it('lists tiny, small, and large-v3 with size labels', () => {
    expect(FASTER_WHISPER_MODELS.map((m) => m.id)).toEqual(['tiny', 'small', 'large-v3']);
    expect(fasterWhisperModelDef('small').recommended).toBe(true);
    expect(fasterWhisperModelDef('small').sizeLabel).toContain('486');
  });

  it('formats download sizes for UI', () => {
    expect(formatBytesShort(78 * 1024 * 1024)).toBe('82 MB');
    expect(formatBytesShort(3_090 * 1024 * 1024)).toMatch(/GB/);
  });
});

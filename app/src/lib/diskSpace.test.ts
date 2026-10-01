import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytesShort,
  hasEnoughDiskSpaceForWrite,
  sizeLabelToBytes,
} from './diskSpace';

describe('diskSpace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses catalog size labels', () => {
    expect(sizeLabelToBytes('1.3 GB')).toBe(1_300_000_000);
    expect(sizeLabelToBytes('815 MB')).toBe(815_000_000);
    expect(sizeLabelToBytes('bogus')).toBeNull();
  });

  it('formats bytes for toasts', () => {
    expect(formatBytesShort(1_300_000_000)).toBe('1.3 GB');
    expect(formatBytesShort(null)).toBe('unknown');
  });

  it('does not hard-block Ollama-style writes on soft browser estimates that are only slightly low', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: async () => ({ quota: 2_000_000_000, usage: 500_000_000 }),
      },
    });
    // 1.5 GB available vs 1.3 GB model — origin estimate must not hard-fail.
    const result = await hasEnoughDiskSpaceForWrite(1_300_000_000, { force: true });
    expect(result.availableBytes).toBe(1_500_000_000);
    expect(result.authoritative).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('blocks when browser estimate is clearly far below requirement', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: async () => ({ quota: 400_000_000, usage: 100_000_000 }),
      },
    });
    const result = await hasEnoughDiskSpaceForWrite(1_300_000_000, { force: true });
    expect(result.ok).toBe(false);
  });
});

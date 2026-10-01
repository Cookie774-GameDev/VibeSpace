import { describe, expect, it } from 'vitest';
import { LOCAL_MODEL_CATALOG } from './localModelCatalog';

describe('requested local model catalog', () => {
  it('uses the exact verified Ollama identifiers and user-facing labels', () => {
    const requested = LOCAL_MODEL_CATALOG.filter((model) =>
      ['Qwen3.6 35B-A3B', 'GPT-OSS 20B', 'Qwen3.5 4B'].includes(model.displayName),
    );

    expect(requested.map(({ displayName, name }) => ({ displayName, name }))).toEqual([
      { displayName: 'Qwen3.6 35B-A3B', name: 'qwen3.6:35b-a3b' },
      { displayName: 'GPT-OSS 20B', name: 'gpt-oss:20b' },
      { displayName: 'Qwen3.5 4B', name: 'qwen3.5:4b' },
    ]);
    expect(requested).toHaveLength(3);
    expect(requested.every((model) => model.availability === 'verified')).toBe(true);
    expect(requested.every((model) => model.recommended !== true)).toBe(true);
  });

  it('discloses provenance, license, quantization, context, size, and hardware guidance', () => {
    const requested = LOCAL_MODEL_CATALOG.filter((model) =>
      ['qwen3.6:35b-a3b', 'gpt-oss:20b', 'qwen3.5:4b'].includes(model.name),
    );

    expect(requested).toHaveLength(3);
    for (const model of requested) {
      expect(model.sourceUrl).toMatch(/^https:\/\/(?:ollama\.com|huggingface\.co|github\.com)\//);
      expect(model.license).toBe('Apache-2.0');
      expect(model.quantizationOptions?.length).toBeGreaterThan(0);
      expect(model.contextTokens).toBeGreaterThanOrEqual(128_000);
      expect(model.approximateDownloadBytes).toBeGreaterThan(1_000_000_000);
      expect(model.hardware?.ram).toBeTruthy();
      expect(model.hardware?.vram).toBeTruthy();
      expect(model.hardware?.cpuOnly).toBeTruthy();
      expect(model.hardware?.speedClass).toBeTruthy();
    }
  });
});

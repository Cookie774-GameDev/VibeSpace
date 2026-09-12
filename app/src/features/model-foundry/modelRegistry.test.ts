import { describe, expect, it } from 'vitest';
import { FOUNDRY_MODEL_CATALOG, modelCompatibility } from './modelRegistry';

describe('Foundry model catalog', () => {
  it('pins every downloadable model to a complete immutable offline snapshot', () => {
    const downloads = FOUNDRY_MODEL_CATALOG.filter((model) => model.kind === 'downloadable');
    expect(downloads.length).toBeGreaterThan(0);
    for (const model of downloads) {
      expect(model.format).toBe('safetensors');
      expect(model.remoteCode).toBe(false);
      expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(model.download?.files.length).toBeGreaterThanOrEqual(4);
      const paths = new Set<string>();
      for (const file of model.download?.files ?? []) {
        expect(file.path).toMatch(/^[a-zA-Z0-9_.-]+$/);
        expect(file.expectedSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.url).toContain(`/resolve/${model.revision}/${file.path}`);
        expect(file.approvedMaximumBytes).toBeGreaterThan(0);
        paths.add(file.path);
      }
      expect(paths.size).toBe(model.download?.files.length);
      expect(paths.has('config.json')).toBe(true);
      expect(paths.has('tokenizer.json')).toBe(true);
      expect(paths.has('tokenizer_config.json')).toBe(true);
      expect(paths.has('model.safetensors')).toBe(true);
      const total = model.download?.files.reduce((sum, file) => sum + file.approvedMaximumBytes, 0) ?? 0;
      expect(total).toBeLessThanOrEqual(model.download?.approvedMaximumBytes ?? 0);
    }
  });

  it('reports fixture compatibility without inventing native memory data', () => {
    expect(modelCompatibility(FOUNDRY_MODEL_CATALOG[0], null)).toBe('compatible');
    expect(modelCompatibility(FOUNDRY_MODEL_CATALOG[1], null)).toBe('unknown');
  });
});

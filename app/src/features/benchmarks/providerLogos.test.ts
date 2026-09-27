import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_LOGOS } from './providerLogos';

describe('benchmark provider logos', () => {
  it('bundles the source-matched marks for all 57 providers in the checked feed', () => {
    const entries = Object.entries(PROVIDER_LOGOS);
    expect(entries).toHaveLength(57);
    expect(PROVIDER_LOGOS.SpaceXAI).toEqual({
      src: '/benchmark-provider-logos/spacexai.svg',
      sourceUrl: 'https://artificialanalysis.ai/img/logos/spacexai.svg',
    });
    for (const [provider, logo] of entries) {
      expect(provider.length).toBeGreaterThan(0);
      expect(logo.src).toMatch(/^\/benchmark-provider-logos\/[a-z0-9_-]+\.(svg|png|jpg|webp)$/);
      expect(logo.sourceUrl).toBe(
        `https://artificialanalysis.ai/img/logos/${path.basename(logo.src)}`,
      );
      expect(existsSync(path.join(process.cwd(), 'public', logo.src.slice(1)))).toBe(true);
    }
  });
});

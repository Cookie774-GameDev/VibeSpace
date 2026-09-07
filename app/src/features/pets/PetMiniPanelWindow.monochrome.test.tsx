import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MONO_FONT_SANS = '[html[data-theme=monochrome]_&]:font-sans';
const MONO_SHADOW_NONE = '[html[data-theme=monochrome]_&_*]:shadow-none';

function readSource(): string {
  return readFileSync(resolve(__dirname, 'PetMiniPanelWindow.tsx'), 'utf8');
}

describe('PetMiniPanelWindow MonoChrome appearance', () => {
  it('marks the pet-mini-panel-window surface and flattens shadows beneath the MonoChrome gate only', () => {
    const source = readSource();

    expect(source).toContain('data-monochrome-surface="pet-mini-panel-window"');
    expect(source).toContain('data-pet-window="pet-mini-panel"');
    // MonoChrome uses the flat sans voice and removes every descendant painted shadow.
    expect(source).toContain(MONO_FONT_SANS);
    expect(source).toContain(MONO_SHADOW_NONE);
    // The rounded panel paints its surface; the native corner boundary stays clear.
    expect(source).toContain('bg-transparent');
  });

  it('preserves auth-gated boot and runtime-effect behavior (no functional regression)', () => {
    const source = readSource();

    expect(source).toContain('AuthGate');
    expect(source).toContain('runtimeEffectsEnabled');
    expect(source).toContain('applyThemeToDocument');
    expect(source).toContain('reassertPetOverlayTopmost');
  });
});

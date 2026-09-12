import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MONO_HIDDEN = '[html[data-theme=monochrome]_&]:hidden';
const MONO_BLUR_NONE = '[html[data-theme=monochrome]_&]:backdrop-blur-none';

function readSource(): string {
  return readFileSync(resolve(__dirname, 'PetMiniPanel.tsx'), 'utf8');
}

describe('PetMiniPanel MonoChrome appearance', () => {
  it('hides the decorative accent-edge gradient beneath the MonoChrome gate only', () => {
    const source = readSource();

    // Ordinary themes keep the copper accent gradient line.
    expect(source).toContain(
      'bg-gradient-to-r from-transparent via-accent-copper to-transparent opacity-80',
    );
    // MonoChrome removes the gradient ornament entirely (no gradient remains).
    expect(source).toContain(
      `bg-gradient-to-r from-transparent via-accent-copper to-transparent opacity-80 ${MONO_HIDDEN}`,
    );
  });

  it('flattens the close-confirm scrim blur beneath the MonoChrome gate only', () => {
    const source = readSource();

    // Ordinary themes keep the blurred scrim.
    expect(source).toContain('bg-background/85 p-4 backdrop-blur-sm');
    // MonoChrome drops the backdrop blur on the alertdialog scrim (no blur remains).
    expect(source).toContain(`bg-background/85 p-4 backdrop-blur-sm ${MONO_BLUR_NONE}`);
  });

  it('preserves the dialog hooks the shared MonoChrome theme flattens', () => {
    const source = readSource();

    // The shell stays a dialog so monochrome-theme.css resets its gradient and shadow.
    expect(source).toContain('bg-gradient-to-b from-panel via-panel to-background');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('data-pet-mini-panel="true"');
    // The active tab keeps the aria-current hook the theme uses to drop its shadow.
    expect(source).toContain('pet-panel-nav-button');
    expect(source).toContain("aria-current={active ? 'page' : undefined}");
    // The compact header uses no backdrop blur in any theme.
    expect(source).toContain('pet-panel-top border-b border-border/80');
    expect(source).not.toContain('pet-panel-top border-b border-border/80 bg-elevated/40');
  });
});

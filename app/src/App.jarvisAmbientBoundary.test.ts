import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');

describe('App Jarvis ambient boundary', () => {
  it('routes the isolated overlay before ordinary product boot', () => {
    expect(source).toContain("view === 'jarvis-ambient-overlay'");
    expect(source).toContain('<JarvisAmbientOverlayView />');
    expect(source.indexOf("view === 'jarvis-ambient-overlay'")).toBeLessThan(
      source.indexOf("view === 'pet-overlay'"),
    );
  });

  it('keeps the compact Voice HUD visible alongside the native Aura projection', () => {
    const start=source.indexOf('function VoiceModalHost()');
    const end=source.indexOf('function ActionsPaletteHost()',start);
    expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
    const host=source.slice(start,end);
    expect(host).toContain('<JarvisAmbientHost />');
    expect(host).toContain('<VoiceModal />');
    expect(host).not.toMatch(/<[^>]+\bhidden(?:\s|=|>)/);
    expect(host).not.toContain('aria-hidden="true"');
  });
});

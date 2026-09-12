import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'VoiceModal.tsx'), 'utf8');

describe('Voice module scale', () => {
  it('keeps the HUD and text on the same panel scale token', () => {
    const css = readFileSync(resolve(__dirname, 'voice-module.css'), 'utf8');
    expect(css).toContain('--jv: 2.55px;');
    expect(css).toContain(".jarvis-hud-orb[data-speaking='true']");
  });
});

describe('VoiceModal MonoChrome appearance', () => {
  it('keeps the Jarvis module as the rounded HUD exception in MonoChrome', () => {
    expect(source).not.toContain('[[data-theme=monochrome]_&]:rounded-sm');
    expect(source).not.toContain(
      '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![background-image:none]',
    );
    expect(source).not.toContain(
      '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![filter:none]',
    );
    expect(source).not.toContain(
      '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:!shadow-none',
    );
    expect(source).not.toContain(
      '[[data-theme=monochrome]_&]:[&_.jarvis-voice-orb-button_*]:![transform:none]',
    );
  });

  it('keeps the Command Center collapse control visible when the panel is compact', () => {
    expect(source).not.toContain("!showCommandCenter && 'sr-only'");
    expect(source).toContain("aria-label={showCommandCenter ? 'Collapse Command Center' : 'Expand Command Center'}");
  });

  it('uses opaque MonoChrome disclosure borders and hover paint', () => {
    expect(source).toContain(
      '[html[data-theme=monochrome]_&]:border-border [html[data-theme=monochrome]_&]:hover:bg-muted',
    );
  });
});

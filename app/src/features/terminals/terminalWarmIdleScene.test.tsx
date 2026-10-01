import { act, render, screen } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_WARM_IDLE_MS,
  TerminalWarmIdleScene,
  isWarmTerminalIdleEligible,
  terminalWarmIdleAsset,
  terminalWarmIdleVariant,
} from './terminalWarmIdleScene';

describe('Warm terminal idle scene policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires five continuous idle minutes in Warm without treating pointer presence as activity', () => {
    const now = 1_000_000;
    const base = {
      lastActivityAt: now - TERMINAL_WARM_IDLE_MS,
      now,
      pointerEnteredAt: null,
      pointerInside: false,
      theme: 'warm',
    } as const;

    expect(isWarmTerminalIdleEligible(base)).toBe(true);
    expect(isWarmTerminalIdleEligible({ ...base, lastActivityAt: base.lastActivityAt + 1 })).toBe(
      false,
    );
    expect(isWarmTerminalIdleEligible({ ...base, theme: 'default' })).toBe(false);
    expect(
      isWarmTerminalIdleEligible({
        ...base,
        pointerEnteredAt: base.lastActivityAt + TERMINAL_WARM_IDLE_MS - 1,
        pointerInside: true,
      }),
    ).toBe(true);
    expect(
      isWarmTerminalIdleEligible({
        ...base,
        pointerEnteredAt: base.lastActivityAt + TERMINAL_WARM_IDLE_MS,
        pointerInside: true,
      }),
    ).toBe(false);
  });

  it('assigns one of four stable isolated-art variants from terminal identity', () => {
    const ids = ['terminal-a', 'terminal-b', 'terminal-c', 'terminal-d'];
    const first = ids.map(terminalWarmIdleVariant);
    const second = ids.map(terminalWarmIdleVariant);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(
      first.every((variant) =>
        ['mountain', 'trees', 'evergreens', 'sun-mountains'].includes(variant),
      ),
    ).toBe(true);
    expect(first.every((variant) => terminalWarmIdleAsset(variant).endsWith('.png'))).toBe(true);
  });

  it('reveals only at the threshold and stays inert to pointer and assistive technology', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-05T06:00:00Z');
    vi.setSystemTime(now);
    const { rerender } = render(
      <TerminalWarmIdleScene
        identity="terminal-a"
        lastActivityAt={now.getTime()}
        pointerEnteredAt={null}
        pointerInside={false}
        theme="warm"
      />,
    );

    expect(screen.queryByTestId('terminal-warm-idle-scene')).toBeNull();
    act(() => vi.advanceTimersByTime(TERMINAL_WARM_IDLE_MS));
    const scene = screen.getByTestId('terminal-warm-idle-scene');
    expect(scene.getAttribute('aria-hidden')).toBe('true');
    expect(scene.className).toContain('pointer-events-none');
    const art = screen.getByTestId('terminal-warm-idle-art');
    expect(art.tagName).toBe('IMG');
    expect(art.className).toContain('terminal-state-art');

    rerender(
      <TerminalWarmIdleScene
        identity="terminal-a"
        lastActivityAt={now.getTime()}
        pointerEnteredAt={now.getTime() + TERMINAL_WARM_IDLE_MS}
        pointerInside
        theme="warm"
      />,
    );
    expect(screen.queryByTestId('terminal-warm-idle-scene')).toBeNull();
  });

  it('dismisses only on same-pane entry/activity and restarts after pointer leave', () => {
    const source = readFileSync(resolve(__dirname, 'TerminalView.tsx'), 'utf8');

    expect(TERMINAL_WARM_IDLE_MS).toBe(5 * 60 * 1000);
    expect(source).toContain('<TerminalWarmIdleScene');
    expect(source).toContain('lastActivityAt={warmIdleLastActivityAt}');
    expect(source).toContain('pointerEnteredAt={warmIdlePointerEnteredAt}');
    expect(source).toContain('pointerInside={warmIdlePointerInside}');
    expect(source).toContain('onPointerEnter={markWarmIdlePointerEntered}');
    expect(source).toContain('onPointerLeave={markWarmIdlePointerLeft}');
    expect(source).toContain('onPointerDownCapture={markWarmIdleInteraction}');
    expect(source).toContain('onKeyDownCapture={markWarmIdleInteraction}');
    expect(source).toMatch(/term\.onData\(\(data: string\) => \{\s*markWarmIdleInteraction\(\);/u);
    expect(source).not.toMatch(
      /textarea\.addEventListener\('focus',\s*\(\)\s*=>\s*\{\s*markWarmIdleInteraction\(\);/u,
    );
    expect(source).not.toContain('warmIdleHovered');
    expect(source).not.toContain('onPointerMove=');
    expect(source).not.toContain('const warmIdleTranscriptAt = useTerminalTranscriptStore');
    expect(source).not.toContain('warmIdleTranscriptAt ?? warmIdleMountedAtRef.current');
  });

  it('ships four sharp true-alpha Warm-only vignette assets without stretch CSS', () => {
    const appRoot = resolve(__dirname, '../../..');
    const css = readFileSync(resolve(appRoot, 'src/styles/warm-theme.css'), 'utf8');
    const assetRoot = resolve(appRoot, 'public/assets/themes/warm/terminals/v2');

    for (const file of [
      'terminal-idle-mountain.png',
      'terminal-idle-trees.png',
      'terminal-idle-evergreens.png',
      'terminal-idle-sun-mountains.png',
    ]) {
      const path = resolve(assetRoot, file);
      expect(existsSync(path), path).toBe(true);
      const png = readFileSync(path);
      expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(1000);
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(1000);
      expect(png[25]).toBe(6);
    }

    expect(css).toContain('.terminal-state-art');
    expect(css).toContain('object-fit: contain');
    expect(css).not.toMatch(
      /\[data-warm-terminal-idle-variant\][\s\S]*?background-size:\s*100%\s+100%/u,
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\[data-warm-terminal-idle-variant\][\s\S]*?animation:\s*none/u,
    );
  });
});

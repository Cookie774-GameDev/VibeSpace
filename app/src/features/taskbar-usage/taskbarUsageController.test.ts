import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_PROVIDER_REFRESH_MS,
  createAsyncUnlistenerRegistry,
  DISPLAY_REFRESH_MS,
  FOREGROUND_PROVIDER_REFRESH_MS,
} from './taskbarUsageController';

describe('taskbar usage refresh policy', () => {
  it('updates visible timestamps every five seconds without polling providers every tick', () => {
    expect(DISPLAY_REFRESH_MS).toBe(5_000);
    expect(FOREGROUND_PROVIDER_REFRESH_MS).toBeGreaterThanOrEqual(60_000);
    expect(BACKGROUND_PROVIDER_REFRESH_MS).toBeGreaterThan(FOREGROUND_PROVIDER_REFRESH_MS);
  });
});

describe('taskbar usage reload cleanup', () => {
  it('immediately unregisters a native listener that resolves after stop', () => {
    const registry = createAsyncUnlistenerRegistry();
    const unlisten = vi.fn();

    registry.stop();
    registry.add(unlisten);

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('runs every registered cleanup exactly once across repeated stop signals', () => {
    const registry = createAsyncUnlistenerRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.add(first);
    registry.add(second);

    registry.stop();
    registry.stop();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('retains startup cleanups and routes HMR and unload through one idempotent stop', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');

    expect(mainSource).toMatch(/const stopThemeSync =[\s\S]*?\? startThemeSync/);
    expect(mainSource).toMatch(
      /const stopTaskbarUsageController =[\s\S]*?\? startTaskbarUsageController/,
    );
    expect(mainSource).toMatch(/const stopRendererLifecycle = \(\) =>/);
    expect(mainSource).toContain("window.addEventListener('pagehide', stopRendererLifecycle");
    expect(mainSource).toMatch(
      /import\.meta\.hot\.dispose\(\(\) => \{[\s\S]*?stopRendererLifecycle\(\);/,
    );
  });
});

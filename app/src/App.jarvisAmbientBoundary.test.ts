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

  it('keeps voice lifecycle headless and uses only the native screen-edge Aura', () => {
    const start = source.indexOf('function VoiceModalHost()');
    const end = source.indexOf('function ActionsPaletteHost()', start);
    const host = source.slice(start, end);
    expect(host).toContain('<JarvisAmbientHost />');
    expect(host).toContain('<VoiceModal />');
    expect(host).toContain('hidden data-jarvis-voice-lifecycle-only="true" aria-hidden="true"');
  });
});

describe('Native Aura window ownership', () => {
  it('destroys only its transient windows instead of invoking hide-to-tray close policy', () => {
    const native = readFileSync(resolve(__dirname, '../src-tauri/src/jarvis_ambient_overlay.rs'), 'utf8');
    const lifecycle = native.slice(native.indexOf('fn ensure_windows('), native.indexOf('fn reconcile_latest('));
    expect(lifecycle).toContain('label.starts_with(AMBIENT_PREFIX)');
    expect(lifecycle).toContain('.destroy()');
    expect(lifecycle).not.toContain('.close()');
  });
});

describe('Native Aura materialization', () => {
  it('returns IPC before constructing a visible offscreen native WebView', () => {
    const native = readFileSync(resolve(__dirname, '../src-tauri/src/jarvis_ambient_overlay.rs'), 'utf8');
    const commands = native.slice(native.indexOf('pub async fn set_jarvis_ambient_snapshot'), native.indexOf('#[cfg(test)]'));
    expect(commands).toContain('schedule_reconcile(&app)');
    expect(commands).not.toContain('spawn_blocking');
    expect(native).toContain('run_on_main_thread');
    expect(native).toContain('.position(-32_000.0, -32_000.0)');
    expect(native).toContain('.visible(true)');
    expect(native).toContain('.additional_browser_args(');
  });
});

it('coalesces nested window events until the current Aura build finishes', () => {
  const native = readFileSync(resolve(__dirname, '../src-tauri/src/jarvis_ambient_overlay.rs'), 'utf8');
  const start = native.indexOf('let intent_before = intent();');
  const callback = native.slice(start, native.indexOf('}) {', start));
  expect(start).toBeGreaterThan(-1);
  expect(callback.indexOf('.store(false, Ordering::Release)')).toBeGreaterThan(callback.indexOf('reconcile_latest(&worker_app)'));
  expect(callback).toContain('intent_before != intent()');
});


it('covers physical displays across workspaces without taking keyboard focus', () => {
  const native = readFileSync(resolve(__dirname, '../src-tauri/src/jarvis_ambient_overlay.rs'), 'utf8');
  expect(native).toMatch(/app\s*\.available_monitors\(\)/);
  expect(native).toContain('let size = *monitor.size();');
  expect(native).toContain('.visible_on_all_workspaces(true)');
  expect(native).toContain('.focusable(false)');
  expect(native).toContain('window.set_ignore_cursor_events(true)');
});

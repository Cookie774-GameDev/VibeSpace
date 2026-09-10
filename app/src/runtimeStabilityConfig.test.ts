import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type WindowConfig = {
  label: string;
  url?: string;
  additionalBrowserArgs?: string;
  visible?: boolean;
  skipTaskbar?: boolean;
};

describe('production runtime stability configuration', () => {
  it('allows bundled WebAssembly parsers while keeping JavaScript eval blocked', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { security: { csp: string } } };
    const scripts = config.app.security.csp
      .split(';')
      .map((directive) => directive.trim().split(/\s+/u))
      .find(([directive]) => directive === 'script-src');

    expect(scripts).toContain("'self'");
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
  });

  it('keeps emergency heap headroom while allowing hidden renderers to throttle', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: WindowConfig[] } };
    const main = config.app.windows.find((window) => window.label === 'main');

    expect(main?.additionalBrowserArgs).toContain('--max-old-space-size=1536');
    expect(main?.additionalBrowserArgs).not.toContain('--disable-renderer-backgrounding');
  });

  it('lets the cold-start intro autoplay with authored audio', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: WindowConfig[] } };
    const intro = config.app.windows.find((window) => window.label === 'cold-start-intro');
    const mainWindow = config.app.windows.find((window) => window.label === 'main');
    expect(intro?.url).toBe('cold-start-intro.html');
    expect(intro?.additionalBrowserArgs).toContain('--autoplay-policy=no-user-gesture-required');
    expect(intro?.visible).not.toBe(true);
    expect(mainWindow?.visible).not.toBe(false);
  });
});

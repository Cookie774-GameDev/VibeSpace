import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type WindowConfig = {
  label: string;
  additionalBrowserArgs?: string;
};

describe('production runtime stability configuration', () => {
  it('keeps emergency heap headroom while allowing hidden renderers to throttle', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as { app: { windows: WindowConfig[] } };
    const main = config.app.windows.find((window) => window.label === 'main');

    expect(main?.additionalBrowserArgs).toContain('--max-old-space-size=3072');
    expect(main?.additionalBrowserArgs).not.toContain('--disable-renderer-backgrounding');
  });
});

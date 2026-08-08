import path from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 4293;
const baseURL = `http://127.0.0.1:${port}`;
const compileEnvironment = {
  VIBESPACE_VITE_CACHE_DIR: path.resolve('.artifacts/ui-fidelity/vite-cache'),
  VITE_VIBESPACE_RUNTIME_PROFILE: 'monochrome-visual-test',
  VITE_VIBESPACE_MONOCHROME_APP_IDENTIFIER: 'ai.vibespace.monochrome.test0000000000000001',
  VITE_VIBESPACE_MONOCHROME_CAPABILITY_IDENTIFIER: 'monochrome-test',
  VITE_VIBESPACE_MONOCHROME_SESSION_NONCE_HASH:
    '58eca8fac5471caab5fc17f4a52c4971eb87a139e7f3fe4edc5eea8c1e55eaf5',
};
const viteCommand =
  `"${process.execPath}" "node_modules/vite/bin/vite.js" ` +
  `--host 127.0.0.1 --port ${port} --strictPort`;

export default defineConfig({
  testDir: './tests/visual/ui-fidelity',
  testMatch: /ui-fidelity\.visual\.spec\.ts/,
  outputDir: '.artifacts/ui-fidelity/playwright',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  webServer: {
    command: viteCommand,
    cwd: 'app',
    env: compileEnvironment,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: [['list'], ['json', { outputFile: '.artifacts/ui-fidelity/report.json' }]],
  use: {
    baseURL,
    channel: 'msedge',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    deviceScaleFactor: 1,
    headless: true,
    locale: 'en-US',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1672, height: 941 },
    launchOptions: {
      args: ['--force-color-profile=srgb', '--disable-features=PaintHolding', '--mute-audio'],
    },
  },
  projects: [{ name: 'ui-fidelity' }],
});

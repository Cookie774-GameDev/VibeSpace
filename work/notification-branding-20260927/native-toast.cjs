const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

function captureNativeView(mode, outputPath) {
  const helper = path.join(__dirname, 'capture-toast.ps1');
  const output = execFileSync('pwsh', [
    '-NoProfile', '-File', helper,
    '-OutputPath', outputPath,
    '-Capture', mode,
    '-TargetPid', '1060',
  ], { timeout: 30000, encoding: 'utf8' });
  process.stdout.write(output);
}

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252', { timeout: 45000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const mainPages = pages.filter((candidate) =>
    candidate.url() !== 'about:blank' && !candidate.url().startsWith('devtools://') &&
    !candidate.url().includes('view=dictation'));
  if (mainPages.length !== 1) {
    throw new Error(`Expected one C2 non-dictation main page; found ${mainPages.length}: ${JSON.stringify(pages.map((candidate) => candidate.url()))}`);
  }
  const page = mainPages[0];
  if (page.url() !== 'http://localhost:5173/?route=chat') {
    await page.goto('http://localhost:5173/?route=chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  const tauri = await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__));
  if (!tauri) throw new Error('C2 Tauri bridge is unavailable on the 5173 native WebView');
  const folder = __dirname;
  const screenshots = {
    fullToast: path.join(folder, 'toast-desktop.png'),
    notificationCenter: path.join(folder, 'notification-center.png'),
    taskbar: path.join(folder, 'taskbar-c2.png'),
  };
  // Focus only the identity-checked C2 HWND before notifying; this also
  // captures the active VibeSpace taskbar button.
  captureNativeView('Taskbar', screenshots.taskbar);
  const permission = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:notification|is_permission_granted'));
  const delivery = await page.evaluate(async () => {
    const { notify } = await import('/src/lib/tauri.ts');
    return notify('VibeSpace notification test', 'Checking the VibeSpace sender and logo.', {
      fallbackToast: false,
    });
  });
  if (delivery.channel !== 'native') throw new Error(`Native notification was not delivered: ${JSON.stringify(delivery)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  captureNativeView('Full', screenshots.fullToast);
  captureNativeView('NotificationCenter', screenshots.notificationCenter);
  captureNativeView('Taskbar', screenshots.taskbar);
  const result = { at: new Date().toISOString(), pageUrl: page.url(), pageTitle: await page.title(), targetCount: pages.length,
    tauri, permission, delivery, c2Pid: 1060, cdpPort: 9252, webviewPid: 22068,
    profile: 'C:\\Users\\viper\\VibeSpace-UnifiedChungus-Final\\work\\dual-live-20260912\\profile-c2\\EBWebView', screenshots };
  fs.writeFileSync(path.join(folder, 'native-toast.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

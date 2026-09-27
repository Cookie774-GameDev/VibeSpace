import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 5000 });
const candidates = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
  try {
    const url = new URL(page.url());
    return url.origin === 'http://localhost:5173' && url.pathname === '/';
  } catch {
    return false;
  }
});
if (candidates.length !== 1) throw new Error(`Expected one native main page; found ${candidates.length}`);
const page = candidates[0];
await page.waitForTimeout(2500);
const state = await page.evaluate(() => ({
  path: `${location.origin}${location.pathname}`,
  appRootMounted: Boolean(document.querySelector('#root')?.childElementCount),
  tauriBridgePresent: Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__),
  chatPaneCount: document.querySelectorAll('[data-testid^="chat-pane-"]').length,
  chatNavRowCount: document.querySelectorAll('[data-testid^="chat-nav-row-"]').length,
  questionCardCount: document.querySelectorAll('.question-card').length,
  transcriptPendingCardCount: document.querySelectorAll('.question-card--transcript-pending').length,
  inlineDismissControlCount: document.querySelectorAll('.question-card [aria-label="Dismiss question"]').length,
  composerCount: document.querySelectorAll('[data-composer-input="true"]').length,
  runtimeModuleLoaded: performance.getEntriesByType('resource')
    .some((entry) => entry.name.includes('/src/lib/ai/runtime.ts')),
}));
const receipt = { at: new Date().toISOString(), selectedPageCount: candidates.length, state };
await writeFile('work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator/c1-post-reload-poll.json', `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exit(0);

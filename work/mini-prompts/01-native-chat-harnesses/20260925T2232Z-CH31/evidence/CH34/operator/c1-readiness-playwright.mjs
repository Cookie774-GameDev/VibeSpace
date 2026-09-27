import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const evidencePath = resolve(
  'work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator/c1-readiness-receipt.json',
);
const endpoint = 'http://127.0.0.1:9223';
const targetOrigin = 'http://localhost:5173';
const targetPath = '/';
const startedAt = new Date().toISOString();
const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const editables = Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]'))
      .filter(visible);
    const nonEmptyEditors = editables.filter((element) => {
      const value = 'value' in element ? element.value : element.innerText;
      return String(value ?? '').trim().length > 0;
    });

    return {
      origin: location.origin,
      pathname: location.pathname,
      readyState: document.readyState,
      tauriBridgePresent: Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__),
      appRootMounted: Boolean(document.querySelector('#root')?.childElementCount),
      visibleEditableCount: editables.length,
      nonEmptyEditableCount: nonEmptyEditors.length,
      questionCardCount: document.querySelectorAll('.question-card').length,
      inlineDismissControlCount: document.querySelectorAll('.question-card [aria-label="Dismiss question"]').length,
      transcriptPendingCardCount: document.querySelectorAll('.question-card--transcript-pending').length,
      reopenControlCount: document.querySelectorAll('.question-card--reopen').length,
      runtimeModuleLoaded: performance.getEntriesByType('resource')
        .some((entry) => entry.name.includes('/src/lib/ai/runtime.ts')),
    };
  });
}

async function inspectServedRuntime(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/src/lib/ai/runtime.ts', { cache: 'no-store' });
    return { status: response.status, source: await response.text() };
  });
  return {
    status: result.status,
    bytes: Buffer.byteLength(result.source, 'utf8'),
    sha256: hash(result.source),
    hasProjectedCancellationHelper: result.source.includes('cancelPendingProjectedNativeQuestions'),
    hasCancellationFailureMarker: result.source.includes('Cancelled native question could not be saved'),
  };
}

const contexts = browser.contexts();
if (contexts.length !== 1) throw new Error(`Expected one C1 browser context; found ${contexts.length}`);
const candidates = contexts[0].pages().filter((page) => {
  try {
    const url = new URL(page.url());
    return url.origin === targetOrigin && url.pathname === targetPath;
  } catch {
    return false;
  }
});
if (candidates.length !== 1) throw new Error(`Expected one native main page; found ${candidates.length}`);

const page = candidates[0];
const before = await inspectPage(page);
const servedBefore = await inspectServedRuntime(page);
if (before.origin !== targetOrigin || before.pathname !== targetPath || !before.tauriBridgePresent || !before.appRootMounted) {
  throw new Error('Native C1 page identity/readiness check failed; page was not reloaded.');
}

let reloaded = false;
let after = before;
let servedAfter = servedBefore;
if (before.nonEmptyEditableCount === 0) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#root')?.childElementCount), { timeout: 20000 });
  await page.waitForTimeout(300);
  after = await inspectPage(page);
  servedAfter = await inspectServedRuntime(page);
  reloaded = true;
}

const receipt = {
  startedAt,
  completedAt: new Date().toISOString(),
  native: {
    cdpEndpoint: endpoint,
    selectedOrigin: before.origin,
    selectedPath: before.pathname,
    singleMainTarget: candidates.length === 1,
    appRootMountedBefore: before.appRootMounted,
    tauriBridgePresent: before.tauriBridgePresent,
  },
  editorSafety: {
    visibleEditableCountBefore: before.visibleEditableCount,
    nonEmptyEditableCountBefore: before.nonEmptyEditableCount,
    reloadAuthorizedAndPerformed: reloaded,
  },
  before,
  servedRuntimeBefore: servedBefore,
  after,
  servedRuntimeAfter: servedAfter,
  checks: {
    currentSourceServed: servedAfter.status === 200 && servedAfter.hasProjectedCancellationHelper && servedAfter.hasCancellationFailureMarker,
    reloadCompleted: reloaded,
    rootMountedAfter: after.appRootMounted,
    tauriBridgePresentAfter: after.tauriBridgePresent,
    noEditorContentIntroduced: after.nonEmptyEditableCount === 0,
  },
};

await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.exit(0);

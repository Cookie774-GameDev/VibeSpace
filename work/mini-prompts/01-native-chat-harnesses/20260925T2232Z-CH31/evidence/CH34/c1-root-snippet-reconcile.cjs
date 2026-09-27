const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const writing = 'CH34_NATIVE_WRITING_7D2\nCopy me exactly.';
const code = 'const ch34NativeSnippet = 42;';
const output = path.join(__dirname, `c1-root-snippet-reconcile-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), chatId, stage: 'attach', providerSendAttempted: false };
let mainPage;
let restoreMinimized = false;

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  mainPage = page;
  const windowState = await page.evaluate(async () => {
    const { getCurrentWindow } = await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');
    const current = getCurrentWindow();
    if (current.label !== 'main') throw new Error('not_official_main_window');
    const wasMinimized = await current.isMinimized();
    if (wasMinimized) await current.unminimize();
    return { wasMinimized };
  });
  restoreMinimized = windowState.wasMinimized;
  receipt.windowState = windowState;
  if (restoreMinimized) await page.waitForTimeout(600);
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  if (!(await pane.isVisible())) throw new Error('source_chat_not_visible');
  const writingCard = pane.locator('[data-assistant-snippet="writing"]').filter({ hasText: writing });
  const codeCard = pane.locator('[data-assistant-snippet="typescript"]').filter({ hasText: code });
  if (await writingCard.count() !== 1 || await codeCard.count() !== 1 ||
      !(await writingCard.isVisible()) || !(await codeCard.isVisible()))
    throw new Error('exact_two_native_snippets_not_visible');
  receipt.stage = 'screenshot';
  const shots = [];
  for (const [name, card] of [['writing', writingCard], ['code', codeCard]]) {
    try {
      await card.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(120);
      const box = await card.boundingBox();
      if (!box || box.width < 100 || box.height < 40) throw new Error('bad_native_card_bounds');
      const file = path.join(__dirname, `c1-root-snippet-${name}-reconcile.png`);
      await page.screenshot({ path: file, clip: box, animations: 'disabled', timeout: 20_000 });
      shots.push({ name, file, width: box.width, height: box.height });
    } catch (error) { shots.push({ name, error: String(error?.message ?? error) }); }
  }
  receipt.screenshots = shots;
  receipt.stage = 'copy';
  const writingButton = writingCard.getByRole('button', { name: 'Copy text', exact: true });
  const codeButton = codeCard.getByRole('button', { name: 'Copy code', exact: true });
  if (await writingButton.count() !== 1 || await codeButton.count() !== 1)
    throw new Error('native_copy_buttons_not_found');
  receipt.writingCopyClicked = true;
  await writingButton.click({ force: true, timeout: 15_000 });
  await writingCard.getByRole('button', { name: 'Copied text', exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 });
  receipt.writingCopyFeedback = true;
  receipt.writingClipboardMatch = await page.evaluate(async (expected) => {
    try { return (await navigator.clipboard.readText()) === expected; }
    catch { return null; }
  }, writing);
  receipt.codeCopyClicked = true;
  await codeButton.click({ force: true, timeout: 15_000 });
  await codeCard.getByRole('button', { name: 'Copied code', exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 });
  receipt.codeCopyFeedback = true;
  receipt.codeClipboardMatch = await page.evaluate(async (expected) => {
    try { return (await navigator.clipboard.readText()) === expected; }
    catch { return null; }
  }, code);
  receipt.passed = receipt.writingCopyFeedback && receipt.codeCopyFeedback &&
    receipt.writingClipboardMatch !== false && receipt.codeClipboardMatch !== false &&
    shots.some((shot) => shot.name === 'writing' && shot.file) &&
    shots.some((shot) => shot.name === 'code' && shot.file);
  receipt.stage = 'complete';
  if (!receipt.passed) throw new Error('native_snippet_reconcile_incomplete');
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(async () => {
  if (mainPage && restoreMinimized) {
    try {
      await mainPage.evaluate(async () => {
        const { getCurrentWindow } = await import('/node_modules/.vite/deps/@tauri-apps_api_window.js');
        await getCurrentWindow().minimize();
      });
      receipt.windowRestoredToMinimized = true;
    } catch (error) {
      receipt.windowRestoreError = String(error?.message ?? error);
    }
  }
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    screenshots: receipt.screenshots ?? null,
    writingCopyFeedback: receipt.writingCopyFeedback ?? null,
    codeCopyFeedback: receipt.codeCopyFeedback ?? null,
    writingClipboardMatch: receipt.writingClipboardMatch ?? null,
    codeClipboardMatch: receipt.codeClipboardMatch ?? null,
    error: receipt.error ?? null })}\n`);
  process.exit(receipt.stage === 'complete' && receipt.passed ? 0 : 1);
});

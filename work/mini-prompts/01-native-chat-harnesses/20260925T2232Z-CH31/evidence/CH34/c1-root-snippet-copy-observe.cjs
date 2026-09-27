const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const output = path.join(__dirname, `c1-root-snippet-copy-observe-${Date.now()}.json`);
const receipt = { startedAt: new Date().toISOString(), chatId, stage: 'attach', providerSendAttempted: false };
let mainPage;
let restoreChatId;

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const tagged = await Promise.all(pages.map(async (page) => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' && new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  mainPage = page;
  const before = await page.evaluate(() => ({
    current: document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')?.getAttribute('data-testid') ?? null,
    draft: document.querySelector('[data-composer-input="true"]')?.value ?? null,
    status: [...document.querySelectorAll('[aria-label="Session status"]')].map((el) => el.textContent?.trim()),
  }));
  if (before.draft !== '' || !before.status.includes('Complete')) throw new Error('current_chat_not_safe_to_navigate');
  restoreChatId = before.current?.replace(/^chat-nav-row-/, '') ?? null;
  receipt.before = before;
  if (restoreChatId !== chatId) {
    await page.getByTestId(`chat-nav-row-${chatId}`).click({ timeout: 10_000 });
    await page.getByTestId(`chat-pane-${chatId}`).waitFor({ state: 'visible', timeout: 15_000 });
  }
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  if (!(await pane.isVisible())) throw new Error('source_chat_not_visible');
  receipt.stage = 'copy';
  for (const [kind, expected, label] of [
    ['writing', 'CH34_NATIVE_WRITING_7D2\nCopy me exactly.', 'text'],
    ['typescript', 'const ch34NativeSnippet = 42;', 'code'],
  ]) {
    const card = pane.locator(`[data-assistant-snippet="${kind}"]`).filter({ hasText: expected });
    if (await card.count() !== 1) throw new Error(`exact_${kind}_card_missing`);
    const button = card.getByRole('button', { name: `Copy ${label}`, exact: true });
    const observed = await button.evaluate((element) => {
      const labels = [{ label: element.getAttribute('aria-label'), time: performance.now() }];
      const observer = new MutationObserver(() => labels.push({ label: element.getAttribute('aria-label'), time: performance.now() }));
      observer.observe(element, { attributes: true, attributeFilter: ['aria-label'] });
      window.__ch34CopyObserve = { labels, observer };
      return { clipboardAvailable: Boolean(navigator.clipboard?.writeText), isSecureContext };
    });
    const started = Date.now();
    await button.click({ force: true, timeout: 15_000 });
    await page.waitForTimeout(250);
    observed.clickMs = Date.now() - started;
    observed.after = await page.evaluate(() => {
      const state = window.__ch34CopyObserve;
      state.observer.disconnect();
      return { labels: state.labels };
    });
    try {
      const clipboard = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
        { encoding: 'utf8', timeout: 4_000 });
      observed.after.clipboardMatch = clipboard.replace(/\r\n/g, '\n').trimEnd() === expected.trimEnd();
    } catch { observed.after.clipboardMatch = null; }
    receipt[kind] = observed;
  }
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(async () => {
  if (mainPage && restoreChatId && restoreChatId !== chatId) {
    try {
      await mainPage.getByTestId(`chat-nav-row-${restoreChatId}`).click({ timeout: 10_000 });
      receipt.restoredChat = restoreChatId;
    } catch (error) { receipt.restoreError = String(error?.message ?? error); }
  }
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});

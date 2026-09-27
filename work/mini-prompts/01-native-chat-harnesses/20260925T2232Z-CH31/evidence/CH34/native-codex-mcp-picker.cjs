'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const targetChatId = 'cht_-zkkf_r46zzuxB3L';
const sourceChatId = 'cht_lWazHd9Rnq8FPmHo';
const receipt = { at: new Date().toISOString(), stage: 'attach', targetChatId, sourceChatId,
  providerSend: false };
let browser;
let mainPage;
function check(ok, code) { if (!ok) throw new Error(code); }

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const pages = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  check(pages.length === 1, 'exact_native_main_required');
  const page = pages[0].page;
  mainPage = page;
  receipt.before = await page.evaluate(async ({ targetChatId, sourceChatId }) => {
    const [{ db, openDb }, { useUIStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
    await openDb();
    const target = await db.chats.get(targetChatId);
    const source = await db.chats.get(sourceChatId);
    const rows = await db.messages.where('chat_id').equals(targetChatId).toArray();
    return { activeChatId: useUIStore.getState().activeChatId, targetTitle: target?.title,
      sourceTitle: source?.title, targetProjectId: target?.project_id,
      targetBackend: target?.backend_affinity?.backend,
      targetUsers: rows.filter(row => row.role === 'user').length,
      targetAssistants: rows.filter(row => row.role === 'assistant').length };
  }, { targetChatId, sourceChatId });
  check(receipt.before.targetProjectId === 'prj_ybjv0yXnrGkGhAQY' &&
    receipt.before.targetBackend === 'codex', 'exact_codex_fixture_required');
  const nav = page.getByTestId(`chat-nav-row-${targetChatId}`).getByRole('button',
    { name: receipt.before.targetTitle, exact: true });
  receipt.stage = 'navigate';
  await nav.click({ timeout: 10000 });
  const pane = page.locator(`[data-testid="chat-pane-${targetChatId}"]`);
  await pane.waitFor({ state: 'visible', timeout: 20000 });
  const composer = pane.locator('[data-composer-input="true"]');
  receipt.initialDraft = await composer.inputValue();
  check(receipt.initialDraft === '', 'codex_fixture_draft_not_empty');
  receipt.targetRoute = await page.evaluate(async id => {
    const [{ db }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/auth.ts')]);
    const chat = await db.chats.get(id);
    const selection = useAuthStore.getState().chatModelSelection;
    return { backend: chat?.backend_affinity?.backend ?? null,
      selectedConnection: selection?.mode === 'single' ? selection.connectionId : null,
      selectedModel: selection?.mode === 'single' ? selection.modelId : null };
  }, targetChatId);
  receipt.stage = 'inspect-picker';
  await composer.click();
  await page.keyboard.type('/mcp');
  await page.waitForTimeout(350);
  receipt.picker = await page.evaluate(() => ({
    slashListVisible: Boolean(document.querySelector('[role="listbox"][aria-label="Slash commands"]')?.getBoundingClientRect().width),
    slashOptions: [...document.querySelectorAll('[role="option"]')]
      .filter(node => node.getBoundingClientRect().width > 0)
      .map(node => ({ text: node.textContent?.trim().slice(0, 160),
        value: node.getAttribute('data-value'), label: node.getAttribute('aria-label') })),
    mcpButtons: [...document.querySelectorAll('button')]
      .filter(node => node.getBoundingClientRect().width > 0 && /mcp/i.test(node.textContent ?? ''))
      .map(node => ({ text: node.textContent?.trim().slice(0, 160),
        label: node.getAttribute('aria-label') })).slice(-15),
  }));
  await composer.fill('');
  receipt.stage = 'restore';
  await page.getByTestId(`chat-nav-row-${sourceChatId}`).getByRole('button',
    { name: receipt.before.sourceTitle, exact: true }).click({ timeout: 10000 });
  receipt.passed = true;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    if (mainPage && receipt.before?.sourceTitle) {
      try {
        const source = mainPage.getByTestId(`chat-nav-row-${sourceChatId}`)
          .getByRole('button', { name: receipt.before.sourceTitle, exact: true });
        if (await source.count()) await source.click({ timeout: 10000 });
      } catch (error) { receipt.restoreFailure = String(error?.message ?? error); }
    }
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-codex-mcp-picker-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, picker: receipt.picker }));
    if (browser) await browser.close();
  });

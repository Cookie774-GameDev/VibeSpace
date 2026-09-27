'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_-zkkf_r46zzuxB3L';
(async () => {
  const receipt = { at: new Date().toISOString(), chatId, providerSend: false };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    const chat = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const row = await db.chats.get(id);
      return { title: row?.title, projectId: row?.project_id,
        backend: row?.backend_affinity?.backend, active: useUIStore.getState().activeChatId };
    }, chatId);
    if (chat.projectId !== 'prj_ybjv0yXnrGkGhAQY' || chat.backend !== 'codex')
      throw new Error('exact_codex_fixture_required');
    await page.getByTestId(`chat-nav-row-${chatId}`)
      .getByRole('button', { name: chat.title, exact: true }).click({ timeout: 15000 });
    const pane = page.locator(`[data-testid="chat-pane-${chatId}"]`);
    await pane.waitFor({ state: 'visible', timeout: 20000 });
    receipt.state = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const selection = useAuthStore.getState().chatModelSelection;
      return { activeChatId: useUIStore.getState().activeChatId,
        selection: selection?.mode === 'single' ? `${selection.connectionId}:${selection.modelId}` : null,
        status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
        effort: document.querySelector('[data-composer-effort]')?.getAttribute('data-composer-effort') ?? null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
        stopVisible: Boolean(document.querySelector('[aria-label="Stop current request"]')?.getBoundingClientRect().width),
        pendingQuestions: rows.flatMap(row => row.parts ?? []).filter(part =>
          part.kind === 'question_block' && part.status === 'pending').length,
        pendingPermissions: rows.flatMap(row => row.parts ?? []).filter(part =>
          part.kind === 'permission_request' && part.request?.status === 'pending').length,
        ids: rows.map(row => ({ id: row.id, role: row.role })) };
    }, chatId);
    receipt.passed = receipt.state.activeChatId === chatId &&
      receipt.state.selection === 'openai-codex:gpt-6-luna' &&
      receipt.state.status === 'Complete' && receipt.state.draft === '' &&
      !receipt.state.stopVisible && receipt.state.pendingQuestions === 0 &&
      receipt.state.pendingPermissions === 0;
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-codex-cancel-preflight-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      failure: receipt.failure, status: receipt.state?.status,
      selection: receipt.state?.selection, messages: receipt.state?.ids?.length }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

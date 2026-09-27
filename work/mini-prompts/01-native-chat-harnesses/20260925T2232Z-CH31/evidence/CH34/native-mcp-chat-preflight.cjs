'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 60000 });
  const receipt = { at: new Date().toISOString(), chatId, stage: 'attach', providerSend: false };
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    const page = main[0].page;
    const title = await page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      return (await db.chats.get(id))?.title ?? null;
    }, chatId);
    if (!title) throw new Error('target_chat_missing');
    receipt.stage = 'navigate';
    await page.getByTestId(`chat-nav-row-${chatId}`)
      .getByRole('button', { name: title, exact: true }).click({ timeout: 10000 });
    await page.locator(`[data-testid="chat-pane-${chatId}"]`).waitFor({ state: 'visible', timeout: 20000 });
    receipt.stage = 'inspect';
    receipt.state = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
      await openDb();
      const chat = await db.chats.get(id);
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const selection = useAuthStore.getState().chatModelSelection;
      return { activeChatId: useUIStore.getState().activeChatId,
        projectId: chat?.project_id ?? null, backend: chat?.backend_affinity?.backend ?? null,
        userCount: rows.filter(row => row.role === 'user').length,
        assistantCount: rows.filter(row => row.role === 'assistant').length,
        messageIds: rows.map(row => row.id),
        pendingPermissions: rows.flatMap(row => row.parts ?? []).filter(part =>
          part.kind === 'permission_request' && part.request?.status === 'pending').length,
        selection: selection?.mode === 'single' ? { providerId: selection.providerId,
          connectionId: selection.connectionId, modelId: selection.modelId } : null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
        selectedSkillText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null,
        status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
        accessButtons: [...document.querySelectorAll(`[data-testid="chat-pane-${id}"] button`)]
          .filter(node => /access|Ask|Plan|Review|Full/.test(node.textContent ?? '') && node.getBoundingClientRect().width > 0)
          .map(node => ({ text: node.textContent?.trim().slice(0, 100), label: node.getAttribute('aria-label') })).slice(-8),
      };
    }, chatId);
    receipt.passed = receipt.state.activeChatId === chatId &&
      receipt.state.projectId === 'prj_ybjv0yXnrGkGhAQY' &&
      receipt.state.backend === 'opencode' && receipt.state.draft === '' &&
      receipt.state.pendingPermissions === 0 && receipt.state.status === 'Complete';
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-mcp-chat-preflight-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false, state: receipt.state,
      failure: receipt.failure }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

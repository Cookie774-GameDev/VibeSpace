'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), chatId, stage: 'attach', providerSend: false };
  let page, input;
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async candidate => ({
      candidate, label: await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.candidate.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    page = main[0].candidate;
    receipt.before = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
      await openDb();
      const chat = await db.chats.get(id);
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const selection = useAuthStore.getState().chatModelSelection;
      return { activeChatId: useUIStore.getState().activeChatId,
        projectId: chat?.project_id ?? null, backend: chat?.backend_affinity?.backend ?? null,
        messageIds: rows.map(row => row.id),
        selection: selection?.mode === 'single' ? { connectionId: selection.connectionId,
          modelId: selection.modelId } : null,
        status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null };
    }, chatId);
    if (receipt.before.activeChatId !== chatId || receipt.before.projectId !== 'prj_ybjv0yXnrGkGhAQY' ||
      receipt.before.backend !== 'opencode' || receipt.before.selection?.connectionId !== 'opencode-cli' ||
      receipt.before.selection?.modelId !== 'openai/gpt-6-luna' || receipt.before.status !== 'Complete' ||
      receipt.before.draft !== '') throw new Error('exact_idle_opencode_fixture_required');
    input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
    receipt.stage = 'open-picker';
    await input.click();
    await page.keyboard.type('$');
    const list = page.getByRole('listbox', { name: 'OpenCode skills', exact: true });
    await list.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[role="listbox"][aria-label="OpenCode skills"] [role="option"]'));
    receipt.options = await list.locator('[role="option"]').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent?.trim().slice(0, 200), disabled: node.getAttribute('aria-disabled'),
    })));
    receipt.availableOpenCode = receipt.options.filter(row => row.text.includes('OpenCode') && row.disabled !== 'true').length;
    receipt.availableCodexOrigin = receipt.options.filter(row => row.text.includes('Codex origin') && row.disabled !== 'true').length;
    await input.fill('');
    receipt.stage = 'verify-no-send';
    receipt.after = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { activeChatId: useUIStore.getState().activeChatId, messageIds: rows.map(row => row.id),
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null };
    }, chatId);
    receipt.passed = receipt.availableOpenCode > 0 && receipt.availableCodexOrigin > 0 &&
      receipt.after.activeChatId === chatId && receipt.after.draft === '' &&
      receipt.after.messageIds.length === receipt.before.messageIds.length &&
      receipt.after.messageIds.every((id, i) => id === receipt.before.messageIds[i]);
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    if (input) try { await input.fill(''); } catch { /* Preserve primary receipt. */ }
    const output = path.join(__dirname, `native-opencode-skill-origins-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      availableOpenCode: receipt.availableOpenCode, availableCodexOrigin: receipt.availableCodexOrigin,
      failure: receipt.failure }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

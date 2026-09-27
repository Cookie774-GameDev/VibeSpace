'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_-zkkf_r46zzuxB3L';
const originalChatId = 'cht_lWazHd9Rnq8FPmHo';
const guardPath = path.join(__dirname, 'codex-mcp-status-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, originalChatId,
  providerSend: false, stage: 'attach' };
let browser, page;
function check(ok, code) { if (!ok) throw new Error(code); }
async function snapshot() {
  return page.evaluate(async id => {
    const [{ db, openDb }, { useUIStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    return { activeChatId: useUIStore.getState().activeChatId,
      projectId: chat?.project_id ?? null, title: chat?.title ?? null,
      backend: chat?.backend_affinity?.backend ?? null,
      messages: rows.map(row => ({ id: row.id, role: row.role,
        text: (row.parts ?? []).filter(part => part.kind === 'text')
          .map(part => part.text).join('\n').slice(0, 800),
        localReceipt: (row.parts ?? []).some(part => JSON.stringify(part).includes('codex-mcp-status')) })),
      draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
    };
  }, chatId);
}
(async () => {
  check(!fs.existsSync(guardPath), 'status_attempt_exists_reconcile_only');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async candidate => ({
    candidate, label: await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labeled.filter(item => item.label === 'main' && item.candidate.url().startsWith('http://localhost:5173/'));
  check(main.length === 1, 'exact_official_main_required');
  page = main[0].candidate;
  receipt.initial = await snapshot();
  check(receipt.initial.activeChatId === originalChatId &&
    receipt.initial.projectId === 'prj_ybjv0yXnrGkGhAQY' &&
    receipt.initial.backend === 'codex' && receipt.initial.messages.length === 2 &&
    receipt.initial.messages.filter(row => row.role === 'user').length === 1 &&
    receipt.initial.messages.filter(row => row.role === 'assistant').length === 0,
  'exact_codex_fixture_state_required');
  const original = await page.evaluate(async id => {
    const { db } = await import('/src/lib/db/database.ts');
    return (await db.chats.get(id))?.title ?? null;
  }, originalChatId);
  receipt.originalTitle = original;
  receipt.stage = 'navigate';
  await page.getByTestId(`chat-nav-row-${chatId}`)
    .getByRole('button', { name: receipt.initial.title, exact: true }).click({ timeout: 10000 });
  const pane = page.locator(`[data-testid="chat-pane-${chatId}"]`);
  await pane.waitFor({ state: 'visible', timeout: 20000 });
  const composer = pane.locator('[data-composer-input="true"]');
  const before = await snapshot();
  check(before.draft === '' && before.messages.length === receipt.initial.messages.length &&
    before.messages.every((row, i) => row.id === receipt.initial.messages[i].id),
  'codex_chat_changed_before_status');
  receipt.stage = 'choose-native-command';
  await composer.click();
  await page.keyboard.type('/mcp');
  const option = page.locator('[role="listbox"][aria-label="Slash commands"] [role="option"][data-value="codex:app-server:mcp"]');
  await option.waitFor({ state: 'visible', timeout: 10000 });
  receipt.options = await page.locator('[role="listbox"][aria-label="Slash commands"] [role="option"]')
    .evaluateAll(nodes => nodes.map(node => ({ value: node.getAttribute('data-value'),
      text: node.textContent?.trim().slice(0, 140) })));
  check(receipt.options.some(row => row.value === 'vibespace:vibespace:mcp'),
    'mcp_collision_option_missing');
  fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    command: 'codex:app-server:mcp', beforeMessageIds: before.messages.map(row => row.id) }, null, 2) + '\n', { flag: 'wx' });
  await option.click({ timeout: 10000 });
  receipt.stage = 'wait-local-result';
  await page.waitForFunction(async ({ id, previousIds }) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const fresh = rows.filter(row => !previousIds.includes(row.id));
    return fresh.some(row => row.role === 'user' && row.parts?.some(part =>
      part.kind === 'text' && part.text === '/mcp')) &&
      fresh.some(row => row.role === 'system' && row.parts?.some(part =>
        part.kind === 'text' && /Codex (MCP servers|has no configured MCP servers)/.test(part.text)));
  }, { id: chatId, previousIds: before.messages.map(row => row.id) }, { timeout: 30000 });
  receipt.after = await snapshot();
  const fresh = receipt.after.messages.filter(row => !before.messages.some(old => old.id === row.id));
  receipt.fresh = fresh;
  check(fresh.filter(row => row.role === 'user' && row.text === '/mcp').length === 1 &&
    fresh.filter(row => row.role === 'system' && /Codex (MCP servers|has no configured MCP servers)/.test(row.text)).length === 1 &&
    fresh.filter(row => row.role === 'assistant').length === 0 &&
    fresh.some(row => row.localReceipt) && receipt.after.draft === '',
  'codex_local_mcp_status_not_proven');
  receipt.stage = 'complete'; receipt.passed = true;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    if (page && receipt.originalTitle) {
      try { await page.getByTestId(`chat-nav-row-${originalChatId}`)
        .getByRole('button', { name: receipt.originalTitle, exact: true }).click({ timeout: 10000 }); }
      catch (error) { receipt.restoreFailure = String(error?.message ?? error); }
    }
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-codex-mcp-status-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, fresh: receipt.fresh }));
    if (browser) await browser.close();
  });

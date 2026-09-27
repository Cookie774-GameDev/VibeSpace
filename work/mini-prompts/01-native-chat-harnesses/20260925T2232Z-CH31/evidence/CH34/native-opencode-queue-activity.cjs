'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const chatId = 'cht_Eumzyw1Y8yx21W1s';
const assistantId = 'msg_jreq_59355a0b-b8f1-4cc0-b469-c0ce8f3d4ca3';
const receipt = { at: new Date().toISOString(), chatId, assistantId, stage: 'attach', readOnly: true };
let browser;

async function inspect(page) {
  return page.evaluate(async ({ chatId, assistantId }) => {
    const [{ db, openDb }, { useUIStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
    await openDb();
    const row = await db.messages.get(assistantId);
    const chatRows = await db.messages.where('chat_id').equals(chatId).toArray();
    const matching = chatRows.filter(item => item.id === assistantId);
    const toolParts = (row?.parts ?? []).filter(part => part.kind === 'tool_call');
    const consoleRoot = document.querySelector(`[data-agentic-console][data-chat-id="${chatId}"]`);
    return {
      activeChatId: useUIStore.getState().activeChatId,
      assistantCount: matching.length,
      toolParts: toolParts.map(part => ({ id: part.call_id ?? part.id ?? null,
        tool: part.tool ?? part.name ?? null, status: part.status ?? null,
        args: part.args ?? null, result: part.result ?? null, error: part.error ?? null })),
      consoleVisible: Boolean(consoleRoot?.getBoundingClientRect().width),
      disclosures: [...(consoleRoot?.querySelectorAll('.assistant-activity-ledger__disclosure') ?? [])]
        .map((node, index) => ({ index, text: node.textContent?.trim().slice(0, 140),
          expanded: node.getAttribute('aria-expanded') })),
      receipts: [...(consoleRoot?.querySelectorAll('[data-testid="activity-ledger-receipt"]') ?? [])]
        .map(node => ({ text: node.textContent?.trim().slice(0, 450),
          status: node.getAttribute('data-receipt-status'),
          tools: [...node.querySelectorAll('[data-receipt-tool]')].map(t => t.getAttribute('data-receipt-tool')),
          ids: [...node.querySelectorAll('[data-receipt-call-id]')].map(t => t.getAttribute('data-receipt-call-id')) })),
    };
  }, { chatId, assistantId });
}

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(context => context.pages())
    .map(async page => ({ page, label: await page.evaluate(() =>
      window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const mains = labeled.filter(item => item.label === 'main' &&
    item.page.url().startsWith('http://localhost:5173/'));
  if (mains.length !== 1) throw new Error('exact_official_main_required');
  const page = mains[0].page;
  receipt.before = await inspect(page);
  if (receipt.before.activeChatId !== chatId || receipt.before.assistantCount !== 1 ||
    receipt.before.toolParts.length !== 1 || receipt.before.toolParts[0].tool !== 'read')
    throw new Error('exact_completed_read_fixture_required');
  const root = page.locator(`[data-agentic-console][data-chat-id="${chatId}"]`);
  await root.waitFor({ state: 'visible', timeout: 10000 });
  const buttons = root.getByRole('button', { name: /Show activity details/i });
  receipt.stage = 'expand';
  receipt.disclosureCount = await buttons.count();
  for (let index = 0; index < receipt.disclosureCount; index++) {
    const button = root.getByRole('button', { name: /Show activity details/i }).first();
    if (!await button.count()) break;
    await button.click({ timeout: 10000 });
  }
  receipt.expanded = await inspect(page);
  receipt.stage = 'reload';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await root.waitFor({ state: 'visible', timeout: 30000 });
  receipt.afterReload = await inspect(page);
  for (let index = 0; index < receipt.disclosureCount; index++) {
    const button = root.getByRole('button', { name: /Show activity details/i }).first();
    if (!await button.count()) break;
    await button.click({ timeout: 10000 });
  }
  receipt.reopened = await inspect(page);
  const toolReceipt = state => state.receipts.filter(item => item.tools.includes('read'));
  receipt.passed = receipt.expanded.assistantCount === 1 &&
    receipt.afterReload.assistantCount === 1 && receipt.reopened.assistantCount === 1 &&
    receipt.reopened.toolParts.length === 1 &&
    toolReceipt(receipt.expanded).length >= 1 && toolReceipt(receipt.reopened).length >= 1 &&
    receipt.reopened.activeChatId === chatId;
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-queue-activity-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, disclosures: receipt.disclosureCount,
      expandedRead: receipt.expanded?.receipts?.filter(item => item.tools.includes('read')).length,
      reopenedRead: receipt.reopened?.receipts?.filter(item => item.tools.includes('read')).length }));
    if (browser) await browser.close();
  });

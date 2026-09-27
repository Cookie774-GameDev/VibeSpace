'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const assistantId = 'msg_jreq_59355a0b-b8f1-4cc0-b469-c0ce8f3d4ca3';
(async () => {
  const receipt = { at: new Date().toISOString(), chatId, assistantId,
    mode: 'read-only reconciliation of earlier native reload', providerSend: false };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    const root = page.locator(`[data-agentic-console][data-chat-id="${chatId}"]`);
    await root.waitFor({ state: 'visible', timeout: 20000 });
    receipt.before = await page.evaluate(async ({ chatId, assistantId }) => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(chatId).toArray();
      const message = rows.find(row => row.id === assistantId);
      const toolParts = (message?.parts ?? []).filter(part => part.kind === 'tool_call');
      return { activeChatId: useUIStore.getState().activeChatId,
        assistantCount: rows.filter(row => row.id === assistantId).length,
        userCount: rows.filter(row => row.role === 'user').length,
        totalMessages: rows.length,
        toolParts: toolParts.map(part => ({ id: part.call_id ?? part.id ?? null,
          tool: part.tool ?? part.name ?? null, args: part.args ?? null })) };
    }, { chatId, assistantId });
    if (receipt.before.activeChatId !== chatId || receipt.before.assistantCount !== 1 ||
      receipt.before.toolParts.length !== 1 || receipt.before.toolParts[0].tool !== 'read')
      throw new Error('exact_post_reload_read_fixture_required');
    const disclosure = root.locator('.assistant-activity-ledger__disclosure').filter({ hasText: 'Read 1' });
    receipt.disclosureCount = await disclosure.count();
    if (receipt.disclosureCount !== 1) throw new Error('exact_read_disclosure_required');
    if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click({ timeout: 10000 });
    receipt.activity = await page.evaluate(id => {
      const root = document.querySelector(`[data-agentic-console][data-chat-id="${id}"]`);
      const rows = [...(root?.querySelectorAll('[data-testid="activity-ledger-receipt"]') ?? [])];
      return { disclosures: root?.querySelectorAll('.assistant-activity-ledger__disclosure').length,
        readRows: rows.filter(row => row.querySelector('[data-receipt-tool="read"]'))
          .map(row => ({ status: row.getAttribute('data-receipt-status'),
            text: row.textContent?.trim().slice(0, 1000),
            tool: row.querySelector('[data-receipt-tool]')?.getAttribute('data-receipt-tool'),
            callId: row.querySelector('[data-receipt-call-id]')?.getAttribute('data-receipt-call-id') })),
        detailText: [...(root?.querySelectorAll('.assistant-activity-ledger__inspector') ?? [])]
          .filter(node => node.textContent?.includes('Tool: read'))
          .map(node => node.textContent?.trim().slice(0, 2000)) };
    }, chatId);
    receipt.passed = receipt.activity.readRows.length === 1 &&
      receipt.activity.readRows[0].status === 'done' &&
      receipt.before.userCount === 9;
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-queue-activity-reconcile-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      failure: receipt.failure, readRows: receipt.activity?.readRows?.length,
      status: receipt.activity?.readRows?.[0]?.status }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

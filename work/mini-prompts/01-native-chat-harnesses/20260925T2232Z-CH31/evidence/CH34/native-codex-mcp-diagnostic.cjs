'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_-zkkf_r46zzuxB3L';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), chatId, readOnly: true,
    priorAttempt: 'native-codex-mcp-status-1790516202244.json' };
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_native_main_required');
    const page = main[0].page;
    receipt.persisted = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { activeChatId: useUIStore.getState().activeChatId,
        rows: rows.map(row => ({ id: row.id, role: row.role,
          createdAt: row.created_at, localReceipt: (row.parts ?? []).some(part =>
            JSON.stringify(part).includes('codex-mcp-status')),
          text: (row.parts ?? []).filter(part => part.kind === 'text')
            .map(part => part.text).join('\n').slice(0, 900) })),
        visibleErrors: [...document.querySelectorAll('[role="alert"]')]
          .filter(node => node.getBoundingClientRect().width > 0)
          .map(node => node.textContent?.trim().slice(0, 250)).slice(-5) };
    }, chatId);
    if (process.argv[2] !== '--reconcile-only') receipt.nativeCall = await page.evaluate(async () => {
      const { codexPersistentAdapter } = await import('/src/lib/ai/adapters/codexPersistent.ts');
      const start = performance.now();
      try {
        const servers = await codexPersistentAdapter.listMcpServerStatus();
        return { ok: true, elapsedMs: Math.round(performance.now() - start),
          servers: servers.map(server => ({ name: server.name,
            runtimeStatus: server.runtimeStatus ?? null })) };
      } catch (error) {
        return { ok: false, elapsedMs: Math.round(performance.now() - start),
          error: String(error?.message ?? error).slice(0, 600) };
      }
    });
    if (process.argv[2] === '--reconcile-only') {
      const rows = receipt.persisted.rows;
      receipt.passed = rows.filter(row => row.role === 'user' && row.text === '/mcp' && row.localReceipt).length === 1 &&
        rows.filter(row => row.role === 'system' && row.text.startsWith('Codex MCP servers:')).length === 1 &&
        rows.filter(row => row.role === 'assistant').length === 0;
      if (!receipt.passed) throw new Error('native_mcp_local_status_not_reconciled');
    }
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-mcp-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, nativeCall: receipt.nativeCall, failure: receipt.failure }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

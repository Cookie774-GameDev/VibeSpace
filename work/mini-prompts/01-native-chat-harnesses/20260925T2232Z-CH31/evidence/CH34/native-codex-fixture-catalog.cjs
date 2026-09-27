'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const receipt = { at: new Date().toISOString(), readOnly: true };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    receipt.chats = await mains[0].page.evaluate(async () => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const all = await db.chats.toArray();
      const project = all.filter(row => row.project_id === 'prj_ybjv0yXnrGkGhAQY' &&
        row.backend_affinity?.backend === 'codex');
      return Promise.all(project.map(async row => {
        const messages = await db.messages.where('chat_id').equals(row.id).toArray();
        return { id: row.id, title: row.title?.slice(0, 80),
          archived: row.archived ?? false,
          connection: `${row.connection?.id}:${row.connection?.modelId}`,
          users: messages.filter(item => item.role === 'user').length,
          pendingQuestions: messages.flatMap(item => item.parts ?? []).filter(part =>
            part.kind === 'question_block' && part.block?.status === 'pending').length,
          pendingPermissions: messages.flatMap(item => item.parts ?? []).filter(part =>
            part.kind === 'permission_request' && part.request?.status === 'pending').length };
      }));
    });
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-fixture-catalog-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, chats: receipt.chats, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

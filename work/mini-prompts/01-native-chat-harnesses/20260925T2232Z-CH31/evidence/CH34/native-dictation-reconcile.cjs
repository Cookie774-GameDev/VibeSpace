'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const expectedHash = '14ce51e158699d27201943fe2bcf58c194f3985379b7ba465ac605db3082bebd';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 60000 });
  const receipt = { at: new Date().toISOString(), chatId, readOnly: true,
    purpose: 'reconcile guarded skill-send attempt while main target is unresponsive' };
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const dictation = labeled.filter(item => item.label === 'dictation');
    if (dictation.length !== 1) throw new Error('exact_native_dictation_target_required');
    receipt.state = await dictation[0].page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { count: rows.length, users: rows.filter(row => row.role === 'user').length,
        assistants: rows.filter(row => row.role === 'assistant').length,
        messages: rows.map(row => ({ id: row.id, role: row.role,
          text: (row.parts ?? []).filter(part => part.kind === 'text')
            .map(part => part.text).join('\n').slice(0, 500),
          toolNames: (row.parts ?? []).filter(part => part.kind === 'tool_call')
            .map(part => part.tool ?? part.name ?? null) })) };
    }, chatId);
    receipt.expectedPromptMatches = receipt.state.messages.filter(row => row.role === 'user' &&
      crypto.createHash('sha256').update(row.text).digest('hex') === expectedHash).length;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-dictation-reconcile-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, count: receipt.state?.count,
      users: receipt.state?.users, assistants: receipt.state?.assistants,
      expectedPromptMatches: receipt.expectedPromptMatches, failure: receipt.failure }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

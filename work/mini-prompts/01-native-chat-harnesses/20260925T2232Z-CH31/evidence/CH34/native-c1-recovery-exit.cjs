'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const promptHash = '14ce51e158699d27201943fe2bcf58c194f3985379b7ba465ac605db3082bebd';
const guardPath = path.join(__dirname, 'c1-recovery-exit-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, reason: 'main renderer unresponsive; same-process recovery',
  expectedPromptHash: promptHash, exitRequested: false };
let browser;
(async () => {
  if (fs.existsSync(guardPath)) throw new Error('recovery_exit_already_attempted');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 60000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const dictation = labeled.filter(item => item.label === 'dictation');
  if (dictation.length !== 1) throw new Error('exact_native_dictation_target_required');
  const page = dictation[0].page;
  receipt.before = await page.evaluate(async id => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    return { users: rows.filter(row => row.role === 'user').length,
      assistants: rows.filter(row => row.role === 'assistant').length,
      userTexts: rows.filter(row => row.role === 'user')
        .map(row => (row.parts ?? []).filter(part => part.kind === 'text')
          .map(part => part.text).join('\n')) };
  }, chatId);
  receipt.promptMatches = receipt.before.userTexts.filter(text =>
    crypto.createHash('sha256').update(text).digest('hex') === promptHash).length;
  if (receipt.before.users !== 6 || receipt.before.assistants !== 9 || receipt.promptMatches !== 0)
    throw new Error('guarded_prompt_state_changed');
  delete receipt.before.userTexts;
  fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    expectedUsers: 6, expectedAssistants: 9, promptMatches: 0, processPid: 36580 }, null, 2) + '\n', { flag: 'wx' });
  receipt.exitRequested = true;
  try { await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:process|exit', { code: 0 })); }
  catch (error) { receipt.exitObservation = String(error?.message ?? error).slice(0, 300); }
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-c1-recovery-exit-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, exitRequested: receipt.exitRequested,
      before: receipt.before, promptMatches: receipt.promptMatches,
      exitObservation: receipt.exitObservation, failure: receipt.failure }));
    if (browser) await browser.close().catch(() => {});
  });

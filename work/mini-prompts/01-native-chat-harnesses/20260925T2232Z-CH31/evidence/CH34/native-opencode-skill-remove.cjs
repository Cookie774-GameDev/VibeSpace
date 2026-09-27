'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const skillName = 'ch31-codex-secondary';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 30000 });
  const receipt = { at: new Date().toISOString(), chatId, skillName, providerSend: false };
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    const page = main[0].page;
    const inspect = () => page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { activeChatId: useUIStore.getState().activeChatId,
        messageIds: rows.map(row => row.id),
        selectedSkillText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null };
    }, chatId);
    receipt.before = await inspect();
    if (receipt.before.activeChatId !== chatId ||
      !receipt.before.selectedSkillText?.includes(`${skillName}Codex · Selected`) ||
      receipt.before.draft !== '') throw new Error('exact_selected_skill_required');
    await page.getByRole('button', { name: `Remove $${skillName}`, exact: true }).click({ timeout: 10000 });
    receipt.after = await inspect();
    receipt.passed = receipt.after.selectedSkillText == null && receipt.after.draft === '' &&
      receipt.after.messageIds.length === receipt.before.messageIds.length &&
      receipt.after.messageIds.every((id, i) => id === receipt.before.messageIds[i]);
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-opencode-skill-remove-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, passed: receipt.passed ?? false,
      failure: receipt.failure, after: receipt.after }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

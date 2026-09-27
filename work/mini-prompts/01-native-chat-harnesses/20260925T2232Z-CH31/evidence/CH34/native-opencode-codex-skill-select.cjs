'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const skillName = 'ch31-codex-secondary';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), chatId, skillName, providerSend: false, stage: 'attach' };
  let input;
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    const page = main[0].page;
    receipt.before = await page.evaluate(async id => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const selection = useAuthStore.getState().chatModelSelection;
      return { activeChatId: useUIStore.getState().activeChatId, messageIds: rows.map(row => row.id),
        route: selection?.mode === 'single' ? `${selection.connectionId}:${selection.modelId}` : null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
        selectedGroupText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null };
    }, chatId);
    if (receipt.before.activeChatId !== chatId || receipt.before.route !== 'opencode-cli:openai/gpt-6-luna' ||
      receipt.before.draft !== '' || receipt.before.selectedGroupText?.includes(skillName))
      throw new Error('exact_skill_select_precondition_required');
    input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
    receipt.stage = 'choose-skill';
    await input.click();
    await page.keyboard.type(`$${skillName}`);
    const list = page.getByRole('listbox', { name: 'OpenCode skills', exact: true });
    await list.waitFor({ state: 'visible', timeout: 20000 });
    const option = list.getByRole('option', { name: new RegExp(`\\$${skillName}`, 'i') });
    await option.waitFor({ state: 'visible', timeout: 10000 });
    receipt.option = await option.textContent();
    if (!receipt.option?.includes('Codex origin')) throw new Error('codex_origin_not_displayed');
    await option.click({ timeout: 10000 });
    await page.getByLabel('Selected native CLI skills', { exact: true })
      .getByText(`$${skillName}`, { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    receipt.stage = 'verify-chip';
    receipt.after = await page.evaluate(async id => {
      const { db, openDb } = await import('/src/lib/db/database.ts');
      await openDb();
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { messageIds: rows.map(row => row.id),
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
        selectedGroupText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null };
    }, chatId);
    receipt.passed = receipt.after.selectedGroupText?.includes(`$${skillName}`) &&
      receipt.after.selectedGroupText?.includes('Codex · Selected') &&
      receipt.after.messageIds.length === receipt.before.messageIds.length &&
      receipt.after.messageIds.every((id, i) => id === receipt.before.messageIds[i]);
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-opencode-codex-skill-select-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, after: receipt.after }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

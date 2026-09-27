'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sourceId = 'cht_Eumzyw1Y8yx21W1s';
const otherId = 'cht_lWazHd9Rnq8FPmHo';
const skillName = 'ch31-codex-secondary';
const marker = 'CH31_CODEX_SECONDARY_54F8';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 30000 });
  const receipt = { at: new Date().toISOString(), sourceId, otherId, skillName,
    stage: 'attach', readOnly: true, providerSend: false };
  try {
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    const page = main[0].page;
    const snapshot = id => page.evaluate(async ({ id, marker }) => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts')]);
      await openDb();
      const chat = await db.chats.get(id);
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      const assistant = rows.find(row => row.role === 'assistant' &&
        (row.parts ?? []).some(part => part.kind === 'text' && part.text?.includes(marker)));
      const calls = (assistant?.parts ?? []).filter(part => part.kind === 'tool_call')
        .map(part => ({ tool: part.tool, callId: part.call_id,
          args: JSON.stringify(part.args ?? {}).slice(0, 500) }));
      const results = (assistant?.parts ?? []).filter(part => part.kind === 'tool_result')
        .map(part => ({ callId: part.call_id, status: part.result?.status ?? null,
          markerInResult: JSON.stringify(part.result ?? {}).includes(marker) }));
      return { activeChatId: useUIStore.getState().activeChatId, title: chat?.title ?? null,
        messageIds: rows.map(row => row.id),
        users: rows.filter(row => row.role === 'user').length,
        assistants: rows.filter(row => row.role === 'assistant').length,
        selectedSkillText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null,
        draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
        assistantId: assistant?.id ?? null, calls, results };
    }, { id, marker });
    receipt.sourceBefore = await snapshot(sourceId);
    if (receipt.sourceBefore.activeChatId !== sourceId ||
      !receipt.sourceBefore.selectedSkillText?.includes(`${skillName}Codex · Selected`) ||
      receipt.sourceBefore.users !== 7 || receipt.sourceBefore.assistants !== 10 ||
      receipt.sourceBefore.calls.filter(call => call.tool === 'skill' && call.args.includes(skillName)).length !== 1)
      throw new Error('actual_codex_origin_skill_load_not_found');
    const otherTitle = await page.evaluate(async id => {
      const { db } = await import('/src/lib/db/database.ts');
      return (await db.chats.get(id))?.title ?? null;
    }, otherId);
    if (!otherTitle) throw new Error('other_chat_missing');
    receipt.stage = 'switch-other';
    await page.getByTestId(`chat-nav-row-${otherId}`).getByRole('button',
      { name: otherTitle, exact: true }).click({ timeout: 10000 });
    await page.locator(`[data-testid="chat-pane-${otherId}"]`).waitFor({ state: 'visible', timeout: 15000 });
    receipt.other = await snapshot(otherId);
    receipt.stage = 'return-source';
    await page.getByTestId(`chat-nav-row-${sourceId}`).getByRole('button',
      { name: receipt.sourceBefore.title, exact: true }).click({ timeout: 10000 });
    await page.locator(`[data-testid="chat-pane-${sourceId}"]`).waitFor({ state: 'visible', timeout: 15000 });
    receipt.sourceAfter = await snapshot(sourceId);
    receipt.passed = receipt.other.activeChatId === otherId &&
      !receipt.other.selectedSkillText?.includes(skillName) &&
      receipt.sourceAfter.activeChatId === sourceId &&
      receipt.sourceAfter.selectedSkillText?.includes(`${skillName}Codex · Selected`) &&
      receipt.sourceAfter.messageIds.length === receipt.sourceBefore.messageIds.length &&
      receipt.sourceAfter.messageIds.every((id, i) => id === receipt.sourceBefore.messageIds[i]);
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-opencode-skill-isolation-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, sourceCalls: receipt.sourceBefore?.calls,
      otherSelectedSkill: receipt.other?.selectedSkillText }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

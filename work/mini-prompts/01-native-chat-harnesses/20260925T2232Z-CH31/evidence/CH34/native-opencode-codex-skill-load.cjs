'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const skillName = 'ch31-codex-secondary';
const marker = 'CH31_CODEX_SECONDARY_54F8';
const prompt = `$${skillName} Use the selected native skill through the native skill tool. State the exact marker it instructs you to report. Do not edit files, run shell commands, or browse.`;
const promptSha256 = crypto.createHash('sha256').update(prompt).digest('hex');
const guardPath = path.join(__dirname, 'opencode-codex-skill-load-send-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, skillName, promptSha256,
  stage: 'attach', providerSendAttempted: false };
let browser;
async function snapshot(page) {
  return page.evaluate(async id => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const selection = useAuthStore.getState().chatModelSelection;
    return { activeChatId: useUIStore.getState().activeChatId,
      route: selection?.mode === 'single' ? `${selection.connectionId}:${selection.modelId}` : null,
      status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
      selectedSkillText: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null,
      users: rows.filter(row => row.role === 'user').length,
      assistants: rows.filter(row => row.role === 'assistant').length,
      messages: rows.map(row => ({ id: row.id, role: row.role,
        text: (row.parts ?? []).filter(part => part.kind === 'text')
          .map(part => part.text).join('\n').slice(0, 500),
        tools: (row.parts ?? []).filter(part => part.kind === 'tool_call' || part.kind === 'tool_result')
          .map(part => ({ kind: part.kind, name: part.tool ?? part.name ?? null,
            callId: part.call_id ?? part.callId ?? null, status: part.result?.status ?? part.status ?? null })),
        errors: (row.parts ?? []).filter(part => part.kind === 'provider_error')
          .map(part => part.error?.code ?? null) })),
    };
  }, chatId);
}
(async () => {
  const resume = process.argv[2] === '--resume-after-restart';
  if (resume) {
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    if (guard.chatId !== chatId || guard.promptSha256 !== promptSha256 ||
      guard.beforeIds.length !== 16) throw new Error('exact_prior_send_guard_required');
    receipt.resumedFrom = 'native-opencode-codex-skill-load-1790516889570.json';
    receipt.recoveredC1 = 'native-c1-recovery-relaunch-20260927T135455349Z.json';
  } else if (fs.existsSync(guardPath)) throw new Error('skill_load_attempt_exists_reconcile_only');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  if (main.length !== 1) throw new Error('exact_official_main_required');
  const page = main[0].page;
  const before = await snapshot(page);
  receipt.before = { ...before, messages: before.messages.map(row => ({ id: row.id, role: row.role })) };
  if (before.activeChatId !== chatId || before.route !== 'opencode-cli:openai/gpt-6-luna' ||
    before.status !== 'Complete' || before.draft !== (resume ? prompt : `$${skillName} `) ||
    !before.selectedSkillText?.includes(`$${skillName}`) ||
    !before.selectedSkillText?.includes('Codex · Selected') ||
    before.users !== 6 || before.assistants !== 9)
    throw new Error('exact_selected_skill_fixture_required');
  receipt.stage = 'send-once';
  const input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
  if (!resume) await input.fill(prompt, { timeout: 10000 });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  if (await send.count() !== 1 || !await send.isEnabled()) throw new Error('native_send_unavailable');
  if (!resume) fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256, beforeIds: before.messages.map(row => row.id), status: 'before-send' }, null, 2) + '\n', { flag: 'wx' });
  receipt.providerSendAttempted = true;
  await send.click({ timeout: 10000, force: resume });
  receipt.stage = 'observe';
  const deadline = Date.now() + 120000;
  let current;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    current = await snapshot(page);
    const fresh = current.messages.filter(row => !before.messages.some(old => old.id === row.id));
    if (current.activeChatId !== chatId) throw new Error('chat_switched_during_skill_turn');
    if (fresh.some(row => row.role === 'user') && ['Complete', 'Failed', 'Cancelled'].includes(current.status)) break;
  }
  receipt.after = current && { ...current,
    messages: current.messages.filter(row => !before.messages.some(old => old.id === row.id)) };
  const fresh = receipt.after?.messages ?? [];
  receipt.toolNames = fresh.flatMap(row => row.tools.filter(tool => tool.kind === 'tool_call').map(tool => tool.name));
  receipt.markerInAssistant = fresh.some(row => row.role === 'assistant' && row.text.includes(marker));
  receipt.passed = receipt.after?.status === 'Complete' &&
    receipt.after.users === before.users + 1 && receipt.after.assistants >= before.assistants + 1 &&
    receipt.toolNames.includes('skill') && receipt.markerInAssistant &&
    !receipt.toolNames.some(name => /^(bash|shell|apply_patch|edit|write)$/i.test(name ?? ''));
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-codex-skill-load-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      status: receipt.after?.status, toolNames: receipt.toolNames, markerInAssistant: receipt.markerInAssistant,
      failure: receipt.failure }));
    if (browser) await browser.close();
  });

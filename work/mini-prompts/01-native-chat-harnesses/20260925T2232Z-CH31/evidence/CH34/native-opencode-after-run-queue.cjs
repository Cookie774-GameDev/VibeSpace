'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const chatId = 'cht_Eumzyw1Y8yx21W1s';
const primary = 'Use one native read tool to read D:/VibeSpace-Testing/Chat01-CH31-fixtures/native-d-marker.txt. Report its exact marker and the tool name. Do not edit files or run shell commands.';
const queued = 'After that reply completes, respond with exactly CH34_QUEUE_FOLLOWUP_7A31. Use no tools and make no edits.';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const primaryGuard = path.join(__dirname, 'opencode-queue-primary-send-attempt.json');
const queueGuard = path.join(__dirname, 'opencode-queue-followup-enqueue-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, primarySha256: hash(primary),
  queuedSha256: hash(queued), stage: 'attach', primarySendAttempted: false,
  queueAttempted: false };
let browser;
async function snapshot(page) {
  return page.evaluate(async id => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts')]);
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const selection = useAuthStore.getState().chatModelSelection;
    return { activeChatId: useUIStore.getState().activeChatId,
      selection: selection?.mode === 'single' ? `${selection.connectionId}:${selection.modelId}` : null,
      status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
      selectedSkills: document.querySelector('[aria-label="Selected native CLI skills"]')?.textContent?.trim() ?? null,
      queueRows: [...document.querySelectorAll('[data-queued-message-id]')].map(node => ({
        id: node.getAttribute('data-queued-message-id'), text: node.querySelector('.queue-message-text')?.textContent?.trim() ?? null,
        steerLabel: node.querySelector('.queue-steer')?.getAttribute('aria-label') ?? null })),
      stopVisible: Boolean(document.querySelector('[aria-label="Stop current request"]')?.getBoundingClientRect().width),
      messages: rows.map(row => ({ id: row.id, role: row.role, createdAt: row.created_at,
        text: (row.parts ?? []).filter(part => part.kind === 'text')
          .map(part => part.text).join('\n').slice(0, 500),
        tools: (row.parts ?? []).filter(part => part.kind === 'tool_call')
          .map(part => part.tool ?? part.name ?? null) })),
    };
  }, chatId);
}
(async () => {
  if (fs.existsSync(primaryGuard) || fs.existsSync(queueGuard))
    throw new Error('queue_attempt_guard_exists_reconcile_only');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 30000 });
  const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  if (main.length !== 1) throw new Error('exact_official_main_required');
  const page = main[0].page;
  const before = await snapshot(page);
  receipt.before = { ...before, messages: before.messages.map(row => ({ id: row.id, role: row.role })) };
  if (before.activeChatId !== chatId || before.selection !== 'opencode-cli:openai/gpt-6-luna' ||
    before.status !== 'Complete' || before.draft !== '' || before.selectedSkills ||
    before.queueRows.length !== 0 || before.messages.filter(row => row.role === 'user').length !== 7)
    throw new Error('exact_idle_opencode_queue_fixture_required');
  const input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
  await input.fill(primary, { timeout: 10000 });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  if (!await send.isEnabled()) throw new Error('primary_send_disabled');
  fs.writeFileSync(primaryGuard, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: hash(primary), beforeIds: before.messages.map(row => row.id) }, null, 2) + '\n', { flag: 'wx' });
  receipt.primarySendAttempted = true;
  receipt.stage = 'primary-running';
  await send.click({ timeout: 10000, force: true });
  await page.getByRole('button', { name: 'Stop current request', exact: true })
    .waitFor({ state: 'visible', timeout: 15000 });
  const running = await snapshot(page);
  receipt.running = { status: running.status, stopVisible: running.stopVisible,
    users: running.messages.filter(row => row.role === 'user').length };
  if (!running.stopVisible || running.activeChatId !== chatId) throw new Error('primary_not_running');
  receipt.stage = 'queue-followup';
  await input.fill(queued, { timeout: 10000 });
  await input.focus();
  fs.writeFileSync(queueGuard, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: hash(queued), primarySha256: hash(primary) }, null, 2) + '\n', { flag: 'wx' });
  receipt.queueAttempted = true;
  await page.keyboard.press('Tab');
  const queueDeadline = Date.now() + 10000;
  let queuedState;
  while (Date.now() < queueDeadline) {
    await page.waitForTimeout(200);
    queuedState = await snapshot(page);
    if (queuedState.queueRows.some(row => row.text === queued)) break;
  }
  receipt.queuedState = queuedState && { status: queuedState.status, queueRows: queuedState.queueRows,
    draft: queuedState.draft, users: queuedState.messages.filter(row => row.role === 'user').length };
  if (!queuedState?.queueRows.some(row => row.text === queued)) throw new Error('queued_followup_not_visible');
  receipt.stage = 'await-drain';
  const deadline = Date.now() + 150000;
  let current;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    current = await snapshot(page);
    const newRows = current.messages.filter(row => !before.messages.some(old => old.id === row.id));
    if (newRows.filter(row => row.role === 'user').length >= 2 &&
      current.status === 'Complete' && current.queueRows.length === 0) break;
    if (current.status === 'Failed' || current.status === 'Cancelled') break;
  }
  const fresh = current?.messages.filter(row => !before.messages.some(old => old.id === row.id)) ?? [];
  receipt.after = current && { status: current.status, queueRows: current.queueRows,
    draft: current.draft, messages: fresh.sort((a,b) => a.createdAt - b.createdAt) };
  receipt.passed = current?.status === 'Complete' && current.queueRows.length === 0 &&
    fresh.filter(row => row.role === 'user' && hash(row.text) === hash(primary)).length === 1 &&
    fresh.filter(row => row.role === 'user' && hash(row.text) === hash(queued)).length === 1 &&
    fresh.some(row => row.role === 'assistant' && row.text.includes('CH34_QUEUE_FOLLOWUP_7A31'));
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-after-run-queue-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      queuedRows: receipt.queuedState?.queueRows?.length, afterStatus: receipt.after?.status,
      freshUsers: receipt.after?.messages?.filter(row => row.role === 'user').length,
      failure: receipt.failure }));
    if (browser) await browser.close();
  });

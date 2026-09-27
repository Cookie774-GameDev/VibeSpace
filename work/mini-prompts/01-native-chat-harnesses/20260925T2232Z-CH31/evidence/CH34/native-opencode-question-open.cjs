'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const prompt = 'Use your native question tool to ask me one harmless random preference question. Do not just print the question as ordinary text. Do not edit files or run commands.';
const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
const guardPath = path.join(__dirname, 'opencode-question-send-attempt.json');
const receipt = { at: new Date().toISOString(), lane: 'opencode', cdpPort: 9223,
  promptSha256: promptHash, stage: 'attach', sendAttempted: false };
let browser;

function requireState(condition, code) { if (!condition) throw new Error(code); }

async function snapshot(page, chatId) {
  return page.evaluate(async expectedId => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }, { resolveChatBackendAffinity }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
      import('/src/lib/ai/backend/chatBackend.ts'),
    ]);
    await openDb();
    const chat = await db.chats.get(expectedId);
    const rows = await db.messages.where('chat_id').equals(expectedId).toArray();
    const blocks = rows.flatMap(row => (row.parts ?? []).filter(part => part.kind === 'question_block')
      .map(part => ({ messageId: row.id, blockId: part.block?.id ?? null,
        status: part.block?.status ?? null, questionCount: part.block?.questions?.length ?? 0,
        optionCounts: (part.block?.questions ?? []).map(q => q.options?.length ?? 0),
        protocol: part.harness?.protocol ?? null, requestId: part.harness?.requestId ?? null,
        sessionId: part.harness?.sessionId ?? null,
        nativeRequestId: part.harness?.nativeRequestId ?? null,
        autoResolutionMs: part.harness?.autoResolutionMs ?? null })));
    const selection = useAuthStore.getState().chatModelSelection;
    return {
      activeChatId: useUIStore.getState().activeChatId,
      projectId: chat?.project_id ?? null,
      backend: chat ? resolveChatBackendAffinity(chat.backend_affinity, {
        hasCommittedUserMessage: rows.some(row => row.role === 'user'), chatCreatedAt: chat.created_at,
      }).backend : null,
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      selectedRoute: selection?.mode === 'single' ? {
        providerId: selection.providerId, modelId: selection.modelId,
        connectionId: selection.connectionId,
      } : null,
      userCount: rows.filter(row => row.role === 'user').length,
      assistantCount: rows.filter(row => row.role === 'assistant').length,
      toolNames: [...new Set(rows.flatMap(row => (row.parts ?? []).filter(part =>
        part.kind === 'tool_call').map(part => part.name ?? part.tool_name ?? null)).filter(Boolean))],
      blocks,
      runStatus: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draftLength: document.querySelector(`[data-testid="chat-pane-${expectedId}"] [data-composer-input="true"]`)?.value?.length ?? null,
    };
  }, chatId);
}

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const pages = browser.contexts().flatMap(context => context.pages());
  const labels = await Promise.all(pages.map(async page => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labels.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  requireState(main.length === 1, 'exact_official_main_required');
  const page = main[0].page;
  const source = await snapshot(page, 'cht_Eumzyw1Y8yx21W1s');
  receipt.source = source;
  requireState(source.activeChatId === 'cht_Eumzyw1Y8yx21W1s' &&
    source.projectId === 'prj_ybjv0yXnrGkGhAQY' && source.backend === 'opencode' &&
    source.selectedRoute?.connectionId === 'opencode-cli' &&
    source.selectedRoute?.modelId === 'openai/gpt-6-luna' && source.draftLength === 0 &&
    source.runStatus === 'Complete', 'idle_original_opencode_luna_required');
  requireState(!fs.existsSync(guardPath), 'question_attempt_guard_exists_reconcile_only');

  receipt.stage = 'create-chat';
  const create = page.getByRole('button', { name: 'Create chat', exact: true });
  requireState(await create.count() === 1 && await create.isVisible(), 'create_chat_button_missing');
  await create.click({ timeout: 20000 });
  await page.waitForFunction(async oldId => {
    const [{ db, openDb }, { useUIStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'),
    ]);
    await openDb();
    const active = useUIStore.getState().activeChatId;
    return Boolean(active && active !== oldId && await db.chats.get(active) &&
      document.querySelector(`[data-testid="chat-pane-${active}"] [data-composer-input="true"]`));
  }, 'cht_Eumzyw1Y8yx21W1s', { timeout: 20000 });
  await page.waitForTimeout(500);
  const activeId = await page.evaluate(async () =>
    (await import('/src/stores/ui.ts')).useUIStore.getState().activeChatId);
  receipt.chatId = activeId;
  const before = await snapshot(page, activeId);
  receipt.before = before;
  requireState(before.activeChatId === activeId && before.projectId === source.projectId &&
    before.backend === 'opencode' && before.selectedRoute?.connectionId === 'opencode-cli' &&
    before.selectedRoute?.modelId === 'openai/gpt-6-luna' && before.userCount === 0 &&
    before.assistantCount === 0 && before.draftLength === 0, 'fresh_opencode_chat_required');

  receipt.stage = 'send-once';
  const input = page.locator(`[data-testid="chat-pane-${activeId}"] [data-composer-input="true"]`);
  await input.fill(prompt, { timeout: 20000 });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  requireState(await send.count() === 1 && await send.isEnabled(), 'send_button_unavailable');
  fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId: activeId,
    promptSha256: promptHash, status: 'before-send' }, null, 2) + '\n', { flag: 'wx' });
  receipt.sendAttempted = true;
  await send.click({ timeout: 20000 });

  receipt.stage = 'await-question';
  const deadline = Date.now() + 120000;
  let observed;
  while (Date.now() < deadline) {
    await page.waitForTimeout(750);
    observed = await snapshot(page, activeId);
    if (observed.activeChatId !== activeId) throw new Error('chat_switched_during_question_wait');
    if (observed.blocks.some(block => block.status === 'pending') ||
      ['Failed', 'Cancelled', 'Stopped', 'Complete'].includes(observed.runStatus)) break;
  }
  receipt.observed = observed;
  const pending = observed?.blocks.filter(block => block.status === 'pending') ?? [];
  receipt.pendingCount = pending.length;
  receipt.nativeQuestionCardVisible = pending.length === 1 &&
    await page.locator(`[data-inline-question-block-id="${pending[0].blockId}"]`).isVisible();
  requireState(observed?.backend === 'opencode' && observed?.connectionId === 'opencode-cli' &&
    observed?.modelId === 'openai/gpt-6-luna' && observed.userCount === 1 &&
    pending.length === 1 && pending[0].protocol === 'opencode-question-v1' &&
    typeof pending[0].requestId === 'string' && pending[0].requestId.length > 0 &&
    typeof pending[0].sessionId === 'string' && pending[0].sessionId.length > 0 &&
    receipt.nativeQuestionCardVisible && !observed.toolNames.some(name =>
      /^(bash|shell|edit|write|apply_patch)$/i.test(name)),
  'genuine_native_question_not_observed');
  receipt.passed = true;
  receipt.stage = 'pending-native-question';
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-question-open-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, chatId: receipt.chatId, pendingCount: receipt.pendingCount }));
    if (browser) await browser.close();
  });

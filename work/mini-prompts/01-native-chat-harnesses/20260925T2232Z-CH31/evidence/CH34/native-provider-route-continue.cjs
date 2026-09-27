'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const chatId = 'cht_vdI_HrV1IHyCNXif';
const expectedDraftHash = 'eef12d1fbb66309644a85c8593410ba39c3b86b1e9034afc5ed0f20603608385';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const receipt = { at: new Date().toISOString(), stage: 'attach', chatId, providerSend: false,
  previousAttempts: ['native-provider-draft-1790514711321.json', 'native-provider-draft-1790514808783.json'] };
const guardPath = path.join(__dirname, 'provider-route-continue-attempt.json');
let browser;

function requireState(condition, code) { if (!condition) throw new Error(code); }

async function snapshot(page) {
  return page.evaluate(async id => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }, { resolveChatBackendAffinity }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
      import('/src/lib/ai/backend/chatBackend.ts'),
    ]);
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const selection = useAuthStore.getState().chatModelSelection;
    return {
      activeChatId: useUIStore.getState().activeChatId,
      projectId: chat?.project_id ?? null,
      backend: chat ? resolveChatBackendAffinity(chat.backend_affinity, {
        hasCommittedUserMessage: rows.some(row => row.role === 'user'),
        chatCreatedAt: chat.created_at,
      }).backend : null,
      userCount: rows.filter(row => row.role === 'user').length,
      assistantCount: rows.filter(row => row.role === 'assistant').length,
      draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value ?? null,
      selection: selection?.mode === 'single' ? {
        mode: 'single', providerId: selection.providerId, modelId: selection.modelId,
        connectionId: selection.connectionId,
      } : { mode: selection?.mode ?? null },
    };
  }, chatId);
}

function safe(value) {
  return { activeChatId: value.activeChatId, projectId: value.projectId, backend: value.backend,
    userCount: value.userCount, assistantCount: value.assistantCount,
    draftLength: value.draft?.length ?? null, draftSha256: value.draft == null ? null : hash(value.draft),
    selection: value.selection };
}

async function selectRuntime(page, target) {
  const button = page.locator(`[data-testid="chat-pane-${chatId}"] button[aria-label="Choose coding runtime"]`);
  requireState(await button.count() === 1, 'runtime_button_missing');
  await button.click({ timeout: 20000 });
  const group = page.getByRole('group', { name: 'cli options', exact: true });
  await group.waitFor({ state: 'visible', timeout: 20000 });
  const option = group.locator(`button[data-value="${target}"]`);
  requireState(await option.count() === 1 && await option.isVisible(), 'runtime_option_missing');
  await option.click({ timeout: 20000 });
  await page.waitForFunction(async ({ id, targetBackend }) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    return (await db.chats.get(id))?.backend_affinity?.backend === targetBackend;
  }, { id: chatId, targetBackend: target }, { timeout: 20000 });
}

async function selectModel(page, targetValue, label) {
  const button = page.locator(`[data-testid="chat-pane-${chatId}"] button[aria-label="Choose model"]`);
  requireState(await button.count() === 1, 'model_button_missing');
  await button.click({ timeout: 20000 });
  const dialog = page.getByRole('dialog', { name: 'Choose AI model', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  const search = dialog.getByRole('searchbox', { name: 'Search providers and models', exact: true });
  await search.fill('GPT-6 Luna', { timeout: 20000 });
  const list = dialog.locator('[role="listbox"]').first();
  const options = await list.locator('[role="option"]').evaluateAll(nodes => nodes.map(node => ({
    value: node.getAttribute('data-value'), disabled: node.getAttribute('aria-disabled'),
  })));
  receipt[`${label}Options`] = options;
  const row = list.locator(`[role="option"][data-value="${targetValue}"]`);
  requireState(await row.count() === 1 && await row.isVisible(), `${label}_model_not_available`);
  await row.click({ timeout: 20000 });
  await page.waitForFunction(() => {
    const label = document.querySelector('[role="dialog"][aria-label="Choose AI model"] [role="listbox"]')
      ?.getAttribute('aria-label') ?? '';
    return label.endsWith(' route options') || label.endsWith(' effort options');
  }, null, { timeout: 20000 });
  const nextLabel = await list.getAttribute('aria-label') ?? '';
  if (nextLabel.endsWith(' route options')) {
    const route = list.locator(`[role="option"][data-value="${targetValue}"]`);
    await route.waitFor({ state: 'visible', timeout: 20000 });
    await route.click({ timeout: 20000 });
  }
  const effort = list.locator('[role="option"][data-effort-level="low"]');
  await effort.waitFor({ state: 'visible', timeout: 20000 });
  await effort.click({ timeout: 20000 });
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
}

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const pages = browser.contexts().flatMap(context => context.pages());
  const labeled = await Promise.all(pages.map(async page => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  requireState(main.length === 1, 'exact_official_main_required');
  const page = main[0].page;
  const before = await snapshot(page);
  receipt.before = safe(before);
  requireState(before.activeChatId === chatId && before.projectId === 'prj_ybjv0yXnrGkGhAQY' &&
    before.backend === 'opencode' && before.userCount === 0 && before.assistantCount === 0 &&
    before.draft?.length === 51 && hash(before.draft) === expectedDraftHash,
  'exact_unsent_fixture_draft_required');
  requireState(!fs.existsSync(guardPath), 'route_attempt_exists_reconcile_only');
  fs.writeFileSync(guardPath, JSON.stringify({ at: receipt.at, chatId, draftSha256: expectedDraftHash,
    stage: 'before-codex' }, null, 2) + '\n', { flag: 'wx' });

  const openPicker = page.getByRole('dialog', { name: 'Choose AI model', exact: true });
  if (await openPicker.isVisible()) {
    await page.keyboard.press('Escape');
    await openPicker.waitFor({ state: 'hidden', timeout: 20000 });
  }
  receipt.stage = 'codex-runtime';
  await selectRuntime(page, 'codex');
  const codexRuntime = await snapshot(page);
  receipt.codexRuntime = safe(codexRuntime);
  requireState(codexRuntime.draft === before.draft && codexRuntime.userCount === 0,
    'codex_runtime_lost_draft_or_sent');

  receipt.stage = 'codex-model';
  await selectModel(page, 'openai-codex:gpt-6-luna', 'codex');
  const codex = await snapshot(page);
  receipt.codex = safe(codex);
  requireState(codex.backend === 'codex' && codex.draft === before.draft &&
    codex.selection.connectionId === 'openai-codex' && codex.selection.modelId === 'gpt-6-luna' &&
    codex.userCount === 0 && codex.assistantCount === 0, 'codex_route_lost_draft_or_sent');

  receipt.stage = 'opencode-runtime';
  await selectRuntime(page, 'opencode');
  const openCodeRuntime = await snapshot(page);
  receipt.openCodeRuntime = safe(openCodeRuntime);
  requireState(openCodeRuntime.draft === before.draft && openCodeRuntime.userCount === 0,
    'opencode_runtime_lost_draft_or_sent');

  receipt.stage = 'opencode-model';
  await selectModel(page, 'opencode-cli:openai/gpt-6-luna', 'opencode');
  const after = await snapshot(page);
  receipt.after = safe(after);
  requireState(after.backend === 'opencode' && after.draft === before.draft &&
    after.selection.connectionId === 'opencode-cli' && after.selection.modelId === 'openai/gpt-6-luna' &&
    after.userCount === 0 && after.assistantCount === 0, 'opencode_route_lost_draft_or_sent');
  receipt.stage = 'complete';
  receipt.passed = true;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-provider-route-continue-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure }));
    if (browser) await browser.close();
  });

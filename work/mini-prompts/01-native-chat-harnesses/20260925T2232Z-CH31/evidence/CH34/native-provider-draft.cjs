'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { applyProviderRoute, normalizeRoutePlan } = require('../../native-long-draft-C.cjs');

const directory = __dirname;
const guardPath = path.join(directory, 'provider-draft-create-attempt.json');
const receipt = { at: new Date().toISOString(), stage: 'attach', cdpPort: 9223, providerSend: false };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let browser;

async function state(page) {
  return page.evaluate(async () => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }, { getChatRunState }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
      import('/src/features/chat/runtime/chatRunState.ts'),
    ]);
    await openDb();
    const activeChatId = useUIStore.getState().activeChatId;
    const chat = activeChatId ? await db.chats.get(activeChatId) : null;
    const rows = activeChatId ? await db.messages.where('chat_id').equals(activeChatId).toArray() : [];
    const input = document.querySelector('[data-testid="chat-pane-' + activeChatId + '"] [data-composer-input="true"]');
    const selection = useAuthStore.getState().chatModelSelection;
    return {
      windowLabel: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
      activeChatId,
      projectId: chat?.project_id ?? null,
      title: chat?.title ?? null,
      userCount: rows.filter(row => row.role === 'user').length,
      assistantCount: rows.filter(row => row.role === 'assistant').length,
      pendingPermissions: rows.flatMap(row => row.parts ?? []).filter(part =>
        part?.kind === 'permission_request' && part.request?.status === 'pending').length,
      runStatus: activeChatId ? getChatRunState(activeChatId)?.status ?? null : null,
      draft: input?.value ?? null,
      modelSelection: selection?.mode === 'single' ? {
        mode: 'single', providerId: selection.providerId, modelId: selection.modelId,
        connectionId: selection.connectionId,
      } : { mode: selection?.mode ?? null },
      stopVisible: Boolean(document.querySelector('button[aria-label="Stop current request"]')?.getBoundingClientRect().width),
    };
  });
}

function safe(snapshot) {
  return {
    activeChatId: snapshot.activeChatId,
    projectId: snapshot.projectId,
    userCount: snapshot.userCount,
    assistantCount: snapshot.assistantCount,
    pendingPermissions: snapshot.pendingPermissions,
    runStatus: snapshot.runStatus,
    draftLength: snapshot.draft?.length ?? null,
    draftSha256: snapshot.draft == null ? null : hash(snapshot.draft),
    modelSelection: snapshot.modelSelection,
  };
}

function requireState(condition, code) { if (!condition) throw new Error(code); }

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const pages = browser.contexts().flatMap(context => context.pages());
  const labels = await Promise.all(pages.map(async page => ({
    page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null),
  })));
  const matches = labels.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  requireState(matches.length === 1, 'exact_official_main_required');
  const page = matches[0].page;
  receipt.pageUrl = page.url();
  let created;
  if (process.argv[2] === '--resume') {
    receipt.stage = 'reconcile-created-chat';
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    requireState(guard.status === 'before-create' && guard.sourceChatId === 'cht_Eumzyw1Y8yx21W1s' &&
      guard.projectId === 'prj_ybjv0yXnrGkGhAQY', 'exact_prior_create_guard_required');
    created = await state(page);
    requireState(created.activeChatId === 'cht_vdI_HrV1IHyCNXif', 'exact_reconciled_fixture_required');
    receipt.resumedFrom = 'native-provider-draft-1790514711321.json';
  } else {
    const before = await state(page);
    receipt.before = safe(before);
    requireState(before.windowLabel === 'main' && before.activeChatId === 'cht_Eumzyw1Y8yx21W1s' &&
      before.projectId === 'prj_ybjv0yXnrGkGhAQY' && before.runStatus !== 'running' &&
      before.draft === '' && before.pendingPermissions === 0 && !before.stopVisible,
    'idle_known_source_chat_required');
    requireState(!fs.existsSync(guardPath), 'create_attempt_already_exists_reconcile_only');
    const create = page.getByRole('button', { name: 'Create chat', exact: true });
    requireState(await create.count() === 1 && await create.isVisible(), 'create_chat_button_unavailable');
    receipt.stage = 'create-fixture-chat';
    fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), sourceChatId: before.activeChatId,
      projectId: before.projectId, status: 'before-create' }, null, 2) + '\n', { flag: 'wx' });
    await create.click({ timeout: 20000 });
    await page.waitForFunction(async sourceId => {
      const [{ db, openDb }, { useUIStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'),
      ]);
      await openDb();
      const active = useUIStore.getState().activeChatId;
      return Boolean(active && active !== sourceId && await db.chats.get(active) &&
        document.querySelector(`[data-testid="chat-pane-${active}"] [data-composer-input="true"]`));
    }, before.activeChatId, { timeout: 20000 });
    created = await state(page);
  }
  receipt.created = safe(created);
  requireState(created.activeChatId && created.activeChatId !== 'cht_Eumzyw1Y8yx21W1s' &&
    created.projectId === 'prj_ybjv0yXnrGkGhAQY' && created.userCount === 0 &&
    created.assistantCount === 0 && created.draft === '' && !created.stopVisible,
  'fresh_empty_fixture_chat_required');
  fs.writeFileSync(guardPath, JSON.stringify({ at: receipt.at, sourceChatId: 'cht_Eumzyw1Y8yx21W1s',
    fixtureChatId: created.activeChatId, projectId: created.projectId, status: 'created' }, null, 2) + '\n');

  const draft = `CH34 provider switch draft ${crypto.randomBytes(12).toString('hex')}`;
  const input = page.locator(`[data-testid="chat-pane-${created.activeChatId}"] [data-composer-input="true"]`);
  requireState(await input.count() === 1, 'fixture_composer_missing');
  receipt.stage = 'draft';
  await input.fill(draft, { timeout: 20000 });
  await page.waitForFunction(({ chatId, expected }) =>
    document.querySelector(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`)?.value === expected,
  { chatId: created.activeChatId, expected: draft }, { timeout: 20000 });
  const drafted = await state(page);
  receipt.drafted = safe(drafted);
  requireState(drafted.draft === draft, 'draft_not_saved_before_switch');

  receipt.stage = 'switch-codex';
  const codexExpected = { mode: 'single', providerId: 'openai', modelId: 'gpt-6-luna', connectionId: 'openai-codex' };
  await applyProviderRoute(page, created.activeChatId, normalizeRoutePlan({
    searchText: 'GPT-6 Luna', logicalOptionValue: 'openai-codex:gpt-6-luna',
    optionValue: 'openai-codex:gpt-6-luna', effortLevel: 'low',
  }, 'codex_route'), codexExpected, 20000);
  const codex = await state(page);
  receipt.codex = safe(codex);
  requireState(codex.draft === draft && codex.activeChatId === created.activeChatId &&
    codex.userCount === 0 && codex.assistantCount === 0, 'codex_switch_lost_draft_or_sent');

  receipt.stage = 'switch-opencode';
  const openCodeExpected = { mode: 'single', providerId: 'opencode', modelId: 'openai/gpt-6-luna', connectionId: 'opencode-cli' };
  await applyProviderRoute(page, created.activeChatId, normalizeRoutePlan({
    searchText: 'GPT-6 Luna', logicalOptionValue: 'openai-codex:gpt-6-luna',
    optionValue: 'opencode-cli:openai/gpt-6-luna', effortLevel: 'low',
  }, 'opencode_route'), openCodeExpected, 20000);
  const returned = await state(page);
  receipt.returned = safe(returned);
  requireState(returned.draft === draft && returned.activeChatId === created.activeChatId &&
    returned.userCount === 0 && returned.assistantCount === 0, 'opencode_switch_lost_draft_or_sent');
  receipt.passed = true;
  receipt.fixtureChatId = created.activeChatId;
  receipt.draftSha256 = hash(draft);
  receipt.stage = 'complete';
})().catch(error => {
  receipt.failure = String(error?.message ?? error);
  process.exitCode = 1;
}).finally(async () => {
  receipt.finishedAt = new Date().toISOString();
  const output = path.join(directory, `native-provider-draft-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    failure: receipt.failure, fixtureChatId: receipt.fixtureChatId }));
  if (browser) await browser.close();
});

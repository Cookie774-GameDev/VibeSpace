'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const fixture = 'cht_vdI_HrV1IHyCNXif';
const original = 'cht_Eumzyw1Y8yx21W1s';
const expectedHash = 'eef12d1fbb66309644a85c8593410ba39c3b86b1e9034afc5ed0f20603608385';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const receipt = { at: new Date().toISOString(), source: 'native-provider-route-continue-1790515004272.json',
  providerSend: false, stage: 'attach' };
let browser;

async function snapshot(page) {
  return page.evaluate(async ({ fixtureId, originalId }) => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }, { resolveChatBackendAffinity }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
      import('/src/lib/ai/backend/chatBackend.ts'),
    ]);
    await openDb();
    const fixtureChat = await db.chats.get(fixtureId);
    const originalChat = await db.chats.get(originalId);
    const rows = await db.messages.where('chat_id').equals(fixtureId).toArray();
    const selection = useAuthStore.getState().chatModelSelection;
    return {
      windowLabel: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
      activeChatId: useUIStore.getState().activeChatId,
      fixtureTitle: fixtureChat?.title ?? null,
      originalTitle: originalChat?.title ?? null,
      fixtureProjectId: fixtureChat?.project_id ?? null,
      fixtureBackend: fixtureChat ? resolveChatBackendAffinity(fixtureChat.backend_affinity, {
        hasCommittedUserMessage: rows.some(row => row.role === 'user'), chatCreatedAt: fixtureChat.created_at,
      }).backend : null,
      users: rows.filter(row => row.role === 'user').length,
      assistants: rows.filter(row => row.role === 'assistant').length,
      fixtureDraft: document.querySelector(`[data-testid="chat-pane-${fixtureId}"] [data-composer-input="true"]`)?.value ?? null,
      selection: selection?.mode === 'single' ? {
        providerId: selection.providerId, modelId: selection.modelId, connectionId: selection.connectionId,
      } : { mode: selection?.mode ?? null },
    };
  }, { fixtureId: fixture, originalId: original });
}

function safe(value) {
  return { windowLabel: value.windowLabel, activeChatId: value.activeChatId,
    fixtureProjectId: value.fixtureProjectId, fixtureBackend: value.fixtureBackend,
    users: value.users, assistants: value.assistants, draftLength: value.fixtureDraft?.length ?? null,
    draftSha256: value.fixtureDraft == null ? null : hash(value.fixtureDraft), selection: value.selection };
}

function requireState(condition, code) { if (!condition) throw new Error(code); }

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const pages = browser.contexts().flatMap(context => context.pages());
  const labels = await Promise.all(pages.map(async page => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
  const main = labels.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
  requireState(main.length === 1, 'exact_official_main_required');
  const page = main[0].page;
  const before = await snapshot(page);
  receipt.before = safe(before);
  requireState(before.windowLabel === 'main' && before.activeChatId === fixture &&
    before.fixtureProjectId === 'prj_ybjv0yXnrGkGhAQY' && before.fixtureBackend === 'opencode' &&
    before.users === 0 && before.assistants === 0 && before.fixtureDraft?.length === 51 &&
    hash(before.fixtureDraft) === expectedHash, 'exact_fixture_before_reload_required');

  const waitForFixtureDraft = () => page.waitForFunction(async ({ id, expected }) => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    const active = useUIStore.getState().activeChatId;
    const value = document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)?.value;
    const bytes = new TextEncoder().encode(value ?? '');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return active === id && actual === expected;
  }, { id: fixture, expected: expectedHash }, { timeout: 30000, polling: 100 });
  let afterReload;
  if (process.argv[2] === '--reconcile') {
    receipt.stage = 'reconcile-reload';
    const prior = JSON.parse(fs.readFileSync(path.join(__dirname,
      'native-provider-draft-reload-1790515107708.json'), 'utf8'));
    requireState(prior.stage === 'reload' && prior.afterReload?.activeChatId === fixture &&
      prior.failure === 'reload_lost_route_or_draft', 'exact_prior_reload_receipt_required');
    receipt.reconciledFrom = [
      'native-provider-draft-reload-1790515107708.json',
      'preflight-1790515118876.json',
    ];
    await waitForFixtureDraft();
    await page.waitForTimeout(500);
    afterReload = await snapshot(page);
  } else {
    receipt.stage = 'reload';
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForFixtureDraft();
    await page.waitForTimeout(500);
    afterReload = await snapshot(page);
  }
  receipt.afterReload = safe(afterReload);
  requireState(afterReload.fixtureBackend === 'opencode' && afterReload.users === 0 &&
    afterReload.assistants === 0 && afterReload.fixtureDraft === before.fixtureDraft &&
    afterReload.selection.connectionId === 'opencode-cli', 'reload_lost_route_or_draft');

  receipt.stage = 'switch-chat';
  const tabs = page.getByRole('group', { name: 'Open chats', exact: true });
  const originalTab = tabs.getByRole('button', { name: before.originalTitle, exact: true });
  const fixtureTab = tabs.getByRole('button', { name: before.fixtureTitle, exact: true });
  requireState(await originalTab.count() === 1 && await fixtureTab.count() === 1,
    'exact_original_and_fixture_tabs_required');
  await originalTab.click({ timeout: 20000 });
  await page.waitForFunction(async id => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    return useUIStore.getState().activeChatId === id &&
      document.querySelector(`[data-testid="chat-pane-${id}"]`)?.getBoundingClientRect().width > 0;
  },
  original, { timeout: 20000 });
  await fixtureTab.click({ timeout: 20000 });
  await waitForFixtureDraft();
  const afterSwitch = await snapshot(page);
  receipt.afterSwitch = safe(afterSwitch);
  requireState(afterSwitch.activeChatId === fixture && afterSwitch.fixtureDraft === before.fixtureDraft &&
    afterSwitch.users === 0 && afterSwitch.assistants === 0, 'chat_switch_lost_draft_or_sent');
  await originalTab.click({ timeout: 20000 });
  await page.waitForFunction(async id => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    return useUIStore.getState().activeChatId === id;
  }, original, { timeout: 20000 });
  receipt.restoredOriginalChat = true;
  receipt.stage = 'complete';
  receipt.passed = true;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-provider-draft-reload-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure }));
    if (browser) await browser.close();
  });

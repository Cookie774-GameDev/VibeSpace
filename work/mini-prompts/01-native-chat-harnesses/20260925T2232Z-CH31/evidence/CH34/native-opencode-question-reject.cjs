'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const chatId = 'cht_lWazHd9Rnq8FPmHo';
const originalChatId = 'cht_Eumzyw1Y8yx21W1s';
const blockId = 'qb_opencode_1piqs8d0dgheqb';
const requestId = 'que_0e3086c74001lHWf67cHC5QbVa';
const sessionId = 'ses_f1cf7b360ffeyTWrFEtjY0qVgu';
const guardPath = path.join(__dirname, 'opencode-question-reject-attempt.json');
const receipt = { at: new Date().toISOString(), chatId, blockId, requestId, sessionId,
  source: 'native-opencode-question-open-1790515375521.json', stage: 'attach', providerSend: false };
let browser;

function requireState(condition, code) { if (!condition) throw new Error(code); }

async function snapshot(page) {
  return page.evaluate(async ({ expectedChatId, expectedBlockId }) => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
    ]);
    await openDb();
    const chat = await db.chats.get(expectedChatId);
    const source = await db.chats.get('cht_Eumzyw1Y8yx21W1s');
    const rows = await db.messages.where('chat_id').equals(expectedChatId).toArray();
    const matches = rows.flatMap(row => (row.parts ?? []).filter(part =>
      part.kind === 'question_block' && part.block?.id === expectedBlockId));
    const part = matches.length === 1 ? matches[0] : null;
    const selection = useAuthStore.getState().chatModelSelection;
    return {
      activeChatId: useUIStore.getState().activeChatId,
      chatTitle: chat?.title ?? null,
      originalTitle: source?.title ?? null,
      projectId: chat?.project_id ?? null,
      userCount: rows.filter(row => row.role === 'user').length,
      assistantCount: rows.filter(row => row.role === 'assistant').length,
      matchingQuestionParts: matches.length,
      blockStatus: part?.block?.status ?? null,
      protocol: part?.harness?.protocol ?? null,
      requestId: part?.harness?.requestId ?? null,
      sessionId: part?.harness?.sessionId ?? null,
      selectedRoute: selection?.mode === 'single' ? {
        providerId: selection.providerId, modelId: selection.modelId, connectionId: selection.connectionId,
      } : null,
      runStatus: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
    };
  }, { expectedChatId: chatId, expectedBlockId: blockId });
}

function safe(value) {
  return { activeChatId: value.activeChatId, projectId: value.projectId,
    userCount: value.userCount, assistantCount: value.assistantCount,
    matchingQuestionParts: value.matchingQuestionParts, blockStatus: value.blockStatus,
    protocol: value.protocol, requestId: value.requestId, sessionId: value.sessionId,
    selectedRoute: value.selectedRoute, runStatus: value.runStatus };
}

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
  requireState(before.activeChatId === chatId && before.projectId === 'prj_ybjv0yXnrGkGhAQY' &&
    before.userCount === 1 && before.matchingQuestionParts === 1 && before.blockStatus === 'pending' &&
    before.protocol === 'opencode-question-v1' && before.requestId === requestId &&
    before.sessionId === sessionId && before.selectedRoute?.connectionId === 'opencode-cli' &&
    before.selectedRoute?.modelId === 'openai/gpt-6-luna', 'exact_pending_native_question_required');
  requireState(!fs.existsSync(guardPath), 'question_reject_attempt_exists_reconcile_only');
  const tabs = page.getByRole('group', { name: 'Open chats', exact: true });
  const originalTab = tabs.getByRole('button', { name: before.originalTitle, exact: true });
  const questionTab = tabs.getByRole('button', { name: before.chatTitle, exact: true });
  requireState(await originalTab.count() === 1 && await questionTab.count() === 1,
    'exact_open_chat_tabs_required');
  const card = page.locator(`[data-inline-question-block-id="${blockId}"]`);
  requireState(await card.isVisible(), 'pending_question_card_missing');
  const draft = 'CH34 editable native question draft';
  const input = card.getByRole('textbox');
  if (process.argv[2] === '--resume-dismissed') {
    const prior = JSON.parse(fs.readFileSync(path.join(__dirname,
      'native-opencode-question-reject-1790515595373.json'), 'utf8'));
    requireState(prior.stage === 'dismiss' && prior.requestId === requestId &&
      prior.draftSha256 === crypto.createHash('sha256').update(draft).digest('hex'),
    'exact_prior_dismiss_receipt_required');
    receipt.resumedFrom = 'native-opencode-question-reject-1790515595373.json';
    receipt.draftSha256 = prior.draftSha256;
    receipt.micButtonCount = prior.micButtonCount;
    const reopenBefore = card.getByRole('button', { name: 'Reopen question', exact: true });
    if (!await reopenBefore.count()) {
      requireState(await card.getByRole('button', { name: 'Dismiss question', exact: true }).count() === 1,
        'question_card_controls_missing');
      await card.getByRole('button', { name: 'Dismiss question', exact: true }).click({ timeout: 10000 });
    }
    await reopenBefore.waitFor({ state: 'visible', timeout: 10000 });
  } else {
    receipt.stage = 'editable-draft';
    await card.getByRole('button', { name: 'Write my own answer', exact: true }).click({ timeout: 10000 });
    requireState(await input.count() === 1, 'question_custom_textbox_missing');
    await input.fill(draft, { timeout: 10000 });
    receipt.draftSha256 = crypto.createHash('sha256').update(draft).digest('hex');
    receipt.micButtonCount = await card.getByRole('button', { name: 'Dictate answer', exact: true }).count();
    requireState(receipt.micButtonCount === 1, 'question_dictation_control_missing');
    receipt.stage = 'dismiss';
    await card.getByRole('button', { name: 'Dismiss question', exact: true }).click({ timeout: 10000 });
    await card.getByRole('button', { name: 'Reopen question', exact: true })
      .waitFor({ state: 'visible', timeout: 10000 });
  }
  const dismissed = await snapshot(page);
  receipt.dismissed = safe(dismissed);
  requireState(dismissed.blockStatus === 'pending' && dismissed.userCount === 1 &&
    await card.getByRole('button', { name: 'Reopen question', exact: true }).count() === 1,
  'dismiss_resolved_or_lost_question');

  receipt.stage = 'switch-away';
  await originalTab.click({ timeout: 10000 });
  await page.waitForFunction(async id =>
    (await import('/src/stores/ui.ts')).useUIStore.getState().activeChatId === id,
  originalChatId, { timeout: 10000 });
  const away = await snapshot(page);
  receipt.away = safe(away);
  requireState(away.activeChatId === originalChatId && away.blockStatus === 'pending' &&
    away.userCount === 1, 'chat_switch_resolved_question');
  await questionTab.click({ timeout: 10000 });
  await page.waitForFunction(async id =>
    (await import('/src/stores/ui.ts')).useUIStore.getState().activeChatId === id,
  chatId, { timeout: 10000 });
  receipt.stage = 'reopen';
  const reopen = card.getByRole('button', { name: 'Reopen question', exact: true });
  if (await reopen.count()) await reopen.click({ timeout: 10000 });
  await card.getByRole('button', { name: 'Dismiss question', exact: true })
    .waitFor({ state: 'visible', timeout: 10000 });
  if (!await input.isVisible()) {
    await card.getByRole('button', { name: 'Write my own answer', exact: true }).click({ timeout: 10000 });
  }
  receipt.draftRestored = await input.inputValue() === draft;
  const reopened = await snapshot(page);
  receipt.reopened = safe(reopened);
  requireState(receipt.draftRestored && reopened.blockStatus === 'pending' &&
    reopened.requestId === requestId && reopened.sessionId === sessionId && reopened.userCount === 1,
  'reopen_changed_request_or_draft');
  await input.fill('', { timeout: 10000 });

  receipt.stage = 'reject-once';
  receipt.observer = await page.evaluate(({ expectedRequestId }) => {
    const internals = window.__TAURI_INTERNALS__;
    const descriptor = Object.getOwnPropertyDescriptor(internals ?? {}, 'invoke');
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) return { installed: false };
    const original = descriptor.value;
    const events = [];
    const wrapped = function (...args) {
      const request = args[1]?.request;
      const route = request?.route;
      if (args[0] !== 'opencode_server_request' || route?.kind !== 'question_reject' ||
          route.requestId !== expectedRequestId) return Reflect.apply(original, this, args);
      const event = { kind: route.kind, requestId: route.requestId, settled: false, status: null };
      events.push(event);
      const result = Reflect.apply(original, this, args);
      Promise.resolve(result).then(value => {
        event.settled = true;
        event.status = Number.isInteger(value?.status) ? value.status : null;
      }, () => { event.settled = true; event.rejected = true; });
      return result;
    };
    internals.invoke = wrapped;
    Object.defineProperty(window, '__ch34QuestionRejectObserver', {
      value: { original, wrapped, events }, configurable: true,
    });
    return { installed: true };
  }, { expectedRequestId: requestId });
  fs.writeFileSync(guardPath, JSON.stringify({ at: new Date().toISOString(), chatId, blockId,
    requestId, sessionId, status: 'before-reject' }, null, 2) + '\n', { flag: 'wx' });
  await card.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 10000 });
  await page.waitForFunction(async ({ expectedChatId, expectedBlockId }) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(expectedChatId).toArray();
    return rows.flatMap(row => row.parts ?? []).some(part =>
      part.kind === 'question_block' && part.block?.id === expectedBlockId &&
      part.block?.status === 'cancelled');
  }, { expectedChatId: chatId, expectedBlockId: blockId }, { timeout: 30000 });
  const after = await snapshot(page);
  receipt.after = safe(after);
  receipt.observedNativeReject = await page.evaluate(() => {
    const state = window.__ch34QuestionRejectObserver;
    if (!state) return null;
    if (window.__TAURI_INTERNALS__?.invoke === state.wrapped) {
      window.__TAURI_INTERNALS__.invoke = state.original;
    }
    delete window.__ch34QuestionRejectObserver;
    return state.events;
  });
  requireState(after.blockStatus === 'cancelled' && after.userCount === 1 &&
    after.matchingQuestionParts === 1 && after.requestId === requestId &&
    after.sessionId === sessionId &&
    (!receipt.observer.installed || (receipt.observedNativeReject?.length === 1 &&
      receipt.observedNativeReject[0].settled &&
      !receipt.observedNativeReject[0].rejected)),
  'native_question_reject_not_confirmed');
  receipt.stage = 'complete';
  receipt.passed = true;
})().catch(error => { receipt.failure = String(error?.message ?? error); process.exitCode = 1; })
  .finally(async () => {
    if (browser) {
      try {
        const pages = browser.contexts().flatMap(context => context.pages());
        const main = pages.find(page => page.url().startsWith('http://localhost:5173/?route=chat'));
        await main?.evaluate(() => {
          const state = window.__ch34QuestionRejectObserver;
          if (state && window.__TAURI_INTERNALS__?.invoke === state.wrapped) {
            window.__TAURI_INTERNALS__.invoke = state.original;
          }
          delete window.__ch34QuestionRejectObserver;
        });
      } catch { /* Preserve the primary receipt. */ }
    }
    receipt.finishedAt = new Date().toISOString();
    const output = path.join(__dirname, `native-opencode-question-reject-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
      failure: receipt.failure, observer: receipt.observedNativeReject }));
    if (browser) await browser.close();
  });

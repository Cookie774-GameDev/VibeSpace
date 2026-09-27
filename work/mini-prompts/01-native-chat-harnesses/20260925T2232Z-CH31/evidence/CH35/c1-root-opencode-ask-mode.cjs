const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const chatId = 'cht_Eumzyw1Y8yx21W1s';
const marker = 'CH35_OPENCODE_ASK_1F84';
const prompt = `In Ask Mode, answer with exactly ${marker}. Do not run tools, edit files, or create a plan.`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const guardPath = path.join(__dirname, 'c1-root-opencode-ask-mode-once.json');
const output = path.join(__dirname, `c1-root-opencode-ask-mode-${Date.now()}.json`);
const receipt = { startedAt: new Date().toISOString(), chatId, promptSha256: hash(prompt),
  stage: 'attach', sent: false, actedOnUi: false };
let browser;
let page;
let priorChatId;

async function state() {
  return page.evaluate(async (id) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const modesByChat = (() => {
      try { return JSON.parse(localStorage.getItem('jarvis-interaction-session') ?? '{}')?.state?.modesByChat ?? {}; }
      catch { return {}; }
    })();
    const selected = document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')
      ?.getAttribute('data-testid')?.replace(/^chat-nav-row-/, '') ?? null;
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
    return {
      selected,
      mode: modesByChat[id] ?? 'agent',
      backend: chat?.backend_affinity?.backend ?? null,
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draft: pane?.querySelector('[data-composer-input="true"]')?.value ?? null,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')),
      messages: rows.map((row) => ({ id: row.id, role: row.role,
        text: (row.parts ?? []).filter((part) => part.kind === 'text')
          .map((part) => part.text).join('\n'),
        toolNames: (row.parts ?? []).filter((part) => part.kind === 'tool_call')
          .map((part) => part.name ?? part.tool?.name ?? 'unknown'),
      })),
    };
  }, chatId);
}

(async () => {
  if (fs.existsSync(guardPath)) throw new Error('once_only_guard_exists');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages())
    .map(async (candidate) => ({ page: candidate,
      label: await candidate.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
        .catch(() => null) })));
  const mains = tagged.filter(({ page: candidate, label }) => label === 'main' &&
    new URL(candidate.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected_one_official_main_${mains.length}`);
  page = mains[0].page;
  receipt.mainUrl = page.url();
  const initial = await state();
  priorChatId = initial.selected;
  receipt.priorChatId = priorChatId;
  if (!priorChatId || priorChatId === chatId) throw new Error('separate_idle_selected_chat_required');
  const prior = await page.evaluate(async (id) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    return { status: document.querySelector(`[data-testid="chat-pane-${id}"] [aria-label="Session status"]`)
      ?.textContent?.trim() ?? null,
      draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)
        ?.value ?? null,
      pending: rows.flatMap((row) => row.parts ?? []).filter((part) =>
        (part.kind === 'question_block' && part.block?.status === 'pending') ||
        (part.kind === 'permission_request' && part.request?.status === 'pending')).length };
  }, priorChatId);
  receipt.prior = { status: prior.status, draftLength: prior.draft?.length ?? null,
    draftSha256: hash(prior.draft ?? ''), pending: prior.pending };
  if (prior.status !== 'Complete' || prior.pending) {
    throw new Error('current_user_chat_not_idle');
  }
  await page.waitForTimeout(2_000);
  const currentPrior = await page.evaluate((id) => ({
    selected: document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')
      ?.getAttribute('data-testid')?.replace(/^chat-nav-row-/, '') ?? null,
    draft: document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)
      ?.value ?? null,
    status: document.querySelector(`[data-testid="chat-pane-${id}"] [aria-label="Session status"]`)
      ?.textContent?.trim() ?? null,
  }), priorChatId);
  if (currentPrior.selected !== priorChatId || currentPrior.status !== 'Complete' ||
      currentPrior.draft !== prior.draft) throw new Error('user_chat_changed_during_preflight');
  if (initial.backend !== 'opencode' || initial.connectionId !== 'opencode-cli' ||
      initial.modelId !== 'openai/gpt-6-luna') throw new Error('owned_opencode_route_missing');
  receipt.stage = 'navigate-owned';
  receipt.actedOnUi = true;
  await page.getByTestId(`chat-nav-row-${chatId}`).click({ timeout: 10_000 });
  await page.waitForFunction((id) => document.querySelector(`[data-testid="chat-nav-row-${id}"]`)
    ?.getAttribute('aria-current') === 'page' &&
    Boolean(document.querySelector(`[data-testid="chat-pane-${id}"] [data-composer-input="true"]`)),
  chatId, { timeout: 15_000 });
  const before = await state();
  receipt.before = { mode: before.mode, status: before.status, draftLength: before.draft?.length ?? null,
    userCount: before.messages.filter((message) => message.role === 'user').length,
    assistantCount: before.messages.filter((message) => message.role === 'assistant').length };
  if (!['Complete', 'Cancelled', 'Failed'].includes(before.status) || before.stopVisible ||
      before.draft !== '') throw new Error('owned_chat_not_idle_or_draft_present');
  receipt.stage = 'select-ask';
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  if (before.mode !== 'ask') {
    await pane.getByRole('button', { name: /Mode\. Open mode picker\./ }).click({ timeout: 10_000 });
    await page.getByRole('listbox', { name: 'Chat modes' }).locator('[data-option-id="ask"]')
      .click({ timeout: 10_000 });
  }
  await page.waitForFunction((id) => {
    const selected = document.querySelector(`[data-testid="chat-nav-row-${id}"]`)
      ?.getAttribute('aria-current') === 'page';
    const button = document.querySelector(`[data-testid="chat-pane-${id}"] button[aria-label="Ask Mode. Open mode picker."]`);
    return selected && Boolean(button);
  }, chatId, { timeout: 8_000 });
  const selected = await state();
  receipt.selectedMode = selected.mode;
  receipt.selectedChat = selected.selected;
  receipt.selectedModeButton = await pane.getByRole('button', { name: /Mode\. Open mode picker\./ })
    .getAttribute('aria-label').catch(() => null);
  receipt.selectedMessageCount = selected.messages.length;
  if (selected.mode !== 'ask' || selected.selected !== chatId ||
      selected.messages.some((message) => message.role === 'user' &&
        !before.messages.some((old) => old.id === message.id)))
    throw new Error('ask_mode_selection_failed_or_dispatched');
  const input = pane.locator('[data-composer-input="true"]');
  await input.fill(prompt, { timeout: 10_000 });
  if (await input.inputValue() !== prompt) throw new Error('exact_draft_mismatch');
  fs.writeFileSync(guardPath, `${JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: hash(prompt), beforeMessageIds: before.messages.map((message) => message.id) }, null, 2)}\n`,
  { flag: 'wx' });
  receipt.sent = true;
  receipt.sentAt = new Date().toISOString();
  receipt.stage = 'sent';
  await pane.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 10_000 });
  let after;
  for (let i = 0; i < 150; i += 1) {
    await page.waitForTimeout(500);
    after = await state();
    const freshAssistant = after.messages.filter((message) => message.role === 'assistant' &&
      !before.messages.some((old) => old.id === message.id));
    if (['Complete', 'Failed', 'Cancelled'].includes(after.status) && freshAssistant.length) break;
  }
  const newUsers = after.messages.filter((message) => message.role === 'user' &&
    !before.messages.some((old) => old.id === message.id));
  const newAssistants = after.messages.filter((message) => message.role === 'assistant' &&
    !before.messages.some((old) => old.id === message.id));
  receipt.after = { status: after.status, mode: after.mode,
    newUsers: newUsers.map((message) => ({ id: message.id, textSha256: hash(message.text) })),
    newAssistants: newAssistants.map((message) => ({ id: message.id,
      textSha256: hash(message.text), hasMarker: message.text.includes(marker),
      toolNames: message.toolNames })),
  };
  receipt.observationLatencyMs = Date.now() - Date.parse(receipt.sentAt);
  receipt.passed = after.status === 'Complete' && after.mode === 'ask' &&
    newUsers.length === 1 && hash(newUsers[0].text) === hash(prompt) &&
    newAssistants.length === 1 && newAssistants[0].text.includes(marker) &&
    newAssistants[0].toolNames.length === 0;
  receipt.stage = receipt.passed ? 'complete' : 'failed';
  if (!receipt.passed) throw new Error('native_ask_mode_expectation_failed');
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(async () => {
  if (page && priorChatId) {
    try {
      const selected = await page.evaluate(() => document
        .querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')
        ?.getAttribute('data-testid')?.replace(/^chat-nav-row-/, '') ?? null);
      if (selected === chatId && await page.getByTestId(`chat-nav-row-${priorChatId}`).count() === 1) {
        await page.getByTestId(`chat-nav-row-${priorChatId}`).click({ timeout: 10_000 });
        receipt.restoredPriorChat = await page.getByTestId(`chat-nav-row-${priorChatId}`)
          .getAttribute('aria-current') === 'page';
        if (receipt.restoredPriorChat && receipt.prior) {
          const restoredDraft = await page.locator(`[data-testid="chat-pane-${priorChatId}"] [data-composer-input="true"]`)
            .inputValue({ timeout: 10_000 });
          receipt.restoredDraftSha256 = hash(restoredDraft);
          receipt.restoredDraftMatches = hash(restoredDraft) === receipt.prior.draftSha256;
        }
      } else receipt.restoredPriorChat = false;
    } catch (error) { receipt.restoreError = String(error?.message ?? error); }
  }
  if (receipt.passed && (!receipt.restoredPriorChat || !receipt.restoredDraftMatches)) {
    receipt.passed = false;
    receipt.stage = 'failed';
    receipt.error = 'prior_chat_or_draft_not_restored';
  }
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    sent: receipt.sent, after: receipt.after ?? null, restoredPriorChat: receipt.restoredPriorChat ?? null,
    error: receipt.error ?? null, restoreError: receipt.restoreError ?? null })}\n`);
  if (browser) await browser.close();
  process.exit(receipt.stage === 'complete' && receipt.passed ? 0 : 1);
});

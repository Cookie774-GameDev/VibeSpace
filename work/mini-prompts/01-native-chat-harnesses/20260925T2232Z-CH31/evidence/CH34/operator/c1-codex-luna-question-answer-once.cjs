'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const prompt = 'Use your native question tool to ask me one harmless random preference question. Do not just print the question as ordinary text. Do not edit files or run commands.';
const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
const preflightPath = path.join(__dirname, 'c1-codex-luna-answer-preflight-recheck.json');
const sendGuardPath = path.join(__dirname, 'codex-luna-question-answer-send-attempt.json');
const answerGuardPath = path.join(__dirname, 'codex-luna-question-answer-submit-attempt.json');
const receipt = {
  at: new Date().toISOString(), lane: 'native-codex-luna-question-answer', chatId,
  promptSha256: promptHash, stage: 'preflight', providerSendAttempted: false,
  answerSubmitAttempted: false,
};
let browser;

function requireState(condition, code) {
  if (!condition) throw new Error(code);
}

async function state(page, detailIds = []) {
  return page.evaluate(async ({ expectedChatId, includedDetails }) => {
    const [{ db, openDb }, { useUIStore }, { resolveChatBackendAffinity }] = await Promise.all([
      import('/src/lib/db/database.ts'),
      import('/src/stores/ui.ts'),
      import('/src/lib/ai/backend/chatBackend.ts'),
    ]);
    await openDb();
    const chat = await db.chats.get(expectedChatId);
    const rows = await db.messages.where('chat_id').equals(expectedChatId).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${expectedChatId}"]`);
    const sha256 = async (value) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    const messages = await Promise.all(rows.map(async (row) => {
      const textParts = (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text);
      const text = textParts.join('\n');
      return {
        id: row.id,
        role: row.role,
        textHash: await sha256(text),
        textLength: text.length,
        toolNames: (row.parts ?? []).filter((part) => part.kind === 'tool_call')
          .map((part) => part.name ?? part.tool_name ?? '').filter(Boolean),
      };
    }));
    const questions = rows.flatMap((row) => (row.parts ?? []).filter((part) => part.kind === 'question_block')
      .map((part) => ({
        messageId: row.id,
        id: part.block?.id ?? null,
        status: part.block?.status ?? null,
        protocol: part.harness?.protocol ?? null,
        requestId: part.harness?.requestId ?? null,
        sessionId: part.harness?.sessionId ?? null,
        ...(includedDetails.includes(part.block?.id) ? {
          details: {
            title: part.block?.title ?? null,
            questions: (part.block?.questions ?? []).map((question) => ({
              id: question.id,
              prompt: question.prompt,
              required: question.required,
              options: (question.options ?? []).map((option) => ({ id: option.id, label: option.label })),
            })),
          },
          answers: part.block?.answers ?? [],
        } : {}),
      })));
    const selection = (await import('/src/stores/auth.ts')).useAuthStore.getState().chatModelSelection;
    const stop = pane?.querySelector('button[aria-label="Stop current request"]');
    const draft = pane?.querySelector('[data-composer-input="true"]')?.value ?? null;
    return {
      activeChatMatches: useUIStore.getState().activeChatId === expectedChatId,
      backend: chat ? resolveChatBackendAffinity(chat.backend_affinity, {
        hasCommittedUserMessage: rows.some((row) => row.role === 'user'), chatCreatedAt: chat.created_at,
      }).backend : null,
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      selectedRoute: selection?.mode === 'single' ? {
        connectionId: selection.connectionId, providerId: selection.providerId, modelId: selection.modelId,
      } : null,
      runStatus: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      stopVisible: Boolean(stop?.getBoundingClientRect().width),
      draftLength: draft?.length ?? null,
      userCount: rows.filter((row) => row.role === 'user').length,
      users: messages.filter((message) => message.role === 'user').map(({ id, textHash }) => ({ id, textHash })),
      assistantCount: rows.filter((row) => row.role === 'assistant').length,
      messages,
      questions,
    };
  }, { expectedChatId: chatId, includedDetails: detailIds });
}

(async () => {
  requireState(!fs.existsSync(sendGuardPath) && !fs.existsSync(answerGuardPath), 'once_only_send_or_answer_guard_exists');
  const fixture = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
  requireState(fixture.safeToProceed === true, 'native_codex_luna_preflight_not_safe');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 15000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const mains = await Promise.all(pages.map(async (page) => ({
    page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null),
  })));
  const official = mains.filter(({ page, label }) => {
    try {
      const url = new URL(page.url());
      return label === 'main' && url.origin === 'http://localhost:5173' && url.pathname === '/';
    } catch {
      return false;
    }
  });
  requireState(official.length === 1, 'exact_official_c1_main_required');
  const page = official[0].page;
  const source = await page.request.get('http://localhost:5173/src/lib/ai/runtime.ts');
  requireState(source.ok() && (await source.text()).includes('cancelPendingProjectedNativeQuestions('),
    'canonical_cancel_source_not_served');

  const before = await state(page);
  receipt.before = {
    activeChatMatches: before.activeChatMatches,
    backend: before.backend,
    connectionId: before.connectionId,
    modelId: before.modelId,
    selectedRoute: before.selectedRoute,
    runStatus: before.runStatus,
    stopVisible: before.stopVisible,
    draftLength: before.draftLength,
    userCount: before.userCount,
    userIds: before.users.map((user) => user.id),
    assistantCount: before.assistantCount,
    questions: before.questions.map(({ id, status, protocol, requestId }) => ({ id, status, protocol, requestId })),
  };
  const preflightQuestions = fixture.snapshot.questions.map(({ id, status }) => ({ id, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const currentQuestions = before.questions.map(({ id, status }) => ({ id, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  requireState(JSON.stringify(preflightQuestions) === JSON.stringify(currentQuestions), 'question_fixture_changed_since_preflight');
  requireState(before.activeChatMatches && before.backend === 'codex' && before.connectionId === 'openai-codex' &&
    before.modelId === 'gpt-6-luna' && before.runStatus === 'Cancelled' && !before.stopVisible && before.draftLength === 0,
    'exact_idle_codex_luna_chat_required');

  const input = page.locator(`[data-testid="chat-pane-${chatId}"] [data-composer-input="true"]`);
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  requireState(await input.count() === 1 && await input.isVisible() && await send.count() === 1 && await send.isEnabled(),
    'native_composer_or_send_button_unavailable');
  await input.fill(prompt, { timeout: 12000 });
  requireState(await input.inputValue() === prompt, 'exact_prompt_not_in_composer');
  fs.writeFileSync(sendGuardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: promptHash, status: 'before-send', beforeQuestionIds: before.questions.map((question) => question.id) }, null, 2) + '\n', { flag: 'wx' });
  receipt.providerSendAttempted = true;
  receipt.stage = 'sent';
  receipt.sentAt = new Date().toISOString();
  await send.click({ timeout: 12000 });

  const newQuestionDeadline = Date.now() + 120000;
  let pending;
  while (Date.now() < newQuestionDeadline) {
    await page.waitForTimeout(500);
    pending = await state(page);
    if (!pending.activeChatMatches) throw new Error('chat_switched_during_question_wait');
    const newQuestions = pending.questions.filter((question) => !before.questions.some((old) => old.id === question.id));
    if (newQuestions.some((question) => question.status === 'pending') ||
      ['Failed', 'Cancelled', 'Complete'].includes(pending.runStatus)) break;
  }
  const newQuestions = pending?.questions.filter((question) => !before.questions.some((old) => old.id === question.id)) ?? [];
  receipt.pendingObservedAt = new Date().toISOString();
  receipt.pending = {
    runStatus: pending?.runStatus,
    userCount: pending?.userCount,
    newQuestionCount: newQuestions.length,
    newQuestionIds: newQuestions.map((question) => question.id),
  };
  requireState(newQuestions.length === 1 && newQuestions[0].status === 'pending' &&
    newQuestions[0].protocol === 'opencode-question-v1' && Boolean(newQuestions[0].requestId),
    'one_new_native_question_required_no_answer_attempted');

  const questionBlockId = newQuestions[0].id;
  const pendingWithDetails = await state(page, [questionBlockId]);
  const target = pendingWithDetails.questions.find((question) => question.id === questionBlockId);
  const question = target?.details?.questions?.length === 1 ? target.details.questions[0] : null;
  requireState(target?.status === 'pending' && question && question.prompt && question.options.length >= 2,
    'one_question_with_multiple_native_choices_required_no_answer_attempted');
  const card = page.locator('.question-card--inline').filter({ hasText: question.prompt });
  requireState(await card.count() === 1 && await card.isVisible(), 'unique_new_question_card_not_visible');
  const optionButtons = card.locator('.question-card__option');
  requireState(await optionButtons.count() === question.options.length, 'native_card_option_count_mismatch');
  const firstOption = question.options[0];
  const firstButton = optionButtons.nth(0);
  const displayedLabel = (await firstButton.locator('span').nth(1).innerText()).trim();
  requireState(displayedLabel === firstOption.label, 'native_option_order_differs_from_persisted_question');

  fs.writeFileSync(answerGuardPath, JSON.stringify({ at: new Date().toISOString(), chatId,
    questionBlockId, requestId: target.requestId, questionId: question.id,
    selectedOptionId: firstOption.id, selectedOptionLabel: firstOption.label, status: 'before-native-selection' }, null, 2) + '\n', { flag: 'wx' });
  receipt.question = {
    blockId: questionBlockId,
    messageId: target.messageId,
    requestId: target.requestId,
    protocol: target.protocol,
    questionId: question.id,
    prompt: question.prompt,
    choices: question.options.map(({ id, label }) => ({ id, label })),
  };
  receipt.answerStartedAt = new Date().toISOString();
  receipt.stage = 'answer-native-question';
  await firstButton.click({ timeout: 12000 });
  requireState(await firstButton.getAttribute('aria-pressed') === 'true', 'native_option_selection_not_visible');
  const submit = card.getByRole('button', { name: 'Submit', exact: true });
  requireState(await submit.count() === 1 && await submit.isEnabled(), 'native_question_submit_unavailable');
  receipt.answerSubmitAttempted = true;
  await submit.click({ timeout: 12000 });

  const completionDeadline = Date.now() + 90000;
  let after;
  while (Date.now() < completionDeadline) {
    await page.waitForTimeout(500);
    after = await state(page, [questionBlockId]);
    if (!after.activeChatMatches) throw new Error('chat_switched_during_answer_wait');
    const resolvedBlock = after.questions.find((entry) => entry.id === questionBlockId);
    const baselineStatusesPreserved = before.questions.every((old) =>
      after.questions.find((entry) => entry.id === old.id)?.status === old.status);
    if (resolvedBlock?.status === 'answered' && after.runStatus === 'Complete' && baselineStatusesPreserved) break;
    if (['Failed', 'Cancelled', 'Stopped'].includes(after.runStatus)) break;
  }
  const resolvedBlock = after?.questions.find((entry) => entry.id === questionBlockId);
  const newUserMessages = after?.users.filter((user) => !before.users.some((old) => old.id === user.id)) ?? [];
  const newAssistantMessages = after?.messages.filter((message) => message.role === 'assistant' &&
    !before.messages.some((old) => old.id === message.id)) ?? [];
  const preAnswerHashes = new Set(pendingWithDetails.messages.filter((message) => message.role === 'assistant')
    .map((message) => message.textHash));
  const newAssistantContinuationCount = (after?.messages ?? []).filter((message) => message.role === 'assistant' &&
    message.textLength > 0 && !preAnswerHashes.has(message.textHash)).length;
  const answer = resolvedBlock?.answers?.length === 1 ? resolvedBlock.answers[0] : null;
  const baselineStatusesPreserved = before.questions.every((old) =>
    after?.questions.find((entry) => entry.id === old.id)?.status === old.status);
  const questionNotDuplicated = after?.questions.filter((entry) => !before.questions.some((old) => old.id === entry.id)).length === 1;
  const oneUserPrompt = newUserMessages.length === 1 && newUserMessages[0].textHash === promptHash;
  const oneAnswer = Boolean(answer && answer.questionId === question.id &&
    answer.selectedOptionIds?.length === 1 && answer.selectedOptionIds[0] === firstOption.id && !answer.skipped);
  receipt.after = {
    runStatus: after?.runStatus,
    stopVisible: after?.stopVisible,
    userCount: after?.userCount,
    newUserMessageIds: newUserMessages.map((user) => user.id),
    newAssistantMessageCount: newAssistantMessages.length,
    newAssistantContinuationCount,
    resolvedQuestion: resolvedBlock && {
      id: resolvedBlock.id, status: resolvedBlock.status, requestId: resolvedBlock.requestId,
      answers: resolvedBlock.answers,
    },
    baselineStatusesPreserved,
    questionNotDuplicated,
    oneUserPrompt,
    oneAnswer,
  };
  receipt.answerResolvedAt = new Date().toISOString();
  receipt.questionLatencyMs = Date.parse(receipt.pendingObservedAt) - Date.parse(receipt.sentAt);
  receipt.answerReconcileLatencyMs = Date.parse(receipt.answerResolvedAt) - Date.parse(receipt.answerStartedAt);
  receipt.passed = receipt.after.runStatus === 'Complete' && !receipt.after.stopVisible &&
    resolvedBlock?.status === 'answered' && oneUserPrompt && oneAnswer && questionNotDuplicated &&
    baselineStatusesPreserved && newAssistantContinuationCount >= 1;
  receipt.stage = 'complete';
  if (!receipt.passed) process.exitCode = 1;
})().catch((error) => {
  receipt.failure = String(error?.message ?? error);
  process.exitCode = 1;
}).finally(async () => {
  receipt.finishedAt = new Date().toISOString();
  const output = path.join(__dirname, `native-codex-luna-question-answer-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    providerSendAttempted: receipt.providerSendAttempted, answerSubmitAttempted: receipt.answerSubmitAttempted,
    questionBlockId: receipt.question?.blockId, failure: receipt.failure }));
  if (browser) await browser.close();
});

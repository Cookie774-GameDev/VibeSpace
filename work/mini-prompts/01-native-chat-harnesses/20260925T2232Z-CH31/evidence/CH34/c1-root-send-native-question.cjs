const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const prompt = 'Use your native question tool to ask me one harmless random preference question. Do not just print the question as ordinary text. Do not edit files or run commands.';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const guard = path.join(__dirname, 'c1-root-question-send-once.json');
const output = path.join(__dirname, `c1-root-send-native-question-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), chatId, promptSha256: hash(prompt),
  stage: 'preflight', sent: false };

async function state(page) {
  return page.evaluate(async (id) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
    return {
      navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
      paneVisible: Boolean(pane?.getBoundingClientRect().width),
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      backend: chat?.backend_affinity?.backend ?? null,
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')),
      draft: pane?.querySelector('[data-composer-input="true"]')?.value ?? null,
      users: rows.filter((row) => row.role === 'user').map((row) => ({ id: row.id,
        text: (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n') })),
      questions: rows.flatMap((row) => (row.parts ?? []).filter((part) => part.kind === 'question_block')
        .map((part) => ({ id: part.block.id, status: part.block.status,
          requestId: part.harness?.requestId ?? null,
          protocol: part.harness?.protocol ?? null })) ),
    };
  }, chatId);
}

(async () => {
  if (fs.existsSync(guard)) throw new Error('once_only_send_guard_exists');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null),
  })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official C1 main page, got ${mains.length}`);
  const page = mains[0].page;
  receipt.mainUrl = page.url();
  const served = await page.request.get('http://localhost:5173/src/lib/ai/runtime.ts');
  if (!served.ok() || !(await served.text()).includes('cancelPendingProjectedNativeQuestions('))
    throw new Error('current_runtime_source_not_served');
  const before = await state(page);
  receipt.before = { ...before, users: before.users.map((user) => ({ id: user.id, hash: hash(user.text) })) };
  if (before.navCurrent !== 'page' || !before.paneVisible || before.connectionId !== 'openai-codex' ||
      before.modelId !== 'gpt-6-luna' || before.backend !== 'codex' ||
      !['Failed', 'Cancelled', 'Complete'].includes(before.status) || before.stopVisible || before.draft !== '')
    throw new Error('exact_idle_codex_fixture_required');
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  const input = pane.locator('[data-composer-input="true"]');
  const send = pane.getByRole('button', { name: 'Send message', exact: true });
  if (await input.count() !== 1 || !(await input.isVisible()) ||
      await send.count() !== 1)
    throw new Error('native_composer_or_send_not_ready');
  await input.fill(prompt, { timeout: 10_000 });
  if (await input.inputValue() !== prompt) throw new Error('composer_text_mismatch');
  if (!(await send.isEnabled())) throw new Error('send_remains_disabled_after_exact_draft');
  fs.writeFileSync(guard, `${JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: hash(prompt), beforeUserIds: before.users.map((user) => user.id),
    beforeQuestionIds: before.questions.map((question) => question.id) }, null, 2)}\n`, { flag: 'wx' });
  receipt.sent = true;
  receipt.sentAt = new Date().toISOString();
  receipt.stage = 'sent';
  await send.click({ timeout: 10_000 });
  let after;
  for (let i = 0; i < 180; i += 1) {
    await page.waitForTimeout(500);
    after = await state(page);
    const fresh = after.questions.filter((question) => !before.questions.some((old) => old.id === question.id));
    if (fresh.some((question) => question.status === 'pending') ||
        ['Failed', 'Cancelled', 'Complete'].includes(after.status)) break;
  }
  const newQuestions = after.questions.filter((question) =>
    !before.questions.some((old) => old.id === question.id));
  const newUsers = after.users.filter((user) => !before.users.some((old) => old.id === user.id));
  receipt.after = { status: after.status, stopVisible: after.stopVisible,
    newQuestions, newUsers: newUsers.map((user) => ({ id: user.id, hash: hash(user.text) })) };
  receipt.questionObservedAt = new Date().toISOString();
  receipt.observationLatencyMs = Date.parse(receipt.questionObservedAt) - Date.parse(receipt.sentAt);
  receipt.passed = newUsers.length === 1 && hash(newUsers[0].text) === hash(prompt) &&
    newQuestions.length === 1 && newQuestions[0].status === 'pending' &&
    newQuestions[0].requestId?.startsWith('que_codex_') &&
    newQuestions[0].protocol === 'opencode-question-v1';
  receipt.stage = 'complete';
  if (!receipt.passed) throw new Error('new_native_codex_question_not_observed');
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' && receipt.passed ? 0 : 1);
});

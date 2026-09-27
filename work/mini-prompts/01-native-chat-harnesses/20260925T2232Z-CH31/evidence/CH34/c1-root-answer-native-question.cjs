const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const blockId = 'qb_opencode_0a1ftvv1cojj3d';
const requestId = 'que_codex_629635e7-5b17-4fa2-ac80-966709bd2e20';
const guard = path.join(__dirname, 'c1-root-question-answer-once.json');
const output = path.join(__dirname, `c1-root-answer-native-question-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), chatId, blockId, requestId,
  stage: 'preflight', optionClicked: false, submitClicked: false };

async function state(page) {
  return page.evaluate(async ({ chatId, blockId }) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const rows = await db.messages.where('chat_id').equals(chatId).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${chatId}"]`);
    const blocks = rows.flatMap((row) => (row.parts ?? [])
      .filter((part) => part.kind === 'question_block')
      .map((part) => ({ messageId: row.id, id: part.block.id, status: part.block.status,
        requestId: part.harness?.requestId ?? null,
        protocol: part.harness?.protocol ?? null,
        questions: part.block.questions?.map((question) => ({
          id: question.id, prompt: question.prompt,
          options: (question.options ?? []).map((option) => ({ id: option.id, label: option.label })),
        })) ?? [], answers: part.block.answers ?? [] })));
    return { navCurrent: document.querySelector(`[data-testid="chat-nav-row-${chatId}"]`)
      ?.getAttribute('aria-current'),
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')),
      userCount: rows.filter((row) => row.role === 'user').length,
      assistantCount: rows.filter((row) => row.role === 'assistant').length,
      blocks, target: blocks.find((block) => block.id === blockId) ?? null };
  }, { chatId, blockId });
}

(async () => {
  if (fs.existsSync(guard)) throw new Error('once_only_answer_guard_exists');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  const before = await state(page);
  receipt.before = before;
  const question = before.target?.questions?.length === 1 ? before.target.questions[0] : null;
  if (before.navCurrent !== 'page' || before.status !== 'Running' || !before.stopVisible ||
      before.target?.status !== 'pending' || before.target.requestId !== requestId ||
      before.target.protocol !== 'opencode-question-v1' ||
      !question?.prompt || question.options.length < 1)
    throw new Error('exact_live_native_question_not_ready');
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  const card = pane.locator('.question-card--inline').filter({ hasText: question.prompt });
  if (await card.count() !== 1 || !(await card.isVisible()))
    throw new Error('unique_visible_question_card_required');
  const options = card.locator('.question-card__option');
  if (await options.count() !== question.options.length)
    throw new Error('native_card_option_count_mismatch');
  const first = options.first();
  fs.writeFileSync(guard, `${JSON.stringify({ at: new Date().toISOString(), chatId,
    blockId, requestId, questionId: question.id, selectedOptionId: question.options[0].id,
    status: 'before-selection' }, null, 2)}\n`, { flag: 'wx' });
  receipt.optionClicked = true;
  receipt.stage = 'select';
  await first.click({ timeout: 10_000 });
  if (await first.getAttribute('aria-pressed') !== 'true') throw new Error('option_not_selected');
  const submit = card.getByRole('button', { name: 'Submit', exact: true });
  if (await submit.count() !== 1 || !(await submit.isEnabled()))
    throw new Error('native_question_submit_not_ready');
  receipt.submitClicked = true;
  receipt.submitAt = new Date().toISOString();
  receipt.stage = 'submitted';
  await submit.click({ timeout: 10_000 });
  let after;
  for (let i = 0; i < 180; i += 1) {
    await page.waitForTimeout(500);
    after = await state(page);
    if (after.target?.status === 'answered' && after.status === 'Complete') break;
    if (['Failed', 'Cancelled'].includes(after.status)) break;
  }
  receipt.after = after;
  receipt.answerLatencyMs = Date.now() - Date.parse(receipt.submitAt);
  receipt.passed = after.target?.status === 'answered' && after.status === 'Complete' &&
    after.userCount === before.userCount &&
    before.blocks.every((block) => block.id === blockId ||
      after.blocks.find((item) => item.id === block.id)?.status === block.status);
  receipt.stage = 'complete';
  if (!receipt.passed) throw new Error('native_answer_continuation_not_complete');
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    optionClicked: receipt.optionClicked, submitClicked: receipt.submitClicked,
    answerLatencyMs: receipt.answerLatencyMs ?? null, error: receipt.error ?? null })}\n`);
  process.exit(receipt.stage === 'complete' && receipt.passed ? 0 : 1);
});

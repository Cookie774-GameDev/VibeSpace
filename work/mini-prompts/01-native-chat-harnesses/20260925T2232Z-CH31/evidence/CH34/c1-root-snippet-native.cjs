const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const chatId = 'cht_-zkkf_r46zzuxB3L';
const fence = String.fromCharCode(96).repeat(3);
const writing = 'CH34_NATIVE_WRITING_7D2\nCopy me exactly.';
const code = 'const ch34NativeSnippet = 42;';
const prompt = `Reply with exactly these two fenced snippets and no other text. Do not run tools or edit files.\n${fence}text\n${writing}\n${fence}\n${fence}typescript\n${code}\n${fence}`;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const guard = path.join(__dirname, 'c1-root-snippet-send-once.json');
const output = path.join(__dirname, `c1-root-snippet-native-${Date.now()}.json`);
const writingPng = path.join(__dirname, 'c1-root-snippet-writing.png');
const codePng = path.join(__dirname, 'c1-root-snippet-code.png');
const receipt = { at: new Date().toISOString(), chatId, promptSha256: hash(prompt),
  expectedWritingSha256: hash(writing), expectedCodeSha256: hash(code), stage: 'preflight', sent: false };

async function state(page) {
  return page.evaluate(async (id) => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const chat = await db.chats.get(id);
    const rows = await db.messages.where('chat_id').equals(id).toArray();
    const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
    const input = pane?.querySelector('[data-composer-input="true"]');
    return {
      navCurrent: document.querySelector(`[data-testid="chat-nav-row-${id}"]`)?.getAttribute('aria-current'),
      backend: chat?.backend_affinity?.backend ?? null,
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')),
      draft: input?.value ?? null,
      users: rows.filter((row) => row.role === 'user').map((row) => ({ id: row.id,
        text: (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n') })),
      assistants: rows.filter((row) => row.role === 'assistant').map((row) => ({ id: row.id,
        text: (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n'),
        toolCount: (row.parts ?? []).filter((part) => part.kind === 'tool_call').length })),
      renderedSnippets: pane?.querySelectorAll('[data-assistant-snippet]').length ?? 0,
    };
  }, chatId);
}

(async () => {
  if (fs.existsSync(guard)) throw new Error('once_only_snippet_guard_exists');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
    page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  const served = await page.request.get('http://localhost:5173/src/features/chat/assistant-rich-text.css');
  if (!served.ok() || !(await served.text()).includes('.assistant-rich-text__snippet--writing code'))
    throw new Error('final_snippet_css_not_served');
  const before = await state(page);
  receipt.before = { ...before,
    users: before.users.map((user) => ({ id: user.id, hash: hash(user.text) })),
    assistants: before.assistants.map((assistant) => ({ id: assistant.id, toolCount: assistant.toolCount })) };
  if (before.navCurrent !== 'page' || before.backend !== 'codex' ||
      before.connectionId !== 'openai-codex' || before.modelId !== 'gpt-6-luna' ||
      before.status !== 'Complete' || before.stopVisible || before.draft !== '')
    throw new Error('exact_idle_codex_chat_required');
  const pane = page.getByTestId(`chat-pane-${chatId}`);
  const input = pane.locator('[data-composer-input="true"]');
  const send = pane.getByRole('button', { name: 'Send message', exact: true });
  if (await input.count() !== 1 || !(await input.isVisible()) || await send.count() !== 1)
    throw new Error('native_composer_unavailable');
  await input.fill(prompt, { timeout: 10_000 });
  if (await input.inputValue() !== prompt || !(await send.isEnabled()))
    throw new Error('exact_snippet_draft_not_ready');
  fs.writeFileSync(guard, `${JSON.stringify({ at: new Date().toISOString(), chatId,
    promptSha256: hash(prompt), beforeUserIds: before.users.map((user) => user.id) }, null, 2)}\n`,
  { flag: 'wx' });
  receipt.sent = true;
  receipt.sentAt = new Date().toISOString();
  receipt.stage = 'sent';
  await send.click({ timeout: 10_000 });
  let after;
  for (let i = 0; i < 180; i += 1) {
    await page.waitForTimeout(500);
    after = await state(page);
    const fresh = after.assistants.filter((assistant) =>
      !before.assistants.some((old) => old.id === assistant.id));
    if (after.status === 'Complete' && fresh.length > 0) break;
    if (['Failed', 'Cancelled'].includes(after.status)) break;
  }
  const newUsers = after.users.filter((user) => !before.users.some((old) => old.id === user.id));
  const newAssistants = after.assistants.filter((assistant) =>
    !before.assistants.some((old) => old.id === assistant.id));
  receipt.after = { status: after.status,
    newUsers: newUsers.map((user) => ({ id: user.id, hash: hash(user.text) })),
    newAssistants: newAssistants.map((assistant) => ({ id: assistant.id,
      textLength: assistant.text.length, textHash: hash(assistant.text), toolCount: assistant.toolCount,
      hasWriting: assistant.text.includes(writing), hasCode: assistant.text.includes(code) })),
    renderedSnippets: after.renderedSnippets };
  if (newUsers.length !== 1 || hash(newUsers[0].text) !== hash(prompt) ||
      after.status !== 'Complete' || !newAssistants.some((assistant) =>
        assistant.text.includes(writing) && assistant.text.includes(code)))
    throw new Error('provider_did_not_complete_exact_fenced_snippets');
  const writingCard = pane.locator('[data-assistant-snippet="writing"]').filter({ hasText: writing });
  const codeCard = pane.locator('[data-assistant-snippet="typescript"]').filter({ hasText: code });
  if (await writingCard.count() !== 1 || await codeCard.count() !== 1 ||
      !(await writingCard.isVisible()) || !(await codeCard.isVisible()))
    throw new Error('native_snippet_cards_not_rendered');
  receipt.visual = await page.evaluate(({ writing, code }) => {
    const cards = [...document.querySelectorAll('[data-assistant-snippet]')];
    const writingCard = cards.find((card) => card.getAttribute('data-assistant-snippet') === 'writing' &&
      card.textContent?.includes(writing));
    const codeCard = cards.find((card) => card.getAttribute('data-assistant-snippet') === 'typescript' &&
      card.textContent?.includes(code));
    const inspect = (card) => card ? ({
      label: card.querySelector('.assistant-rich-text__snippet-label')?.textContent?.trim(),
      body: card.querySelector('pre code')?.textContent,
      fontFamily: getComputedStyle(card.querySelector('pre code')).fontFamily,
      backgroundImage: getComputedStyle(card).backgroundImage,
      borderRadius: getComputedStyle(card).borderRadius,
      copyLabel: card.querySelector('button')?.getAttribute('aria-label'),
    }) : null;
    return { writing: inspect(writingCard), code: inspect(codeCard) };
  }, { writing, code });
  await writingCard.screenshot({ path: writingPng, timeout: 10_000 });
  await codeCard.screenshot({ path: codePng, timeout: 10_000 });
  receipt.screenshots = [writingPng, codePng];
  await writingCard.getByRole('button', { name: 'Copy text' }).click({ timeout: 10_000 });
  receipt.writingCopyFeedback = await writingCard.getByRole('button', { name: 'Copied text' })
    .isVisible().catch(() => false);
  receipt.writingClipboardMatch = await page.evaluate(async (expected) => {
    try { return (await navigator.clipboard.readText()) === expected; }
    catch { return null; }
  }, writing);
  await codeCard.getByRole('button', { name: 'Copy code' }).click({ timeout: 10_000 });
  receipt.codeCopyFeedback = await codeCard.getByRole('button', { name: 'Copied code' })
    .isVisible().catch(() => false);
  receipt.codeClipboardMatch = await page.evaluate(async (expected) => {
    try { return (await navigator.clipboard.readText()) === expected; }
    catch { return null; }
  }, code);
  receipt.passed = receipt.visual.writing?.label === 'Writing' &&
    receipt.visual.writing?.body === writing &&
    receipt.visual.code?.label === 'typescript' && receipt.visual.code?.body === code &&
    receipt.writingCopyFeedback && receipt.codeCopyFeedback &&
    receipt.writingClipboardMatch !== false && receipt.codeClipboardMatch !== false;
  receipt.stage = 'complete';
  if (!receipt.passed) throw new Error('native_snippet_visual_or_copy_failed');
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, stage: receipt.stage, passed: receipt.passed ?? false,
    sent: receipt.sent, visual: receipt.visual ?? null,
    writingCopyFeedback: receipt.writingCopyFeedback ?? null,
    codeCopyFeedback: receipt.codeCopyFeedback ?? null,
    writingClipboardMatch: receipt.writingClipboardMatch ?? null,
    codeClipboardMatch: receipt.codeClipboardMatch ?? null,
    error: receipt.error ?? null })}\n`);
  process.exit(receipt.stage === 'complete' && receipt.passed ? 0 : 1);
});

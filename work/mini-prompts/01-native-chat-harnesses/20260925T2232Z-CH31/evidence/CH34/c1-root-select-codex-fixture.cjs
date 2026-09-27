const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const targetChatId = 'cht_-zkkf_r46zzuxB3L';
const output = path.join(__dirname, `c1-root-select-codex-fixture-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), targetChatId, stage: 'attach', navigated: false };

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const tagged = await Promise.all(pages.map(async (page) => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  const page = mains[0].page;
  receipt.mainUrl = page.url();
  receipt.before = await page.evaluate(async () => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    const activeChatId = useUIStore.getState().activeChatId;
    const pane = document.querySelector(`[data-testid="chat-pane-${activeChatId}"]`);
    const input = pane?.querySelector('[data-composer-input="true"]');
    return { activeChatId, status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
      draftLength: input?.value?.length ?? null, composerFocused: document.activeElement === input,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')) };
  });
  if (!['Complete', 'Cancelled', 'Failed'].includes(receipt.before.status) ||
      receipt.before.draftLength !== 0 || receipt.before.composerFocused || receipt.before.stopVisible) {
    throw new Error('current_chat_not_idle_or_user_composing');
  }
  receipt.stage = 'navigate';
  await page.getByTestId(`chat-nav-row-${targetChatId}`).click({ timeout: 10_000 });
  receipt.navigated = true;
  const pane = page.getByTestId(`chat-pane-${targetChatId}`);
  await pane.waitFor({ state: 'visible', timeout: 10_000 });
  receipt.after = await page.evaluate(async (chatId) => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
    ]);
    await openDb();
    const chat = await db.chats.get(chatId);
    const pane = document.querySelector(`[data-testid="chat-pane-${chatId}"]`);
    const input = pane?.querySelector('[data-composer-input="true"]');
    const route = useAuthStore.getState().chatModelSelection;
    return { activeChatId: useUIStore.getState().activeChatId,
      navCurrent: document.querySelector(`[data-testid="chat-nav-row-${chatId}"]`)?.getAttribute('aria-current'),
      backend: chat?.backend_affinity?.backend ?? null,
      connectionId: chat?.connection?.id ?? null,
      modelId: chat?.connection?.modelId ?? null,
      selectedRoute: route?.mode === 'single' ? { connectionId: route.connectionId, modelId: route.modelId } : null,
      status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      draftLength: input?.value?.length ?? null,
      stopVisible: Boolean(pane?.querySelector('[aria-label="Stop current request"]')) };
  }, targetChatId);
  if (receipt.after.activeChatId !== targetChatId || receipt.after.navCurrent !== 'page' ||
      receipt.after.backend !== 'codex' || receipt.after.connectionId !== 'openai-codex' ||
      receipt.after.modelId !== 'gpt-6-luna' || receipt.after.draftLength !== 0 ||
      receipt.after.stopVisible) throw new Error('codex_fixture_not_ready_after_navigation');
  receipt.stage = 'complete';
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});

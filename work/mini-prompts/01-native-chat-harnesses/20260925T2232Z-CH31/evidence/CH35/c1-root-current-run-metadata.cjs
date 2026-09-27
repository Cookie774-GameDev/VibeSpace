const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, `c1-root-current-run-metadata-${Date.now()}.json`);
const receipt = { startedAt: new Date().toISOString(), stage: 'attach', actedOnUi: false };
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const tagged = await Promise.all(pages.map(async (page) => ({ page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' && new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official main page, got ${mains.length}`);
  receipt.metadata = await mains[0].page.evaluate(async () => {
    const selected = document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]')?.getAttribute('data-testid');
    const chatId = selected?.replace(/^chat-nav-row-/, '') ?? null;
    if (!chatId) return { chatId: null };
    const persisted = (() => {
      try { return JSON.parse(localStorage.getItem('jarvis-interaction-session') ?? '{}')?.state?.modesByChat ?? {}; }
      catch { return {}; }
    })();
    const [{ db, openDb }, { useJarvisInteractionStore }] = await Promise.all([
      import('/src/lib/db/database.ts'),
      import('/src/features/jarvis-interaction/sessionStore.ts'),
    ]);
    await openDb();
    const rows = await db.messages.where('chat_id').equals(chatId).toArray();
    return {
      chatId,
      selectedMode: useJarvisInteractionStore.getState().modeForChat(chatId),
      ownedCodexMode: useJarvisInteractionStore.getState().modeForChat('cht_-zkkf_r46zzuxB3L'),
      persistedOwnedCodexMode: persisted['cht_-zkkf_r46zzuxB3L'] ?? null,
      status: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
      lastMessageAt: rows.map((row) => row.created_at ?? row.updated_at ?? null).filter(Boolean).at(-1) ?? null,
      messageRoleCounts: rows.reduce((counts, row) => { counts[row.role] = (counts[row.role] ?? 0) + 1; return counts; }, {}),
      questionStatusCounts: rows.flatMap((row) => (row.parts ?? []).filter((part) => part.kind === 'question_block'))
        .reduce((counts, part) => { const status = part.block?.status ?? 'unknown'; counts[status] = (counts[status] ?? 0) + 1; return counts; }, {}),
      draftLength: document.querySelector('[data-composer-input="true"]')?.value?.length ?? null,
    };
  });
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const output = path.join(__dirname, `preflight-opencode-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), actedOnUi: false, stage: 'attach' };
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages())
    .map(async (page) => ({ page,
      label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
        .catch(() => null) })));
  const mains = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error('official_main_missing');
  receipt.chats = await mains[0].page.evaluate(async () => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const ids = ['cht_Eumzyw1Y8yx21W1s', 'cht_vdI_HrV1IHyCNXif'];
    const modes = (() => {
      try { return JSON.parse(localStorage.getItem('jarvis-interaction-session') ?? '{}')?.state?.modesByChat ?? {}; }
      catch { return {}; }
    })();
    return Promise.all(ids.map(async (id) => {
      const chat = await db.chats.get(id);
      const rows = await db.messages.where('chat_id').equals(id).toArray();
      return { id, exists: Boolean(chat), backend: chat?.backend_affinity?.backend ?? null,
        connectionId: chat?.connection?.id ?? null, modelId: chat?.connection?.modelId ?? null,
        mode: modes[id] ?? 'agent',
        userCount: rows.filter((row) => row.role === 'user').length,
        assistantCount: rows.filter((row) => row.role === 'assistant').length,
        pending: rows.flatMap((row) => row.parts ?? []).filter((part) =>
          (part.kind === 'question_block' && part.block?.status === 'pending') ||
          (part.kind === 'permission_request' && part.request?.status === 'pending')).length,
        navPresent: Boolean(document.querySelector(`[data-testid="chat-nav-row-${id}"]`)) };
    }));
  });
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed'; })
  .finally(() => {
    receipt.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
    process.exit(receipt.stage === 'complete' ? 0 : 1);
  });

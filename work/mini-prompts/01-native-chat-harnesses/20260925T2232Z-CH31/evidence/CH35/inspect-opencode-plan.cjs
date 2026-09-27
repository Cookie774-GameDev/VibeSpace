const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const output = path.join(__dirname, `inspect-opencode-plan-${Date.now()}.json`);
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
  receipt.message = await mains[0].page.evaluate(async () => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const row = await db.messages.get('msg_jreq_399ee993-0565-418e-9f40-641f611fbc91');
    if (!row) return null;
    return { role: row.role,
      texts: (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text),
      otherKinds: (row.parts ?? []).filter((part) => part.kind !== 'text').map((part) => part.kind) };
  });
  receipt.stage = 'complete';
})().catch((error) => { receipt.error = String(error?.message ?? error); receipt.stage = 'failed'; })
  .finally(() => {
    receipt.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
    process.exit(receipt.stage === 'complete' ? 0 : 1);
  });

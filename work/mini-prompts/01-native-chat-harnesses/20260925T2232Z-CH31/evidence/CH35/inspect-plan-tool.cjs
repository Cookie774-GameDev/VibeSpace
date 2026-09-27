const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, `inspect-plan-tool-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), actedOnUi: false, stage: 'attach' };
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const tagged = await Promise.all(browser.contexts().flatMap((context) => context.pages())
    .map(async (page) => ({ page,
      label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
        .catch(() => null) })));
  const matches = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (matches.length !== 1) throw new Error('official_main_missing');
  receipt.tool = await matches[0].page.evaluate(async () => {
    const { db, openDb } = await import('/src/lib/db/database.ts');
    await openDb();
    const row = await db.messages.get('msg_jreq_db2d52ee-4a41-4356-a6ed-8d656aae2ece');
    if (!row) return null;
    return (row.parts ?? []).filter((part) => part.kind === 'tool_call').map((part) => ({
      keys: Object.keys(part),
      name: typeof part.tool === 'string' ? part.tool :
        (part.name ?? part.tool?.name ?? part.toolName ?? part.data?.name ?? null),
      input: part.input ?? part.args ?? part.data?.input ?? null,
      callId: part.call_id ?? null,
      detailKeys: part.details && typeof part.details === 'object' ? Object.keys(part.details) : [],
      resultStatus: part.status ?? part.state ?? part.data?.status ?? null,
      outputHasMarker: JSON.stringify(part).includes('CH35_PLAN_READ_4B72'),
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

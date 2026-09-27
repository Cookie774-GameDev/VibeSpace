'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), cdpPort: 9223 };
  try {
    const candidates = browser.contexts().flatMap(context => context.pages());
    const labels = await Promise.all(candidates.map(async page => ({
      page,
      label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null),
    })));
    const main = labels.filter(item => item.label === 'main');
    if (main.length !== 1 || !main[0].page.url().startsWith('http://localhost:5173/')) {
      throw new Error('exact_official_main_required');
    }
    receipt.pageUrl = main[0].page.url();
    receipt.state = await main[0].page.evaluate(async () => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }, { getChatRunState }] = await Promise.all([
        import('/src/lib/db/database.ts'),
        import('/src/stores/ui.ts'),
        import('/src/stores/auth.ts'),
        import('/src/features/chat/runtime/chatRunState.ts'),
      ]);
      await openDb();
      const activeChatId = useUIStore.getState().activeChatId;
      const chat = activeChatId ? await db.chats.get(activeChatId) : null;
      const rows = activeChatId ? await db.messages.where('chat_id').equals(activeChatId).toArray() : [];
      const pending = rows.flatMap(row => row.parts ?? []).filter(part =>
        part?.kind === 'permission_request' && part.request?.status === 'pending').length;
      const input = document.querySelector('[data-composer-input="true"]');
      return {
        windowLabel: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
        route: new URL(location.href).searchParams.get('route'),
        activeChatId,
        projectId: chat?.project_id ?? null,
        selectedProjectId: useAuthStore.getState().projectId ?? null,
        backend: chat?.backend_affinity?.backend ?? null,
        connection: chat?.connection?.id ?? null,
        model: chat?.connection?.modelId ?? null,
        effort: document.querySelector('[data-composer-effort]')?.getAttribute('data-composer-effort') ?? null,
        runStatus: activeChatId ? getChatRunState(activeChatId)?.status ?? null : null,
        userCount: rows.filter(row => row.role === 'user').length,
        assistantCount: rows.filter(row => row.role === 'assistant').length,
        pendingPermissions: pending,
        draftLength: input?.value?.length ?? null,
        stopVisible: Boolean(document.querySelector('button[aria-label="Stop current request"]')?.getBoundingClientRect().width),
      };
    });
    receipt.passed = receipt.state.windowLabel === 'main' && receipt.state.route === 'chat';
  } catch (error) {
    receipt.failure = String(error?.message ?? error);
    process.exitCode = 1;
  } finally {
    const output = path.join(__dirname, `preflight-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), readOnly: true };
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    const labeled = await Promise.all(pages.map(async page => ({ page,
      label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main' && item.page.url().startsWith('http://localhost:5173/'));
    if (main.length !== 1) throw new Error('exact_official_main_required');
    receipt.state = await main[0].page.evaluate(async () => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }, { harnessRuntimeManager },
        { nativeOpenCodeRequest }, { getStoredProjectRoot }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
        import('/src/lib/harness/runtimeManager.ts'), import('/src/lib/harness/openCodeNativeTransport.ts'),
        import('/src/features/files/projectFiles.ts'),
      ]);
      await openDb();
      const projectId = 'prj_ybjv0yXnrGkGhAQY';
      const chats = (await db.chats.where('project_id').equals(projectId).toArray())
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, 15)
        .map(c => ({ id: c.id, title: c.title, backend: c.backend_affinity?.backend ?? null,
          connection: c.backend_affinity?.connectionId ?? null,
          model: c.backend_affinity?.modelId ?? null, updatedAt: c.updated_at ?? null }));
      const connection = harnessRuntimeManager.getConnection();
      const directory = getStoredProjectRoot(projectId);
      const endpoint = async route => {
        if (!connection?.generation || !directory) return { available: false };
        const response = await nativeOpenCodeRequest(connection.generation,
          `${route}?directory=${encodeURIComponent(directory)}`);
        if (!response.ok) return { status: response.status, ok: false };
        const body = await response.json();
        return { status: response.status, ok: true,
          count: Array.isArray(body) ? body.length : Object.keys(body ?? {}).length,
          names: Array.isArray(body) ? body.slice(0, 30).map(row => row.name ?? row.id ?? '') : Object.keys(body ?? {}).slice(0, 30),
          ...(route === '/mcp' && body && !Array.isArray(body) ? {
            serverStatus: Object.entries(body).map(([name, value]) => ({ name,
              status: value?.status ?? null, error: value?.error ? String(value.error).slice(0, 120) : null,
              toolCount: Array.isArray(value?.tools) ? value.tools.length : null })) } : {}) };
      };
      const selection = useAuthStore.getState().chatModelSelection;
      return { activeChatId: useUIStore.getState().activeChatId,
        selection: selection?.mode === 'single' ? { providerId: selection.providerId,
          modelId: selection.modelId, connectionId: selection.connectionId } : null,
        projectRootPresent: Boolean(directory),
        runtimeVersion: connection?.version ?? null, runtimeGenerationPresent: Boolean(connection?.generation),
        chats, commands: await endpoint('/command'), mcp: await endpoint('/mcp'),
        runStatus: document.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null };
    });
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-catalog-preflight-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

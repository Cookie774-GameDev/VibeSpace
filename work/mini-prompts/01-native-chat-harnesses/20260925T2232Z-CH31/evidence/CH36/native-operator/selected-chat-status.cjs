const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright-core');
const output = path.join(__dirname, 'selected-chat-status.json');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const matches = await Promise.all(pages.map(async (page) => ({ page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null) })));
  const mains = matches.filter((entry) => entry.label === 'main' && new URL(entry.page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`Expected one official main page, found ${mains.length}`);
  const page = mains[0].page;
  const state = await page.evaluate(async () => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    const ui = useUIStore.getState();
    const activeChatId = ui.activeChatId == null ? null : String(ui.activeChatId);
    const panes = Array.from(document.querySelectorAll('[data-testid^="chat-pane-"][data-chat-id]')).map((pane) => ({ chatId: pane.getAttribute('data-chat-id'), focused: pane.getAttribute('data-focused') === 'true', visible: (() => { const rect = pane.getBoundingClientRect(); const style = getComputedStyle(pane); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' })() }));
    const pane = panes.find((item) => item.chatId === activeChatId) ?? null;
    const composer = Array.from(document.querySelectorAll('[data-composer-input="true"]')).find((item) => { const rect = item.getBoundingClientRect(); const style = getComputedStyle(item); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; });
    let composerDraft = { visible: Boolean(composer), length: null, sha256: null };
    if (composer && 'value' in composer) {
      const value = composer.value;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      composerDraft = { visible: true, length: value.length, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
    }
    const planButtons = Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'View full plan');
    const status = document.querySelector('[aria-label="Session status"]');
    const stopVisible = Array.from(document.querySelectorAll('button')).some((button) => { const label = `${button.getAttribute('aria-label') ?? ''} ${button.title ?? ''}`.toLowerCase(); const rect = button.getBoundingClientRect(); return /stop|cancel generation/.test(label) && rect.width > 0 && rect.height > 0; });
    const databaseModule = await import('/src/lib/db/database.ts');
    await databaseModule.openDb();
    const database = databaseModule.db;
    const chatRow = activeChatId ? await database.chats.get(activeChatId) : null;
    const runs = activeChatId ? await database.jarvis_runs.where('chat_id').equals(activeChatId).toArray() : [];
    const activeStatuses = new Set(['queued', 'compiling', 'running', 'awaiting_approval', 'partial']);
    return {
      route: ui.route ?? null,
      activeChatId,
      activeChatPaneFound: Boolean(pane),
      activeChatPaneVisible: pane?.visible ?? false,
      activeChatPaneFocused: pane?.focused ?? false,
      visiblePaneCount: panes.filter((item) => item.visible).length,
      chatMetadata: chatRow ? { providerId: chatRow.connection?.providerId ?? chatRow.connection?.provider_id ?? null, modelId: chatRow.connection?.modelId ?? chatRow.connection?.model_id ?? null, backendAffinity: chatRow.backend_affinity?.backend ?? null, mode: chatRow.mode ?? null } : null,
      composerDraft,
      durableRuns: runs.map((run) => ({ status: run.status, source: run.source, model: run.model?.model ?? null, updatedAt: run.updated_at })).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 5),
      activeDurableRunCount: runs.filter((run) => activeStatuses.has(run.status)).length,
      sessionStatus: status?.textContent?.trim() ?? null,
      stopControlVisible: stopVisible,
      visiblePlanButtonCount: planButtons.filter((button) => { const rect = button.getBoundingClientRect(); const style = getComputedStyle(button); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; }).length,
      totalPlanButtonCount: planButtons.length,
      inlineQuestionCount: document.querySelectorAll('[data-inline-question-block-id]').length,
    };
  });
  const receipt = { inspectedAt: new Date().toISOString(), nativePage: { label: 'main', url: page.url(), title: await page.title() }, actedOnUi: false, composerHandling: 'Only length and SHA-256 recorded; raw value stayed in page context.', state };
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ output, ...receipt }) + '\n');
  await browser.close();
})().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });


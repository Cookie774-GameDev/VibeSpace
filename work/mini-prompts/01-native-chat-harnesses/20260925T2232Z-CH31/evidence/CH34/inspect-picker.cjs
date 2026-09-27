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
    const main = labeled.filter(item => item.label === 'main');
    if (main.length !== 1) throw new Error('exact_main_required');
    receipt.state = await main[0].page.evaluate(async () => {
      const { useUIStore } = await import('/src/stores/ui.ts');
      const activeChatId = useUIStore.getState().activeChatId;
      const dialog = document.querySelector('[role="dialog"][aria-label="Choose AI model"]');
      const list = dialog?.querySelector('[role="listbox"]');
      return { activeChatId, dialogVisible: Boolean(dialog && dialog.getBoundingClientRect().width),
        search: dialog?.querySelector('[role="searchbox"]')?.value ?? null,
        listLabel: list?.getAttribute('aria-label') ?? null,
        options: [...(list?.querySelectorAll('[role="option"]') ?? [])].slice(0, 40).map(node => ({
          value: node.getAttribute('data-value'), effort: node.getAttribute('data-effort-level'),
          disabled: node.getAttribute('aria-disabled'), label: node.textContent?.trim().slice(0, 100),
        })),
        draftLength: document.querySelector(`[data-testid="chat-pane-${activeChatId}"] [data-composer-input="true"]`)?.value?.length ?? null };
    });
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `inspect-picker-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

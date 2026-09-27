'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const id = 'cht_-zkkf_r46zzuxB3L';
(async () => {
  const receipt = { at: new Date().toISOString(), readOnly: true, chatId: id };
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
    const labeled = await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async page => ({
      page, label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const mains = labeled.filter(x => x.label === 'main' && x.page.url().startsWith('http://localhost:5173/'));
    if (mains.length !== 1) throw new Error('exact_main_required');
    const page = mains[0].page;
    receipt.dom = await page.evaluate(async id => {
      const [{ useUIStore }, { db, openDb }] = await Promise.all([
        import('/src/stores/ui.ts'), import('/src/lib/db/database.ts')]);
      await openDb();
      const target = await db.chats.get(id);
      const row = document.querySelector(`[data-testid="chat-nav-row-${id}"]`);
      const button = row?.querySelector('button');
      const pane = document.querySelector(`[data-testid="chat-pane-${id}"]`);
      const input = pane?.querySelector('[data-composer-input="true"]');
      return { active: useUIStore.getState().activeChatId,
        target: { title: target?.title, projectId: target?.project_id, workspaceId: target?.workspace_id,
          archived: target?.archived, backendAffinity: target?.backend_affinity,
          connection: target?.connection },
        nav: { text: row?.textContent?.trim().slice(0, 250),
          current: row?.getAttribute('aria-current'),
          visible: Boolean(row?.getBoundingClientRect().width),
          buttonText: button?.textContent?.trim(), buttonCurrent: button?.getAttribute('aria-current'),
          buttonVisible: Boolean(button?.getBoundingClientRect().width) },
        pane: { visible: Boolean(pane?.getBoundingClientRect().width),
          text: pane?.textContent?.trim().slice(0, 300),
          runtime: pane?.querySelector('button[aria-label="Choose coding runtime"]')?.textContent?.trim(),
          model: pane?.querySelector('button[aria-label="Choose model"]')?.textContent?.trim(),
          effort: pane?.querySelector('[data-composer-effort]')?.getAttribute('data-composer-effort'),
          status: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim(),
          draft: input?.value,
          input: input ? { rect: { width: input.getBoundingClientRect().width,
            height: input.getBoundingClientRect().height, x: input.getBoundingClientRect().x,
            y: input.getBoundingClientRect().y }, disabled: input.disabled,
            visibility: getComputedStyle(input).visibility,
            display: getComputedStyle(input).display,
            ancestorHidden: input.closest('[aria-hidden="true"], [inert]')?.outerHTML.slice(0, 250) ?? null } : null },
        tabstrip: [...document.querySelectorAll('[role="tab"], [data-chat-tab]')]
          .map(n => ({ text: n.textContent?.trim().slice(0, 80),
            selected: n.getAttribute('aria-selected'), testId: n.getAttribute('data-testid') })).slice(0, 25),
      };
    }, id);
    const screenshot = path.join(__dirname, `native-codex-nav-diagnostic-${Date.now()}.png`);
    await page.screenshot({ path: screenshot, timeout: 15000 });
    receipt.screenshot = screenshot;
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `native-codex-nav-diagnostic-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, dom: receipt.dom, failure: receipt.failure }));
    if (browser) await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

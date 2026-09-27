const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const output = path.join(__dirname, 'dom-inventory.json');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const matches = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const identity = await page.evaluate(() => ({ label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null, origin: location.origin })).catch(() => null);
    if (identity?.label === 'main' && identity.origin === 'http://localhost:5173') matches.push(page);
  }
  if (matches.length !== 1) throw new Error(`Expected one official native main, found ${matches.length}`);
  const page = matches[0];
  const inventory = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const summarize = (element) => ({ tag: element.tagName, id: element.id || null, className: typeof element.className === 'string' ? element.className.slice(0, 180) : null, childCount: element.children.length, role: element.getAttribute('role'), testId: element.getAttribute('data-testid') });
    const visible = (element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const attr = (element, name) => element.getAttribute(name);
    return {
      title: document.title,
      rootFound: Boolean(root),
      rootChildren: root ? Array.from(root.children).map(summarize) : [],
      visibleCounts: Object.fromEntries(['main', '[role="main"]', 'nav', '[role="navigation"]', '[data-testid^="chat-nav-row-"]', '[data-composer-input="true"]', '[data-composer-frame]', '[role="dialog"]', '[role="alert"]', '[data-inline-question-block-id]', 'button'].map((selector) => [selector, Array.from(document.querySelectorAll(selector)).filter(visible).length])),
      visibleControlTagCounts: Array.from(document.querySelectorAll('button, input, textarea, [role="button"]')).filter(visible).reduce((counts, element) => { counts[element.tagName] = (counts[element.tagName] ?? 0) + 1; return counts; }, {}),
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).map((element) => ({ tag: element.tagName, textLength: element.textContent?.trim().length ?? 0, className: typeof element.className === 'string' ? element.className.slice(0, 120) : null })),
      pageScroll: { scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight },
    };
  });
  const receipt = { capturedAt: new Date().toISOString(), actedOnUi: false, privacy: 'Structural metadata only; no message text, question text, input values, or draft content recorded.', nativePage: { url: page.url(), title: await page.title() }, inventory };
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  await browser.close();
})().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });


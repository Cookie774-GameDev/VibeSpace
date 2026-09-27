const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, `c1-root-native-readonly-${Date.now()}.json`);
const receipt = {
  startedAt: new Date().toISOString(),
  endpoint: 'http://127.0.0.1:9223',
  expectedAppPid: 24748,
  expectedWebViewPid: 28964,
  stage: 'connect',
  actedOnUi: false,
};

(async () => {
  const browser = await chromium.connectOverCDP(receipt.endpoint, { timeout: 8_000 });
  receipt.stage = 'pages';
  const pages = browser.contexts().flatMap((context) => context.pages());
  receipt.pageCount = pages.length;
  const observations = [];
  for (const page of pages) {
    page.setDefaultTimeout(5_000);
    const observation = await page.evaluate(() => ({
      href: location.href,
      label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
      visible: document.visibilityState,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      activePaneRects: [...document.querySelectorAll('[data-testid^="chat-pane-"]')]
        .map((element) => ({ id: element.getAttribute('data-testid'),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          parentWidth: element.parentElement?.getBoundingClientRect().width ?? null })),
      activeChatPanes: [...document.querySelectorAll('[data-testid^="chat-pane-"]')]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => element.getAttribute('data-testid')),
      fixture: document.documentElement.dataset.monochromeChatFixture ?? null,
      currentNavRows: [...document.querySelectorAll('[data-testid^="chat-nav-row-"][aria-current="page"]')]
        .map((element) => element.getAttribute('data-testid')),
      sessionStatuses: [...document.querySelectorAll('[aria-label="Session status"]')]
        .map((element) => element.textContent?.trim() ?? ''),
      modelButtons: [...document.querySelectorAll('button[aria-label="Choose model"]')]
        .map((element) => element.textContent?.trim() ?? ''),
      composers: [...document.querySelectorAll('[data-composer-input="true"]')]
        .map((element) => ({ visible: Boolean(element.getBoundingClientRect().width),
          disabled: Boolean(element.disabled), draftLength: element.value?.length ?? null })),
      sendButtons: [...document.querySelectorAll('button[aria-label*="Send"]')]
        .map((element) => ({ label: element.getAttribute('aria-label'),
          visible: Boolean(element.getBoundingClientRect().width), disabled: Boolean(element.disabled) })),
      snippetCount: document.querySelectorAll('[data-assistant-snippet]').length,
      snippets: [...document.querySelectorAll('[data-assistant-snippet]')]
        .map((element) => ({ kind: element.getAttribute('data-assistant-snippet'),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          copyLabel: element.querySelector('button')?.getAttribute('aria-label') ?? null })),
      codeFenceCount: document.querySelectorAll('pre code').length,
      questionCardCount: document.querySelectorAll('.question-card').length,
    })).catch((error) => ({ error: String(error?.message ?? error) }));
    observations.push(observation);
  }
  receipt.observations = observations;
  receipt.stage = 'complete';
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});

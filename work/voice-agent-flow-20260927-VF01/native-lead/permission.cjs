const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('edge://permission-request-dialog/'));
    if (!page) { console.log('No C2 permission dialog'); return; }
    const state = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 500),
      buttons: [...document.querySelectorAll('button')].map((button) => ({ text: button.innerText.slice(0, 80), label: button.getAttribute('aria-label') })),
    }));
    console.log(JSON.stringify(state, null, 2));
    if (process.argv.includes('--allow')) {
      await page.getByText('Allow', { exact: true }).click({ timeout: 5000 });
      console.log('C2 microphone permission allowed');
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

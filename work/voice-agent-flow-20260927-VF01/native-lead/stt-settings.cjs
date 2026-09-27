const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (await page.getByRole('button', { name: 'Stop Jarvis voice' }).isVisible()) {
      await page.getByRole('button', { name: 'Stop Jarvis voice' }).click();
    }
    if (!await page.getByRole('tab', { name: 'Speech to Text', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    await page.getByRole('tab', { name: 'Speech to Text', exact: true }).click();
    await page.locator('section[aria-label="Speech-to-text provider"]').waitFor({ timeout: 10000 });
    const state = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).filter((value) => /speech|stt|engine|model|whisper|deepgram|flux|nova/i.test(value)).slice(0, 80),
      radios: [...document.querySelectorAll('section[aria-label="Speech-to-text provider"] [role="radio"]')].map((node) => ({ text: node.textContent.trim().slice(0, 90), checked: node.getAttribute('aria-checked') })),
      snippets: [...document.querySelectorAll('button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 90)).filter((value) => /whisper|deepgram|flux|nova|speech|browser|local/i.test(value)).slice(0, 50),
    }));
    console.log(JSON.stringify(state, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

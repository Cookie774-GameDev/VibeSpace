const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    await page.getByRole('button', { name: 'Choose model' }).click({ timeout: 7000 });
    const options = await page.evaluate(() => [...document.querySelectorAll('[role="option"], [role="menuitem"], button')]
      .filter((node) => /Codex|OpenCode/i.test((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')))
      .map((node) => ({ role: node.getAttribute('role') || node.tagName.toLowerCase(), label: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 120), disabled: node.getAttribute('aria-disabled') || node.hasAttribute('disabled') }))
      .slice(0, 40));
    console.log(JSON.stringify(options, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

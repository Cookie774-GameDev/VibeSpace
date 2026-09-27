const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    const input = page.locator('textarea[aria-label="Message"]');
    await input.waitFor({ timeout: 15000 });
    const value = await input.inputValue();
    const expected = 'Use Codex for the worker: Reply with exactly VF03-CODEX-1790534557615.';
    if (value === expected) {
      await input.fill('');
      console.log('Cleared only the unsent VF03 Codex test draft.');
    } else {
      console.log('Draft differed; left it untouched.');
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

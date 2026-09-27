const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const output = path.join(__dirname, 'settings-result.json');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  const result = { at: new Date().toISOString(), cdp: 9252, scenarios: [] };
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (!page) throw new Error('C2 chat WebView missing');
    result.identity = await page.evaluate(async () => {
      const source = await fetch('/src/features/voice/VoiceModal.tsx').then((response) => response.text());
      return {
        title: document.title,
        tauri: Boolean(window.__TAURI_INTERNALS__),
        route: new URL(location.href).searchParams.get('route'),
        sourceHasReceiptGate: source.includes('waitForVoiceWorkerReceipt'),
        sourceHasShortAck: source.includes('On it.'),
      };
    });
    if (!result.identity.tauri || !result.identity.sourceHasReceiptGate) {
      throw new Error('Native/source identity did not match the current voice code');
    }
    const tab = page.getByRole('tab', { name: 'Voice', exact: true });
    if (!await tab.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await tab.click();
    const main = page.getByLabel('Voice Main Agent provider');
    const worker = page.getByLabel('Voice Worker provider');
    await main.waitFor();
    const initial = { main: await main.inputValue(), worker: await worker.inputValue() };
    result.initial = initial;
    const check = async (name, expectedMain, expectedWorker) => {
      const actual = { main: await main.inputValue(), worker: await worker.inputValue() };
      result.scenarios.push({ name, ...actual, pass: actual.main === expectedMain && actual.worker === expectedWorker });
      if (!result.scenarios.at(-1).pass) throw new Error(`${name}: ${JSON.stringify(actual)}`);
    };
    try {
      await main.selectOption('codex');
      await worker.selectOption('codex');
      await check('Codex/Codex', 'codex', 'codex');
      await main.selectOption('opencode');
      await check('main changed alone', 'opencode', 'codex');
      await worker.selectOption('opencode');
      await check('OpenCode/OpenCode', 'opencode', 'opencode');
      await main.selectOption('codex');
      await check('worker changed alone', 'codex', 'opencode');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Voice', exact: true }).click();
      await check('settings persist on reopen', 'codex', 'opencode');
    } finally {
      await main.selectOption(initial.main);
      await worker.selectOption(initial.worker);
      result.restored = { main: await main.inputValue(), worker: await worker.inputValue() };
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Start Jarvis voice', exact: true }).click();
    await page.locator('#jarvis-panel').waitFor({ timeout: 10000 });
    result.voiceSurface = await page.evaluate(() => {
      const panel = document.querySelector('#jarvis-panel');
      return {
        officialPanel: panel?.getAttribute('aria-label'),
        state: panel?.getAttribute('data-voice-appearance-state'),
        smokeControls: [...panel.querySelectorAll('button')].some((button) => /Submit fixed transcript/.test(button.textContent || '')),
        controls: [...panel.querySelectorAll('button')].map((button) => (button.getAttribute('aria-label') || button.textContent || '').trim().slice(0, 70)).filter(Boolean).slice(0, 30),
      };
    });
    result.pass = result.scenarios.every((scenario) => scenario.pass) && result.voiceSurface.officialPanel === 'Jarvis voice session';
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

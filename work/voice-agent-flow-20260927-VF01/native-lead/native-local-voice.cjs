const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const outputPath = path.join(__dirname, 'local-voice-result.json');
const phrase = 'Please answer with the single word violet. Send it.';
const result = { at: new Date().toISOString(), cdp: 9252, phraseMarker: 'violet' };

async function openSttSettings(page) {
  if (await page.getByRole('button', { name: 'Stop Jarvis voice' }).isVisible()) {
    await page.getByRole('button', { name: 'Stop Jarvis voice' }).click();
  }
  const tab = page.getByRole('tab', { name: 'Speech to Text', exact: true });
  if (!await tab.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await tab.click();
  await page.locator('section[aria-label="Speech-to-text provider"]').waitFor({ timeout: 15000 });
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  let page;
  try {
    page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (!page || !await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__))) {
      throw new Error('Official C2 chat WebView not confirmed');
    }
    await openSttSettings(page);
    result.initialStt = await page.locator('section[aria-label="Speech-to-text provider"] [role="radio"][aria-checked="true"]').textContent().then((text) => text.trim().split(/\s+/u).slice(0, 2).join(' '));
    await page.getByRole('button', { name: /Whisper base\.en Q5/ }).click();
    result.localSelected = await page.getByRole('radio', { name: /^Local/ }).getAttribute('aria-checked');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Start Jarvis voice' }).click();
    const panel = page.locator('#jarvis-panel');
    await panel.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#jarvis-panel')?.getAttribute('data-voice-appearance-state') === 'listening', null, { timeout: 20000 });
    result.listeningAt = new Date().toISOString();
    const command = '$s=New-Object -ComObject SAPI.SpVoice; $s.Speak(\"Please answer with the single word violet. Send it.\") | Out-Null';
    const spoken = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 15000 });
    result.injectedSpeech = { exitCode: spoken.status, error: spoken.error?.message || null };
    await page.waitForTimeout(1400);
    const clicked = await page.evaluate(() => {
      const button = document.querySelector('#jarvis-panel button[aria-label="Stop listening"]');
      if (!button) return false;
      button.click();
      return true;
    });
    result.stopViaLifecycleControl = clicked;
    await page.waitForTimeout(20000);
    result.after = await page.evaluate(() => {
      const panel = document.querySelector('#jarvis-panel');
      const text = panel?.textContent || '';
      return {
        state: panel?.getAttribute('data-voice-appearance-state') || null,
        transcriptContainsMarker: text.toLowerCase().includes('violet'),
        statusMentionsCodex: text.includes('Sent to Codex worker'),
        statusMentionsOpenCode: text.includes('Sent to OpenCode worker'),
        failure: /could not confirm the worker started|could not be saved|model cannot|Voice error|failed/i.test(text),
        hint: text.slice(0, 280),
      };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      if (page) {
        await openSttSettings(page);
        await page.getByRole('radio', { name: /^Free System/ }).click();
        result.sttRestored = await page.getByRole('radio', { name: /^Free System/ }).getAttribute('aria-checked');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
      }
    } catch (error) {
      result.restoreError = error.message;
    }
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
  }
})().catch((error) => { result.error = error.message; console.error(error); process.exitCode = 1; });

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const context = browser.contexts()[0];
    const page = context.pages().find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (!page) throw new Error('C2 chat page missing');
    await context.grantPermissions(['microphone'], { origin: 'http://localhost:5173' });
    await page.getByRole('button', { name: 'Start Jarvis voice' }).click();
    await page.waitForTimeout(2000);
    const output = await page.evaluate(async () => {
      const [{ useUIStore }, { useVoiceStore }] = await Promise.all([
        import('/src/stores/ui.ts'), import('/src/features/voice/store.ts'),
      ]);
      const panel = document.querySelector('#jarvis-panel');
      return {
        tauri: Boolean(window.__TAURI_INTERNALS__),
        open: useUIStore.getState().voiceModalOpen,
        state: useVoiceStore.getState().state,
        permission: await navigator.permissions.query({ name: 'microphone' }).then((item) => item.state),
        panelAttached: Boolean(panel),
        panelIsLifecycleHidden: Boolean(panel?.closest('[data-jarvis-voice-lifecycle-only]')),
        controls: panel ? [...panel.querySelectorAll('button')].map((button) => (button.getAttribute('aria-label') || button.textContent || '').trim()).filter(Boolean) : [],
      };
    });
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

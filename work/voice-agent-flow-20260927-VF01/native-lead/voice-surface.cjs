const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const main = pages.find((page) => new URL(page.url()).searchParams.get('route') === 'chat');
    const overlay = pages.find((page) => new URL(page.url()).searchParams.get('view') === 'jarvis-ambient-overlay');
    const output = {
      main: await main.evaluate(async () => {
        const [{ useUIStore }, { useVoiceStore }, { useAuthStore }] = await Promise.all([
          import('/src/stores/ui.ts'), import('/src/features/voice/store.ts'), import('/src/stores/auth.ts'),
        ]);
        const ui = useUIStore.getState();
        const voice = useVoiceStore.getState();
        const auth = useAuthStore.getState();
        return {
          tauri: Boolean(window.__TAURI_INTERNALS__),
          open: ui.voiceModalOpen,
          state: voice.state,
          sessionBound: Boolean(voice.session),
          mainProvider: auth.voiceMainAgentProvider,
          workerProvider: auth.voiceWorkerProvider,
          voiceEngine: auth.voiceEngine,
          permission: await navigator.permissions.query({ name: 'microphone' }).then((item) => item.state).catch(() => 'unknown'),
          topBarVoiceButton: document.querySelector('button[aria-label="Start Jarvis voice"],button[aria-label="Stop Jarvis voice"]')?.getAttribute('aria-label') || null,
          panelState: document.querySelector('#jarvis-panel')?.getAttribute('data-voice-appearance-state') || null,
          panelControls: [...(document.querySelector('#jarvis-panel')?.querySelectorAll('button') || [])].map((button) => button.getAttribute('aria-label') || button.textContent?.trim()).filter(Boolean),
          panelHint: document.querySelector('#jarvis-panel')?.textContent?.trim().slice(0, 260) || null,
        };
      }),
      overlay: overlay ? await overlay.evaluate(() => ({
        tauri: Boolean(window.__TAURI_INTERNALS__),
        title: document.title,
        labels: [...document.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter(Boolean).slice(0, 40),
        buttons: [...document.querySelectorAll('button')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim()).filter(Boolean).slice(0, 40),
      })) : null,
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

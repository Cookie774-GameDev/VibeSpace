const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const provider = process.argv[2] === 'codex' ? 'codex' : 'opencode';
const providerLabel = provider === 'codex' ? 'Codex' : 'OpenCode';
const result = { at: new Date().toISOString(), cdp: 9252, provider, marker: provider === 'opencode' ? 'VF03-1790534181693' : `VF03-CODEX-${Date.now()}`, events: [] };
const output = path.join(__dirname, provider === 'codex' ? 'typed-codex-result.json' : 'typed-override-result.json');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    if (!page || !await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__))) {
      throw new Error('Official C2 WebView missing');
    }
    const close = page.getByRole('button', { name: 'Close', exact: true });
    if (await close.isVisible()) await close.click();
    await page.evaluate((providerLabel) => {
      window.__vf03Events = [];
      window.addEventListener('jarvis:send', (event) => {
        const detail = event.detail || {};
        window.__vf03Events.push({
          at: performance.now(),
          mode: detail.interactionMode || null,
          provider: detail.structuredContext?.payload?.workerProvider || null,
          agentId: detail.structuredContext?.payload?.agentId || null,
          parentChatId: detail.structuredContext?.payload?.parentChatId || null,
          screenshotAttached: detail.structuredContext?.payload?.screenshotAttached === true,
          voiceInstruction: String(detail.localCommandContext || '').includes('Reply quickly and as briefly as possible.'),
          mainDelivery: detail.structuredContext?.payload?.voiceWorkerResult === true,
        });
      });
      window.__vf03Notices = [];
      const observer = new MutationObserver(() => {
        const text = document.body.innerText;
        for (const phrase of [`Task sent to ${providerLabel}.`, 'Provider override failed', 'The worker could not start.']) {
          if (text.includes(phrase) && !window.__vf03Notices.some((entry) => entry.phrase === phrase)) {
            const alert = [...document.querySelectorAll('[role="alert"], [role="status"]')]
              .find((node) => node.textContent?.includes(phrase));
            window.__vf03Notices.push({ at: performance.now(), phrase, detail: alert?.textContent?.trim().slice(0, 300) || null });
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__vf03Observer = observer;
    }, providerLabel);
    const text = `Use ${providerLabel} for the worker: Reply with exactly ${result.marker}.`;
    await page.getByRole('textbox', { name: 'Message' }).fill(text);
    result.submitAt = new Date().toISOString();
    await page.getByRole('button', { name: 'Send message' }).click();
    console.log(`Submitted one native ${providerLabel} typed provider request`, result.marker);
    for (let attempt = 0; attempt < 45; attempt++) {
      await page.waitForTimeout(2000);
      const snapshot = await page.evaluate(async () => {
        const events = window.__vf03Events || [];
        const first = events.find((entry) => entry.agentId);
        let card = null;
        if (first) {
          const { useJarvisInteractionStore } = await import('/src/features/jarvis-interaction/sessionStore.ts');
          const entry = useJarvisInteractionStore.getState().agentsForChat(first.parentChatId)
            .find((item) => String(item.agentId) === first.agentId);
          if (entry) card = { status: entry.status, harnessSessionBound: Boolean(entry.harnessSessionId), modelLabel: entry.modelLabel || null };
        }
        return { events, notices: window.__vf03Notices || [], card };
      });
      result.events = snapshot.events;
      result.notices = snapshot.notices;
      result.card = snapshot.card;
      if (snapshot.notices.some((notice) => notice.phrase === 'Provider override failed')) break;
      if (snapshot.card?.harnessSessionBound) {
        result.receiptAt = new Date().toISOString();
        break;
      }
    }
    result.defaults = await page.evaluate(async () => {
      const { useAuthStore } = await import('/src/stores/auth.ts');
      const state = useAuthStore.getState();
      return { main: state.voiceMainAgentProvider, worker: state.voiceWorkerProvider };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    await browser.close();
  }
})().catch((error) => { result.error = error.message; fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); console.error(error); process.exitCode = 1; });

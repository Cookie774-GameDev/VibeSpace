const { chromium } = require('playwright');
const marker = 'VF03-CODEX-1790534557615';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    const state = await page.evaluate(async (marker) => {
      const { useJarvisInteractionStore } = await import('/src/features/jarvis-interaction/sessionStore.ts');
      const cards = Object.values(useJarvisInteractionStore.getState().agentsByChat).flat();
      const matches = cards.filter((card) => card.task.includes(marker));
      return {
        tauri: Boolean(window.__TAURI_INTERNALS__),
        draftHasMarker: [...document.querySelectorAll('textarea')].some((node) => node.value.includes(marker)),
        cardCount: matches.length,
        cards: matches.map((card) => ({ agentId: card.agentId, childChatId: card.childChatId, status: card.status, harnessSessionBound: Boolean(card.harnessSessionId), error: card.error || null, modelLabel: card.modelLabel })),
      };
    }, marker);
    console.log(JSON.stringify(state, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

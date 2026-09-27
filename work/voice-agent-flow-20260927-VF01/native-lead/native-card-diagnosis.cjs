const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9252');
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => new URL(candidate.url()).searchParams.get('route') === 'chat');
    const diagnosis = await page.evaluate(async () => {
      const events = window.__vf03Events || [];
      const first = events.find((event) => event.agentId);
      if (!first) return { events: events.length, card: null };
      const { useJarvisInteractionStore } = await import('/src/features/jarvis-interaction/sessionStore.ts');
      const card = useJarvisInteractionStore.getState().agentsForChat(first.parentChatId)
        .find((entry) => String(entry.agentId) === first.agentId);
      return {
        events: events.length,
        card: card ? {
          agentId: String(card.agentId),
          childChatId: String(card.childChatId),
          status: card.status,
          error: card.error || null,
          currentStep: card.currentStep || null,
          harnessSessionBound: Boolean(card.harnessSessionId),
          modelLabel: card.modelLabel || null,
        } : null,
      };
    });
    console.log(JSON.stringify(diagnosis, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, 'readonly-preflight.json');
const receipt = {
  startedAt: new Date().toISOString(),
  stage: 'attach',
  actedOnUi: false,
  privacy: 'No message/question text or draft content recorded.',
};

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const tagged = await Promise.all(pages.map(async (page) => ({
    page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null),
  })));
  const mains = tagged.filter(({ page, label }) => label === 'main' && new URL(page.url()).origin === 'http://localhost:5173');
  if (mains.length !== 1) throw new Error(`expected one official native main page, got ${mains.length}`);

  const page = mains[0].page;
  receipt.nativePage = { label: 'main', url: page.url(), title: await page.title() };
  receipt.metadata = await page.evaluate(async () => {
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x), y: Math.round(box.y), top: Math.round(box.top), right: Math.round(box.right),
        bottom: Math.round(box.bottom), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height),
      };
    };
    const metrics = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        rect: rect(element), clientWidth: element.clientWidth, clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop, overflowX: style.overflowX, overflowY: style.overflowY,
        lineClamp: style.webkitLineClamp || style.lineClamp || 'none', display: style.display,
        textLength: element.textContent?.length ?? 0,
      };
    };

    const activeNav = document.querySelector('[data-testid^="chat-nav-row-"][aria-current="page"]');
    const chatId = activeNav?.getAttribute('data-testid')?.replace(/^chat-nav-row-/, '') ?? null;
    let chat = null;
    let database = null;
    let durableRuns = [];
    if (chatId) {
      const databaseModule = await import('/src/lib/db/database.ts');
      database = databaseModule.db;
      await databaseModule.openDb();
      const row = await database.chats.get(chatId);
      if (row) {
        chat = {
          mode: row.mode ?? null,
          providerId: row.connection?.providerId ?? row.connection?.provider_id ?? null,
          modelId: row.connection?.modelId ?? row.connection?.model_id ?? null,
          backendAffinity: row.backend_affinity?.backend ?? null,
        };
      }
      durableRuns = await database.jarvis_runs.where('chat_id').equals(chatId).toArray();
    }

    const statusElement = document.querySelector('[aria-label="Session status"]');
    const statusText = statusElement?.textContent?.trim().toLowerCase() ?? '';
    const sessionStatus = /running/.test(statusText) ? 'Running'
      : /complete/.test(statusText) ? 'Complete'
        : /cancel/.test(statusText) ? 'Cancelled' : statusText ? 'Other status' : 'Not exposed';
    const stopControlVisible = Array.from(document.querySelectorAll('button')).some((button) => {
      const label = (button.getAttribute('aria-label') ?? button.title ?? '').toLowerCase();
      const box = button.getBoundingClientRect();
      return /stop|cancel generation/.test(label) && box.width > 0 && box.height > 0;
    });

    const composer = document.querySelector('[data-composer-input="true"]');
    const composerFrame = document.querySelector('[data-composer-frame]') ?? composer?.closest('form');
    const questionCards = Array.from(document.querySelectorAll('[data-inline-question-block-id]')).map((card) => {
      const options = Array.from(card.querySelectorAll('.question-card__option'));
      const answerFields = Array.from(card.querySelectorAll('textarea'));
      return {
        id: card.getAttribute('data-inline-question-block-id'),
        className: typeof card.className === 'string' ? card.className : '',
        rect: rect(card),
        optionCount: options.length,
        selectedOptionCount: options.filter((option) => option.getAttribute('aria-pressed') === 'true').length,
        disabledOptionCount: options.filter((option) => option.disabled).length,
        customAnswerFieldCount: answerFields.length,
        customAnswerLength: answerFields[0]?.value?.length ?? null,
        ariaBusy: card.getAttribute('aria-busy'),
      };
    });

    const planButtons = Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'View full plan',
    );
    const planCards = planButtons.map((button) => {
      const card = button.closest('section');
      const summary = card?.querySelector('p.whitespace-pre-wrap') ?? null;
      const steps = card?.querySelector('ol') ?? null;
      const cardMetrics = metrics(card);
      const composerMetrics = metrics(composerFrame);
      const intersectsComposer = Boolean(cardMetrics?.rect && composerMetrics?.rect
        && cardMetrics.rect.left < composerMetrics.rect.right && cardMetrics.rect.right > composerMetrics.rect.left
        && cardMetrics.rect.top < composerMetrics.rect.bottom && cardMetrics.rect.bottom > composerMetrics.rect.top);
      const scrollAncestors = [];
      for (let parent = card?.parentElement; parent && scrollAncestors.length < 4; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)
          && (parent.scrollHeight > parent.clientHeight + 1 || parent.scrollWidth > parent.clientWidth + 1)) {
          scrollAncestors.push({ className: typeof parent.className === 'string' ? parent.className : '', ...metrics(parent) });
        }
      }
      return {
        card: cardMetrics,
        summary: metrics(summary),
        steps: metrics(steps),
        stepCount: steps?.children.length ?? 0,
        intersectsComposer,
        scrollAncestors,
        visiblePlanDialogCount: document.querySelectorAll('[role="dialog"]').length,
      };
    });

    return {
      chatId,
      chat,
      sessionStatus,
      sessionStatusText: statusText || null,
      stopControlVisible,
      durableRuns: durableRuns
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
        .slice(0, 5)
        .map((run) => ({ source: run.source, status: run.status, model: run.model?.model ?? null, updatedAt: run.updated_at })),
      activeDurableRunCount: durableRuns.filter((run) => ['queued', 'compiling', 'running', 'awaiting_approval', 'partial'].includes(run.status)).length,
      questionCards,
      questionCount: questionCards.length,
      planCards,
      composer: { rect: rect(composer), frame: metrics(composerFrame), draftLength: composer?.value?.length ?? null },
      viewport: {
        width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY,
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientHeight: document.documentElement.clientHeight,
      },
      tauriBridge: Boolean(window.__TAURI_INTERNALS__),
      viteResources: performance.getEntriesByType('resource').map((entry) => entry.name)
        .filter((name) => /PlanReviewCard|QuestionBlockCard/.test(name)),
    };
  });
  receipt.stage = 'complete';
})().catch((error) => {
  receipt.error = String(error?.message ?? error);
  receipt.stage = 'failed';
}).finally(() => {
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, ...receipt })}\n`);
  process.exit(receipt.stage === 'complete' ? 0 : 1);
});

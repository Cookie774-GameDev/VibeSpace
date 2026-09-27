import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const chatId = 'cht_-zkkf_r46zzuxB3L';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 5000 });
const entries = await Promise.all(browser.contexts().flatMap((context) => context.pages()).map(async (page) => ({
  page,
  label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null),
  location: await page.evaluate(() => ({ origin: location.origin, pathname: location.pathname })).catch(() => null),
})));
const mains = entries.filter(({ label, location }) =>
  label === 'main' && location?.origin === 'http://localhost:5173' && location.pathname === '/');
if (mains.length !== 1) throw new Error(`Expected one official C1 main target; found ${mains.length}`);
const page = mains[0].page;
let mainFrameNavigations = 0;
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) mainFrameNavigations += 1;
});
async function sample() {
  return page.evaluate(async (expectedChatId) => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    const pane = document.querySelector(`[data-testid="chat-pane-${expectedChatId}"]`);
    const composer = pane?.querySelector('[data-composer-input="true"]');
    const status = pane?.querySelector('[aria-label="Session status"]');
    return {
      at: new Date().toISOString(),
      readyState: document.readyState,
      activeChatMatches: useUIStore.getState().activeChatId === expectedChatId,
      paneVisible: Boolean(pane?.getBoundingClientRect().width),
      composerVisible: Boolean(composer?.getBoundingClientRect().width),
      draftLength: composer && 'value' in composer ? composer.value.length : null,
      runStatus: status?.textContent?.trim() ?? null,
      questionCardCount: pane?.querySelectorAll('.question-card').length ?? 0,
    };
  }, chatId);
}
const startedAt = new Date().toISOString();
const samples = [];
let contextErrors = 0;
for (let index = 0; index < 10; index += 1) {
  try {
    samples.push(await sample());
  } catch (error) {
    contextErrors += 1;
    samples.push({ at: new Date().toISOString(), evaluationError: String(error?.message ?? error) });
  }
  if (index < 9) await page.waitForTimeout(500);
}
const good = samples.filter((entry) => entry.activeChatMatches && entry.paneVisible && entry.composerVisible &&
  entry.runStatus === 'Cancelled' && entry.draftLength === 0);
const receipt = {
  startedAt,
  completedAt: new Date().toISOString(),
  cdpEndpoint: 'http://127.0.0.1:9223',
  mainTargetCount: mains.length,
  mainFrameNavigations,
  contextErrors,
  stableSamples: good.length,
  totalSamples: samples.length,
  samples,
  stableForFiveSeconds: good.length === samples.length && mainFrameNavigations === 0 && contextErrors === 0,
};
await writeFile('work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator/c1-main-pane-stability-poll.json', `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exit(0);

import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const chatId = 'cht_-zkkf_r46zzuxB3L';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 5000 });
const pages = browser.contexts().flatMap((context) => context.pages());
const labeled = await Promise.all(pages.map(async (page) => ({
  page,
  label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null),
  location: await page.evaluate(() => ({ origin: location.origin, pathname: location.pathname })).catch(() => null),
})));
const mains = labeled.filter(({ label, location }) =>
  label === 'main' && location?.origin === 'http://localhost:5173' && location.pathname === '/');
if (mains.length !== 1) throw new Error(`Expected exactly one official C1 main target; found ${mains.length}`);
const page = mains[0].page;
async function sample() {
  return page.evaluate(async (expectedChatId) => {
    const { useUIStore } = await import('/src/stores/ui.ts');
    const pane = document.querySelector(`[data-testid="chat-pane-${expectedChatId}"]`);
    const composer = pane?.querySelector('[data-composer-input="true"]');
    const status = pane?.querySelector('[aria-label="Session status"]');
    const stop = pane?.querySelector('button[aria-label="Stop current request"]');
    return {
      at: new Date().toISOString(),
      activeChatMatches: useUIStore.getState().activeChatId === expectedChatId,
      appRootMounted: Boolean(document.querySelector('#root')?.childElementCount),
      panePresent: Boolean(pane),
      paneVisible: Boolean(pane?.getBoundingClientRect().width),
      composerPresent: Boolean(composer),
      composerVisible: Boolean(composer?.getBoundingClientRect().width),
      draftLength: composer && 'value' in composer ? composer.value.length : null,
      sessionStatusPresent: Boolean(status),
      runStatus: status?.textContent?.trim() ?? null,
      stopVisible: Boolean(stop?.getBoundingClientRect().width),
      questionCardCount: pane?.querySelectorAll('.question-card').length ?? 0,
      inlineOptionCount: pane?.querySelectorAll('.question-card--inline .question-card__option').length ?? 0,
    };
  }, chatId);
}
const startedAt = new Date().toISOString();
const first = await sample();
const samples = [first];
let ready = first.activeChatMatches && first.paneVisible && first.composerVisible && first.sessionStatusPresent;
const deadline = Date.now() + 45000;
while (!ready && Date.now() < deadline) {
  await page.waitForTimeout(1000);
  const current = await sample();
  if (samples.length < 3 || Date.now() > deadline - 5000) samples.push(current);
  ready = current.activeChatMatches && current.paneVisible && current.composerVisible && current.sessionStatusPresent;
}
const last = await sample();
const receipt = {
  startedAt,
  completedAt: new Date().toISOString(),
  cdpEndpoint: 'http://127.0.0.1:9223',
  mainTargetCount: mains.length,
  sampleCount: samples.length,
  first,
  samples,
  last,
  paneHydrated: ready,
  safeIdleFixture: ready && last.runStatus === 'Cancelled' && !last.stopVisible && last.draftLength === 0,
};
await writeFile('work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator/c1-codex-pane-hydration-poll.json', `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exit(0);

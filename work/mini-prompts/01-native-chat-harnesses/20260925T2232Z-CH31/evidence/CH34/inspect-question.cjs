'use strict';
require('../../native-playwright-compat.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const chatId = 'cht_lWazHd9Rnq8FPmHo';
const blockId = 'qb_opencode_1piqs8d0dgheqb';
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 20000 });
  const receipt = { at: new Date().toISOString(), readOnly: true, chatId, blockId };
  try {
    const pages = browser.contexts().flatMap(context => context.pages());
    const labeled = await Promise.all(pages.map(async page => ({ page,
      label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label).catch(() => null) })));
    const main = labeled.filter(item => item.label === 'main');
    if (main.length !== 1) throw new Error('exact_main_required');
    receipt.state = await main[0].page.evaluate(async ({ expectedChatId, expectedBlockId }) => {
      const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
        import('/src/lib/db/database.ts'), import('/src/stores/ui.ts'), import('/src/stores/auth.ts'),
      ]);
      await openDb();
      const rows = await db.messages.where('chat_id').equals(expectedChatId).toArray();
      const matches = rows.flatMap(row => (row.parts ?? []).filter(part =>
        part.kind === 'question_block' && part.block?.id === expectedBlockId));
      const part = matches.length === 1 ? matches[0] : null;
      const card = document.querySelector(`[data-inline-question-block-id="${expectedBlockId}"]`);
      const selection = useAuthStore.getState().chatModelSelection;
      const tabs = document.querySelector('[role="group"][aria-label="Open chats"]');
      return {
        activeChatId: useUIStore.getState().activeChatId,
        matchingQuestionParts: matches.length,
        blockStatus: part?.block?.status ?? null,
        protocol: part?.harness?.protocol ?? null,
        requestId: part?.harness?.requestId ?? null,
        sessionId: part?.harness?.sessionId ?? null,
        selection: selection?.mode === 'single' ? {
          providerId: selection.providerId, modelId: selection.modelId, connectionId: selection.connectionId,
        } : null,
        cardVisible: Boolean(card && card.getBoundingClientRect().width),
        cardButtons: [...(card?.querySelectorAll('button') ?? [])].map(button => ({
          ariaLabel: button.getAttribute('aria-label'), text: button.textContent?.trim().slice(0, 45),
          disabled: button.disabled,
        })),
        cardTimerCount: card?.querySelectorAll('[role="timer"]').length ?? 0,
        transcriptReopenCount: [...document.querySelectorAll('button')]
          .filter(button => button.getAttribute('aria-label') === 'Answer question').length,
        openChatTabCount: tabs?.querySelectorAll('button').length ?? 0,
      };
    }, { expectedChatId: chatId, expectedBlockId: blockId });
  } catch (error) { receipt.failure = String(error?.message ?? error); process.exitCode = 1; }
  finally {
    const output = path.join(__dirname, `inspect-question-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, ...receipt }));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

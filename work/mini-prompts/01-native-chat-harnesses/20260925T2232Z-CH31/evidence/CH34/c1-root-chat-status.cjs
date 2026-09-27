const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const output = path.join(__dirname, `c1-root-chat-status-${Date.now()}.json`);
const receipt = { at: new Date().toISOString(), actedOnUi: false, stage: 'connect' };
const ids = ['cht_-zkkf_r46zzuxB3L', 'cht_-L-b1h0vcyBLa427', 'cht_lWazHd9Rnq8FPmHo'];

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 10_000 });
  const candidates = browser.contexts().flatMap((context) => context.pages());
  const tagged = await Promise.all(candidates.map(async (page) => ({
    page,
    label: await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
      .catch(() => null),
  })));
  const main = tagged.filter(({ page, label }) => label === 'main' &&
    new URL(page.url()).origin === 'http://localhost:5173');
  if (main.length !== 1) throw new Error(`expected one official main page, got ${main.length}`);
  receipt.mainUrl = main[0].page.url();
  receipt.stage = 'read-native-db';
  receipt.chats = await main[0].page.evaluate(async (chatIds) => {
    const [{ db, openDb }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('/src/lib/db/database.ts'),
      import('/src/stores/ui.ts'),
      import('/src/stores/auth.ts'),
    ]);
    await openDb();
    const selected = useAuthStore.getState().chatModelSelection;
    const chats = [];
    for (const chatId of chatIds) {
      const chat = await db.chats.get(chatId);
      const messages = await db.messages.where('chat_id').equals(chatId).toArray();
      const runs = await db.jarvis_runs.where('chat_id').equals(chatId).toArray();
      const questions = messages.flatMap((message) => (message.parts ?? [])
        .filter((part) => part.kind === 'question_block')
        .map((part) => ({ id: part.block.id, status: part.block.status,
          requestId: part.harness?.requestId ?? null })));
      const snippets = messages.filter((message) => message.role === 'assistant')
        .flatMap((message) => (message.parts ?? [])
          .filter((part) => part.kind === 'text' && /```/.test(part.text ?? ''))
          .map((part) => ({ messageId: message.id, length: part.text.length })));
      chats.push({
        chatId,
        exists: Boolean(chat),
        createdAt: chat?.created_at ?? null,
        updatedAt: chat?.updated_at ?? null,
        backendAffinity: chat?.backend_affinity ?? null,
        userCount: messages.filter((message) => message.role === 'user').length,
        assistantCount: messages.filter((message) => message.role === 'assistant').length,
        questions,
        snippetCandidates: snippets,
        recentRuns: runs.sort((a, b) => b.created_at - a.created_at).slice(0, 3)
          .map((run) => ({ id: run.id, status: run.status,
            createdAt: run.created_at, updatedAt: run.updated_at })),
      });
    }
    return { activeChatId: useUIStore.getState().activeChatId,
      selectedRoute: selected?.mode === 'single' ? {
        connectionId: selected.connectionId, modelId: selected.modelId,
      } : null,
      chats };
  }, ids);
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

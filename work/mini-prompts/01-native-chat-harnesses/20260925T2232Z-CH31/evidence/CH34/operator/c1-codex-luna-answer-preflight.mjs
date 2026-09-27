import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const chatId = 'cht_-zkkf_r46zzuxB3L';
const prompt = 'Use your native question tool to ask me one harmless random preference question. Do not just print the question as ordinary text. Do not edit files or run commands.';
const guardBase = 'work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/operator';
const sendGuardPath = `${guardBase}/codex-luna-question-answer-send-attempt.json`;
const answerGuardPath = `${guardBase}/codex-luna-question-answer-submit-attempt.json`;
const sendGuardExists = existsSync(sendGuardPath);
const answerGuardExists = existsSync(answerGuardPath);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 5000 });
const mains = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
  try {
    const url = new URL(page.url());
    return url.origin === 'http://localhost:5173' && url.pathname === '/';
  } catch {
    return false;
  }
});
if (mains.length !== 1) throw new Error(`Expected one native main page; found ${mains.length}`);
const page = mains[0];
const label = await page.evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null);
if (label !== 'main') throw new Error('Native main-window label check failed');
const snapshot = await page.evaluate(async ({ expectedChatId, promptHash, sendGuardExists, answerGuardExists }) => {
  const [{ db, openDb }, { useUIStore }, { resolveChatBackendAffinity }] = await Promise.all([
    import('/src/lib/db/database.ts'),
    import('/src/stores/ui.ts'),
    import('/src/lib/ai/backend/chatBackend.ts'),
  ]);
  await openDb();
  const chat = await db.chats.get(expectedChatId);
  const rows = await db.messages.where('chat_id').equals(expectedChatId).toArray();
  const pane = document.querySelector(`[data-testid="chat-pane-${expectedChatId}"]`);
  const questions = rows.flatMap((row) => (row.parts ?? []).filter((part) => part.kind === 'question_block')
    .map((part) => ({ messageId: row.id, id: part.block?.id ?? null, status: part.block?.status ?? null,
      protocol: part.harness?.protocol ?? null, requestId: part.harness?.requestId ?? null })));
  const runtimeResponse = await fetch('/src/lib/ai/runtime.ts', { cache: 'no-store' });
  const runtimeText = await runtimeResponse.text();
  const sourceHashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(runtimeText));
  const sourceSha256 = Array.from(new Uint8Array(sourceHashBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const users = [];
  for (const row of rows.filter((item) => item.role === 'user')) {
    const text = (row.parts ?? []).filter((part) => part.kind === 'text').map((part) => part.text).join('\n');
    const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    users.push({ id: row.id, promptMatch: hash === promptHash });
  }
  const stop = pane?.querySelector('button[aria-label="Stop current request"]');
  const draft = pane?.querySelector('[data-composer-input="true"]')?.value ?? null;
  return {
    activeChatMatches: useUIStore.getState().activeChatId === expectedChatId,
    backend: chat ? resolveChatBackendAffinity(chat.backend_affinity, {
      hasCommittedUserMessage: users.length > 0, chatCreatedAt: chat.created_at,
    }).backend : null,
    connectionId: chat?.connection?.id ?? null,
    modelId: chat?.connection?.modelId ?? null,
    paneVisible: Boolean(pane?.getBoundingClientRect().width),
    runStatus: pane?.querySelector('[aria-label="Session status"]')?.textContent?.trim() ?? null,
    stopVisible: Boolean(stop?.getBoundingClientRect().width),
    draftLength: draft?.length ?? null,
    userCount: users.length,
    currentPromptUserCount: users.filter((user) => user.promptMatch).length,
    assistantCount: rows.filter((row) => row.role === 'assistant').length,
    questions,
    sourceStatus: runtimeResponse.status,
    sourceBytes: new TextEncoder().encode(runtimeText).length,
    sourceSha256,
    sourceHasCanonicalCancellation: runtimeText.includes('cancelPendingProjectedNativeQuestions('),
    sendGuardExists,
    answerGuardExists,
  };
}, {
  expectedChatId: chatId,
  promptHash: createHash('sha256').update(prompt).digest('hex'),
  sendGuardExists,
  answerGuardExists,
});
const receipt = {
  at: new Date().toISOString(),
  lane: 'native-codex-luna-question-answer',
  cdpEndpoint: 'http://127.0.0.1:9223',
  target: 'http://localhost:5173/',
  chatId,
  promptSha256: createHash('sha256').update(prompt).digest('hex'),
  snapshot,
  oldPendingCount: snapshot.questions.filter((question) => question.status === 'pending').length,
  oneTimeGuardsAbsent: !sendGuardExists && !answerGuardExists,
  safeToProceed: snapshot.activeChatMatches && snapshot.paneVisible && snapshot.backend === 'codex' &&
    snapshot.connectionId === 'openai-codex' && snapshot.modelId === 'gpt-6-luna' &&
    snapshot.runStatus === 'Cancelled' && !snapshot.stopVisible && snapshot.draftLength === 0 &&
    snapshot.sourceStatus === 200 && snapshot.sourceHasCanonicalCancellation &&
    snapshot.currentPromptUserCount === 0 && snapshot.questions.filter((question) => question.status === 'pending').length === 3 &&
    snapshot.questions.filter((question) => question.status === 'cancelled').length === 1 &&
    !sendGuardExists && !answerGuardExists,
};
await writeFile(`${guardBase}/c1-codex-luna-answer-preflight-recheck.json`, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exit(0);

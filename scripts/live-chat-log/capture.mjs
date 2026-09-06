/** Runs inside the official native development WebView. Read APIs only. */
export async function captureNativeChat(requestedChat) {
  if (!window.__TAURI_INTERNALS__) throw new Error('Official native app required');
  const [{ getActiveAccountIdentity }, { useAuthStore }, { chatRepo, messageRepo }, journal, { useChatActivityStore }, { loadChatDebugLog }, { renderChatDebugLogHtml }, { applySecretPolicy }] = await Promise.all([
    import('/src/lib/accountIdentity.ts'), import('/src/stores/auth.ts'), import('/src/lib/db/index.ts'),
    import('/src/lib/db/jarvisRepositories.ts'), import('/src/features/chat/activity/activityStore.ts'),
    import('/src/features/chat/agentic-console/chatDebugLogData.ts'),
    import('/src/features/chat/agentic-console/chatDebugLogHtml.ts'), import('/src/lib/security/secretDetector.ts'),
  ]);
  const accountId = getActiveAccountIdentity()?.accountId;
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!accountId || !workspaceId) throw new Error('Active account/workspace unavailable');
  const current = () => getActiveAccountIdentity()?.accountId === accountId && useAuthStore.getState().workspaceId === workspaceId;
  const chats = await chatRepo.list({ workspace_id: workspaceId, limit: 200 });
  if (!current()) throw new Error('Account changed');
  const active = document.querySelector('[data-agentic-console][data-chat-id]')?.getAttribute('data-chat-id');
  const chat = requestedChat ? chats.find((row) => row.id === requestedChat)
    : chats.find((row) => row.id === active) ?? chats[0];
  const choices = chats.map(({ id, title }) => ({ id, title: applySecretPolicy(title, 'redact').text ?? '[redacted]' }));
  if (!chat) {
    if (requestedChat) throw new Error('Chat is outside current workspace or unavailable');
    return { chats: choices, html: '', chatId: '', updatedAt: Date.now(), messages: 0, runs: 0 };
  }
  const log = await loadChatDebugLog({
    accountId, chatId: chat.id, isCurrent: current,
    listMessages: () => messageRepo.listByChat(chat.id), getChat: () => chatRepo.getById(chat.id),
    activity: useChatActivityStore.getState().eventsByChat[chat.id] ?? [], rendererUptimeMs: performance.now(),
    dataPort: {
      getRunsForChat: async ({ accountId, chatId, limit }) => (await journal.jarvisRunRepo.listByAccount(accountId, { limit: 500 }))
        .filter((run) => run.accountId === accountId && run.chatId === chatId).slice(0, limit),
      getEventsForRun: ({ accountId, runId, afterSeq, limit }) => journal.jarvisEventRepo.listByRun(accountId, runId, { afterSeq, limit }),
      getArtifactsForRun: ({ accountId, runId, limit }) => journal.jarvisArtifactRepo.listByRun(accountId, runId, limit),
    },
  });
  if (!current()) throw new Error('Account changed');
  return { chats: choices, html: renderChatDebugLogHtml(log), chatId: chat.id,
    updatedAt: log.exportedAt, messages: log.messages.length, runs: log.runs.length };
}

export function chooseNativeTarget(targets) {
  const eligible = targets.filter((target) => {
    try {
      const url = new URL(target.url);
      return target.type === 'page' && target.title === 'VibeSpace' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) && !url.searchParams.has('view');
    } catch { return false; }
  });
  if (eligible.length !== 1) throw new Error('Expected one official main development WebView');
  return eligible[0];
}

export async function readNativeSnapshot(chatId = '', debugPort = 9223) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Native debugger unavailable');
  const target = chooseNativeTarget(await response.json());
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  if (socketUrl.hostname !== '127.0.0.1' || socketUrl.port !== String(debugPort)) throw new Error('Unexpected debugger endpoint');
  const socket = new WebSocket(socketUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native read timed out')), 15000);
      const finish = (error, result) => { clearTimeout(timeout); error ? reject(error) : resolve(result); };
      socket.addEventListener('error', () => finish(new Error('Native connection failed')), { once: true });
      socket.addEventListener('close', () => finish(new Error('Native connection closed')), { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `(${captureNativeChat.toString()})(${JSON.stringify(chatId)})`, awaitPromise: true, returnByValue: true,
      } })), { once: true });
      socket.addEventListener('message', ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails) return finish(new Error('Native snapshot read failed'));
          finish(null, message.result.result.value);
        } catch { finish(new Error('Invalid native response')); }
      });
    });
  } finally { socket.close(); }
}

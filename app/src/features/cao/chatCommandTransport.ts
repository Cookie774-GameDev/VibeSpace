import type { ChatRunState } from '@/features/chat/runtime/chatRunState';

/** The same exact-request stop/resume protocol used by Composer. Never a broadcast cancel. */
export function createCaoChatCommandTransport(deps: {
  events: EventTarget;
  read(chatId: string): ChatRunState | undefined;
  dispatch(type: string, detail: Record<string, string>): void;
  timeoutMs?: number;
}) {
  const acknowledge = (
    chatId: string, key: string, statuses: readonly string[], signal: AbortSignal,
    dispatch: () => void,
  ) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      deps.events.removeEventListener('jarvis:run-state', listener);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const listener = (event: Event) => {
      const state = (event as CustomEvent<ChatRunState>).detail;
      if (state?.chatId !== chatId || state.cancellationKey !== key) return;
      if (statuses.includes(state.status)) finish();
      else if (['error', 'cancelled', 'done'].includes(state.status)) finish(Error('cao_control_dispatch_rejected'));
    };
    const abort = () => finish(Error('cao_control_cancelled'));
    const timer = setTimeout(() => finish(Error('cao_control_acknowledgement_unavailable')), deps.timeoutMs ?? 15000);
    deps.events.addEventListener('jarvis:run-state', listener);
    signal.addEventListener('abort', abort, { once: true });
    try { signal.throwIfAborted(); dispatch(); } catch (error) { finish(error as Error); }
  });
  return {
    async execute(
      action: 'cancel' | 'restart', chatId: string, expectedKey: string, resumeKey: string,
      signal: AbortSignal, authorize: () => Promise<void>,
      resumeAuthority?: string,
    ): Promise<'cancelled' | 'resumed'> {
      const current = () => {
        const state = deps.read(chatId);
        if (!expectedKey || state?.chatId !== chatId || state.cancellationKey !== expectedKey ||
            !['running', 'cancelled'].includes(state.status)) throw Error('cao_control_turn_changed');
        return state;
      };
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      if (current().status === 'running') {
        await acknowledge(chatId, expectedKey, ['cancelled'], signal, () =>
          deps.dispatch('jarvis:cancel', { chatId, messageId: expectedKey }));
      }
      if (action === 'cancel') return 'cancelled';
      await authorize();
      signal.throwIfAborted();
      if (current().status !== 'cancelled') throw Error('cao_control_turn_changed');
      await acknowledge(chatId, resumeKey, ['running', 'done'], signal, () =>
        deps.dispatch('jarvis:resume', { chatId, cancellationKey: resumeKey, ...(resumeAuthority ? { caoExpectedAuthority: resumeAuthority } : {}) }));
      return 'resumed';
    },
  };
}

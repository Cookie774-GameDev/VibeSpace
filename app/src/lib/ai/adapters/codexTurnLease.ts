type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'vibespace.codex-native-generation.v1';
/** One native app-server per WebView. Reload recovery never replays a prompt. */
export function createCodexTurnLease(storage?: StoragePort) {
  let busy = false;
  const queue: Array<() => void> = [];
  let generation: string | undefined;
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(admit);
          if (index >= 0) queue.splice(index, 1);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        const admit = () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) {
            abort();
            queue.shift()?.();
            return;
          }
          busy = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            busy = false;
            queue.shift()?.();
          });
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        if (busy) queue.push(admit);
        else admit();
      });
    },
    remember(value: string) {
      generation = value;
      storage?.setItem(KEY, value);
    },
    forget(value: string) {
      if (generation === value) generation = undefined;
      if (storage?.getItem(KEY) === value) storage.removeItem(KEY);
    },
    async recover(stop: (generation: string) => Promise<boolean>) {
      const previous = generation ?? storage?.getItem(KEY);
      if (!previous) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(previous))
        throw Error('Codex recovery generation is invalid.');
      await stop(previous);
      this.forget(previous);
    },
  };
}
const key = Symbol.for('vibespace.codexTurnLease.v1');
const host = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createCodexTurnLease> };
export const codexTurnLease = (host[key] ??= createCodexTurnLease(
  typeof sessionStorage === 'undefined' ? undefined : sessionStorage,
));

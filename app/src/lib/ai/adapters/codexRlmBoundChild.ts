// STAGING ONLY. Native certificate remains mandatory; this never uses adapter.send.
import { createNativeBoundCodexRlmChild, type NativeCodexChildCommands, type NativeChildAuthority } from './codexRlmNativeFactory';
import { readLiveCodexRlmParent } from './codexRlmParentBinding';
import type { CliBridgeEvent } from '@/lib/ai/adapters/cliBridge';
export function createRegisteredCodexRlmChild() {
  const commands: NativeCodexChildCommands = {
    async prepare(parent) {
      const { invoke } = await import('@tauri-apps/api/core');
      // Caller identity comes from the backend's Webview, never an IPC payload.
      return invoke<NativeChildAuthority>('codex_rlm_prepare', {
        request: { owner: parent.owner, generation: parent.generation },
      });
    },
    async *stream(request) {
      const [{ invoke }, { listen }] = await Promise.all([
        import('@tauri-apps/api/core'), import('@tauri-apps/api/event'),
      ]);
      const queue: CliBridgeEvent[] = [];
      let wake: (() => void) | undefined;
      let terminal = false;
      let receiptExpired = false;
      const unlisten = await listen<CliBridgeEvent>('cli-bridge://event', ({ payload }) => {
        if (payload.requestId !== request.requestId) return;
        queue.push(payload);
        terminal ||= ['completed','cancelled','timedOut','failed'].includes(payload.status);
        wake?.(); wake = undefined;
      });
      const watchdog = setTimeout(() => {
        receiptExpired = true; wake?.(); wake = undefined;
      }, 45_000);
      try {
        await invoke('codex_rlm_start', { request });
        while (!terminal || queue.length) {
          if (receiptExpired) throw Error('rlm_native_terminal_receipt_unavailable');
          if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
          const event = queue.shift(); if (event) yield event;
        }
      } finally {
        clearTimeout(watchdog); unlisten();
        if (!terminal) await commands.cancel(request.requestId).catch(() => false);
      }
    },
    async cancel(requestId) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<boolean>('cli_bridge_cancel', { requestId });
    },
    async revoke(authorityHandle) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('codex_rlm_revoke', { authorityHandle });
    },
  };
  return createNativeBoundCodexRlmChild(commands, readLiveCodexRlmParent, () =>
    'codex-rlm-' + crypto.randomUUID());
}

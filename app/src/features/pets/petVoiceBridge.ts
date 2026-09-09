import { emitTo, listen } from '@tauri-apps/api/event';
import { useUIStore } from '@/stores/ui';

export const PET_VOICE_REQUEST = 'pet:voice-request';
export const PET_VOICE_STATE = 'pet:voice-state';
export type PetVoiceRequest = 'sync' | 'open' | 'close';

/** Only the main WebView owns voice capture, lifecycle and the screen aura. */
export function installPetVoiceHost(): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const publish = () => {
    if (!disposed) {
      void emitTo('pet-mini-panel', PET_VOICE_STATE, useUIStore.getState().voiceModalOpen).catch(
        () => undefined,
      );
    }
  };
  const unsubscribe = useUIStore.subscribe((state, previous) => {
    if (state.voiceModalOpen !== previous.voiceModalOpen) publish();
  });
  void listen<PetVoiceRequest>(PET_VOICE_REQUEST, ({ payload }) => {
    if (disposed || !['sync', 'open', 'close'].includes(payload)) return;
    if (payload !== 'sync') {
      // Set, never toggle: simultaneous open requests cannot start two sessions.
      useUIStore.getState().setVoiceModalOpen(payload === 'open');
    }
    publish();
  })
    .then((off) => {
      if (disposed) off();
      else {
        unlisten = off;
        publish();
      }
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unsubscribe();
    unlisten?.();
  };
}

export function requestPetVoice(request: PetVoiceRequest): Promise<void> {
  return emitTo('main', PET_VOICE_REQUEST, request);
}

export function subscribePetVoice(listener: (open: boolean) => void): Promise<() => void> {
  return listen<boolean>(PET_VOICE_STATE, ({ payload }) => {
    if (typeof payload === 'boolean') listener(payload);
  });
}

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

type OutputListener = (payload: TerminalOutputPayload) => void;
type AttachNativeListener = (listener: OutputListener) => Promise<UnlistenFn>;

export interface TerminalOutputSubscription {
  bind(sessionId: string): void;
  unsubscribe(): void;
}

export function createTerminalOutputRouter(attachNativeListener: AttachNativeListener) {
  let nextId = 1;
  let detachNative: UnlistenFn | undefined;
  let attachInFlight: Promise<void> | undefined;
  const subscriptions = new Map<
    number,
    { listener: OutputListener; sessionId: string | undefined }
  >();

  const route = (payload: TerminalOutputPayload) => {
    for (const subscription of subscriptions.values()) {
      if (subscription.sessionId === undefined || subscription.sessionId === payload.sessionId) {
        try {
          subscription.listener(payload);
        } catch {
          // A failed pane must not prevent other terminals from receiving output.
          // Keep the warning content-free because terminal payloads can be sensitive.
          console.warn('[terminal-output-router] pane listener failed');
        }
      }
    }
  };

  const ensureAttached = async () => {
    if (detachNative) return;
    if (!attachInFlight) {
      attachInFlight = attachNativeListener(route)
        .then((detach) => {
          detachNative = detach;
        })
        .finally(() => {
          attachInFlight = undefined;
        });
    }
    await attachInFlight;
  };

  return {
    async subscribe(listener: OutputListener): Promise<TerminalOutputSubscription> {
      const id = nextId++;
      const subscription = { listener, sessionId: undefined as string | undefined };
      subscriptions.set(id, subscription);
      try {
        await ensureAttached();
      } catch (error) {
        subscriptions.delete(id);
        throw error;
      }

      let active = true;
      return {
        bind(sessionId) {
          if (active) subscription.sessionId = sessionId;
        },
        unsubscribe() {
          if (!active) return;
          active = false;
          subscriptions.delete(id);
          if (subscriptions.size === 0 && detachNative) {
            const detach = detachNative;
            detachNative = undefined;
            detach();
          }
        },
      };
    },
  };
}

const sharedTerminalOutputRouter = createTerminalOutputRouter(async (listener) =>
  listen<TerminalOutputPayload>('terminal://output', (event) => listener(event.payload)),
);

export const subscribeTerminalOutput = sharedTerminalOutputRouter.subscribe;

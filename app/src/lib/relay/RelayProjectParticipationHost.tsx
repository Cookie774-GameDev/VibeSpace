import { useEffect, useRef } from 'react';
import {
  createRelayProjectParticipationCoordinator,
  type RelayParticipationInput,
  type RelayParticipationState,
  type RelayProjectAuthorization,
  type RelayProjectParticipationPort,
} from './relayProjectParticipation';

/** Main/native-authoritative source only; never deserialize provider or PTY input into it. */
export interface RelayVerifiedSubjectSource {
  getSnapshot(): RelayParticipationInput;
  subscribe(listener: () => void): (() => void) | Promise<() => void>;
}
export type RelayProjectParticipationHostProps = Readonly<{
  source: RelayVerifiedSubjectSource;
  native: RelayProjectParticipationPort;
  authorizeProject: RelayProjectAuthorization;
  onState?: (state: RelayParticipationState) => void;
}>;

/** Intentionally not mounted in App/ToolGatewayHost until native glue review. */
export function RelayProjectParticipationHost({
  source,
  native,
  authorizeProject,
  onState,
}: RelayProjectParticipationHostProps) {
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Effect-owned: never reuse a disposed coordinator on StrictMode replay.
    const coordinator = createRelayProjectParticipationCoordinator({ native, authorizeProject });
    const unsubscribeState = coordinator.subscribe((state) => {
      if (!disposed) onStateRef.current?.(state);
    });
    const close = () => {
      if (disposed) return;
      disposed = true;
      unsubscribeState();
      try {
        unlisten?.();
      } catch {
        // A source cleanup failure must not retain the local observer or pending request, or
        // expose private transport errors through a React effect exception.
      } finally {
        unlisten = undefined;
        coordinator.dispose();
      }
    };
    const update = () => {
      if (disposed) return;
      try {
        coordinator.update(source.getSnapshot());
      } catch {
        close();
      }
    };
    try {
      const subscription = source.subscribe(update);
      // Subscribe before reading, so a subject change cannot fall in a gap.
      update();
      void Promise.resolve(subscription)
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(close);
    } catch {
      close();
    }
    return close;
  }, [source, native, authorizeProject]);
  return null;
}

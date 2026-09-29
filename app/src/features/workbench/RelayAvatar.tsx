import * as React from 'react';
import { NatureAvatar } from '@/features/avatars/NatureAvatar';
import type { RelayRoomParticipant, RelayRoomView } from './RelayGroupChat';
import { RelayAvatarStore, RelayDeliveryTracker } from './relayAvatarModel';

const AvatarContext = React.createContext<{
  store: RelayAvatarStore;
  roomId?: string;
  active: boolean;
} | null>(null);

type ProviderProps = { room: RelayRoomView; active?: boolean; children: React.ReactNode };

function AvatarSession({ room, active = true, children }: ProviderProps) {
  const [store] = React.useState(() => new RelayAvatarStore());
  const [tracker] = React.useState(() => new RelayDeliveryTracker());
  const connected = room.connection === 'connected';

  React.useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () =>
      store.setEnvironment(active && connected && !document.hidden && !media?.matches);
    update();
    document.addEventListener('visibilitychange', update);
    media?.addEventListener?.('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      media?.removeEventListener?.('change', update);
      store.setEnvironment(false);
    };
  }, [store, active, connected]);

  React.useEffect(() => {
    for (const message of tracker.consume(room, active)) store.receive(message);
  }, [room, active, store, tracker]);

  React.useEffect(() => () => store.stop(), [store]);
  const context = React.useMemo(
    () => ({ store, roomId: room.roomId, active: active && connected }),
    [store, room.roomId, active, connected],
  );
  return <AvatarContext.Provider value={context}>{children}</AvatarContext.Provider>;
}

/** A changed native room identity creates a new baseline and cancels the old timers. */
export function RelayAvatarProvider(props: ProviderProps) {
  const inherited = React.useContext(AvatarContext);
  // A containing room owns delivery and visibility policy. Nested views of that
  // exact explicit room share its timeline; unrelated/anonymous rooms do not.
  if (props.room.roomId && inherited?.roomId === props.room.roomId) return <>{props.children}</>;
  return <AvatarSession key={props.room.roomId ?? props.room.scope} {...props} />;
}

export function RelayAvatar({
  participant,
  size = 32,
}: {
  participant: Pick<RelayRoomParticipant, 'id' | 'name' | 'status'>;
  size?: number;
}) {
  const context = React.useContext(AvatarContext);
  const store = context?.store;
  const element = React.useRef<HTMLSpanElement>(null);
  const fallback = React.useMemo(() => new RelayAvatarStore(), []);
  const source = store ?? fallback;
  const subscribe = React.useCallback(
    (listener: () => void) => source.subscribe(participant.id, listener),
    [source, participant.id],
  );
  const getSnapshot = React.useCallback(
    () => source.getSnapshot(participant.id),
    [source, participant.id],
  );
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useEffect(() => {
    const target = element.current;
    if (!store || !target) return;
    let release: (() => void) | undefined;
    const setVisible = (visible: boolean) => {
      if (visible && !release) release = store.observe(participant.id);
      else if (!visible && release) {
        release();
        release = undefined;
      }
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                if (entry.target === target) setVisible(entry.isIntersecting);
            },
            { threshold: 0.01 },
          );
    if (observer) observer.observe(target);
    else setVisible(true);
    return () => {
      observer?.disconnect();
      release?.();
    };
  }, [store, participant.id]);

  return (
    <span
      ref={element}
      data-relay-avatar={participant.id}
      data-frame={snapshot.frame}
      data-phase={snapshot.phase}
      data-reactions={snapshot.reactions}
      style={{
        display: 'inline-flex',
        flex: 'none',
        width: size,
        height: size,
        verticalAlign: 'middle',
      }}
    >
      <NatureAvatar
        identity={participant.id}
        name={participant.name}
        size={size}
        reactionKey={snapshot.lastMessageId}
        active={context?.active ?? false}
        inactive={participant.status === 'offline'}
      />
    </span>
  );
}

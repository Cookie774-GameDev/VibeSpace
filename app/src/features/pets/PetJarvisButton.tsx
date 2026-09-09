import * as React from 'react';
import { Bot } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { requestPetVoice, subscribePetVoice } from './petVoiceBridge';

/** Same glowing Jarvis mark as the main header, without a second voice host. */
export function PetJarvisButton({ detached }: { detached: boolean }) {
  const localOpen = useUIStore((s) => s.voiceModalOpen);
  const [remoteOpen, setRemoteOpen] = React.useState(false);
  const [pending, setPending] = React.useState(detached);
  const [error, setError] = React.useState(false);
  const [connectionAttempt, setConnectionAttempt] = React.useState(0);
  const reconnectRequest = React.useRef<'sync' | 'open'>('sync');
  const connection = React.useRef(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const beginRequest = React.useCallback((request: 'sync' | 'open' | 'close') => {
    const generation = connection.current;
    setPending(true);
    setError(false);
    clearTimeout(timer.current);
    const fail = () => {
      if (generation !== connection.current) return;
      setPending(false);
      setError(true);
    };
    timer.current = setTimeout(fail, 4000);
    void requestPetVoice(request).catch(() => {
      if (generation !== connection.current) return;
      clearTimeout(timer.current);
      fail();
    });
  }, []);
  React.useEffect(() => {
    if (!detached) return;
    setPending(true);
    setError(false);
    let disposed = false;
    let off: (() => void) | undefined;
    timer.current = setTimeout(() => {
      if (!disposed) {
        setPending(false);
        setError(true);
      }
    }, 4000);
    void subscribePetVoice((open) => {
      if (disposed) return;
      clearTimeout(timer.current);
      setRemoteOpen(open);
      setPending(false);
      setError(false);
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else {
          off = unsubscribe;
          beginRequest(reconnectRequest.current);
          reconnectRequest.current = 'sync';
        }
      })
      .catch(() => {
        if (!disposed) {
          setPending(false);
          setError(true);
        }
      });
    return () => {
      disposed = true;
      connection.current += 1;
      off?.();
      clearTimeout(timer.current);
    };
  }, [detached, beginRequest, connectionAttempt]);
  const active = detached ? remoteOpen : localOpen;
  return (
    <button
      type="button"
      className="pet-panel-voice-button jarvis-breadcrumb-trigger relative grid place-items-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-copper"
      aria-label={
        error
          ? 'Retry Jarvis voice connection'
          : active
            ? 'Stop Jarvis voice'
            : 'Start Jarvis voice'
      }
      aria-pressed={active}
      aria-busy={pending}
      disabled={pending}
      title={
        error
          ? 'Jarvis did not respond. Click to reconnect.'
          : active
            ? 'Stop Jarvis voice'
            : 'Talk to Jarvis'
      }
      onClick={() => {
        if (detached && error) {
          reconnectRequest.current = 'open';
          setConnectionAttempt((attempt) => attempt + 1);
        } else if (detached) beginRequest(active ? 'close' : 'open');
        else useUIStore.getState().setVoiceModalOpen(!active);
      }}
    >
      <span
        aria-hidden
        className="jarvis-j-glow pointer-events-none absolute -inset-1 rounded-full"
      />
      <span
        aria-hidden
        className="jarvis-bot-mark relative z-[1] grid h-6 w-6 place-items-center rounded-full"
      >
        <Bot className="h-4 w-4" strokeWidth={2.4} />
      </span>
    </button>
  );
}

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { GlobalDictationOverlay } from './features/global-dictation/GlobalDictationOverlay';
import { applyThemeToDocument, useUIStore } from './stores/ui';
import { startThemeSync, applyThemeSyncToApplication } from './features/appearance/themeSync';
import {
  createTauriRuntimeProfileQuery,
  resolveRuntimePlan,
  resolveRuntimeProfileHandshakeExpectation,
  verifyRuntimeProfileHandshake,
} from './lib/runtimeProfile';
import './styles/globals.css';
import './styles/vibespace-theme.css';
import './styles/monochrome-theme.css';
import './styles/sakura-theme.css';
import './styles/warm-theme.css';
import './styles/origami-theme.css';

const TOGGLE = 'jarvis:global-dictation-toggle';
const compact: React.CSSProperties = {
  width: 120,
  height: 30,
  border: 0,
  borderRadius: 999,
  padding: '0 8px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  overflow: 'hidden',
  background: 'hsl(var(--background))',
  color: 'hsl(var(--foreground))',
  font: '11px system-ui',
};

export async function verifyDictationRuntime() {
  const plan = resolveRuntimePlan();
  await verifyRuntimeProfileHandshake(
    createTauriRuntimeProfileQuery(),
    plan,
    resolveRuntimeProfileHandshakeExpectation(plan),
  );
  return plan.sttEnabled;
}

function CompactStatus({ failed, retry }: { failed: boolean; retry: () => void }) {
  return (
    <button
      type="button"
      style={compact}
      onClick={failed ? retry : undefined}
      aria-label={failed ? 'Retry dictation startup' : 'Preparing dictation'}
      title={
        failed
          ? 'Voice could not start. Click or press your dictation shortcut to retry. Escape closes this module.'
          : 'Preparing secure dictation…'
      }
    >
      <img src="/vibespace-icon.png" width="18" height="18" alt="" />
      <span role="status">{failed ? 'Retry voice' : 'Preparing…'}</span>
    </button>
  );
}

class DictationRenderBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <CompactStatus failed retry={() => window.location.reload()} />
    ) : (
      this.props.children
    );
  }
}

function ReadyDictation({
  enabled,
  queued,
}: {
  enabled: boolean;
  queued: React.MutableRefObject<boolean>;
}) {
  // The child's synchronous DOM listener is installed before this parent effect.
  // Replay a startup press exactly once after verification, never before it.
  React.useEffect(() => {
    if (!enabled || !queued.current) return;
    queued.current = false;
    window.dispatchEvent(new Event(TOGGLE));
  }, [enabled, queued]);
  return (
    <DictationRenderBoundary>
      <GlobalDictationOverlay runtimeEffectsEnabled={enabled} />
    </DictationRenderBoundary>
  );
}

export function DictationBootstrap({
  verify = verifyDictationRuntime,
}: {
  verify?: () => Promise<boolean>;
}) {
  const [phase, setPhase] = React.useState<'starting' | 'ready' | 'error'>('starting');
  const [enabled, setEnabled] = React.useState(false);
  const phaseRef = React.useRef(phase);
  const queued = React.useRef(false);
  const generation = React.useRef(0);
  const running = React.useRef(false);
  const retry = React.useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const id = ++generation.current;
    phaseRef.current = 'starting';
    setPhase('starting');
    try {
      const allowed = await verify();
      if (id !== generation.current) return;
      setEnabled(allowed);
      phaseRef.current = 'ready';
      setPhase('ready');
    } catch {
      if (id !== generation.current) return;
      phaseRef.current = 'error';
      setPhase('error');
    } finally {
      if (id === generation.current) running.current = false;
    }
  }, [verify]);

  React.useEffect(() => {
    const onToggle = () => {
      if (phaseRef.current === 'ready') return;
      queued.current = true;
      if (phaseRef.current === 'error') void retry();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || phaseRef.current === 'ready') return;
      queued.current = false;
      void getCurrentWindow()
        .hide()
        .catch(() => undefined);
    };
    let disposed = false;
    let off: (() => void) | undefined;
    void listen(TOGGLE, onToggle)
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
    window.addEventListener(TOGGLE, onToggle);
    window.addEventListener('keydown', onKey);
    void retry();
    return () => {
      disposed = true;
      generation.current++;
      running.current = false;
      off?.();
      window.removeEventListener(TOGGLE, onToggle);
      window.removeEventListener('keydown', onKey);
    };
  }, [retry]);

  return phase === 'ready' ? (
    <ReadyDictation enabled={enabled} queued={queued} />
  ) : (
    <CompactStatus
      failed={phase === 'error'}
      retry={() => {
        queued.current = true;
        void retry();
      }}
    />
  );
}

export function mountDictation(root: HTMLElement) {
  for (const element of [document.documentElement, document.body, root]) {
    element.style.setProperty('background', 'transparent', 'important');
    element.style.overflow = 'hidden';
  }
  applyThemeToDocument(useUIStore.getState().theme);
  const stopTheme = startThemeSync((theme) =>
    applyThemeSyncToApplication(theme, document, useUIStore),
  );
  window.addEventListener('pagehide', stopTheme, { once: true });
  createRoot(root).render(<DictationBootstrap />);
  if (import.meta.hot) import.meta.hot.dispose(stopTheme);
}

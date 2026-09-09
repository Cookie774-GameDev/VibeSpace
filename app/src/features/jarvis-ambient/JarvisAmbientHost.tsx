import * as React from 'react';

import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import {
  getJarvisPlaybackEnergy,
  subscribeJarvisPlaybackEnergy,
} from '@/features/voice/jarvisPlaybackEnergy';
import { useVoiceStore } from '@/features/voice/store';
import { useUIStore } from '@/stores/ui';
import { JarvisEdgeAura, normalizeAmbientSnapshot } from './JarvisEdgeAura';
import { projectJarvisAmbientSnapshot } from './projection';
import { getJarvisInputEnergy, subscribeJarvisInputEnergy } from './voiceEnergy';
import type { JarvisAmbientSnapshot } from './types';

const AMBIENT_EVENT = 'jarvis://ambient-snapshot';
const ENERGY_FRAME_MS = 34;
let lastPublishedRevision = 0;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function nextRevision(previous: number): number {
  lastPublishedRevision = Math.max(
    previous + 1,
    lastPublishedRevision + 1,
    Math.trunc(Date.now() * 1_000),
  );
  return lastPublishedRevision;
}

function currentEnergy(): number {
  const state = useVoiceStore.getState().state;
  if (state === 'listening') return getJarvisInputEnergy();
  if (state === 'speaking') return getJarvisPlaybackEnergy();
  return 0;
}

export function JarvisAmbientHost() {
  const [localSnapshot, setLocalSnapshot] = React.useState<JarvisAmbientSnapshot>(() =>
    normalizeAmbientSnapshot(null),
  );
  React.useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let expiryTimer: number | null = null;
    let revision = 0;
    let lastSignature = '';
    let pendingSnapshot: JarvisAmbientSnapshot | null = null;
    let sending = false;
    const drain = async () => {
      if (!isTauriRuntime()) {
        if (!disposed && pendingSnapshot) setLocalSnapshot(pendingSnapshot);
        pendingSnapshot = null;
        return;
      }
      if (sending) return;
      sending = true;
      try {
        while (pendingSnapshot) {
          const { invoke } = await import('@tauri-apps/api/core');
          const snapshot = pendingSnapshot;
          pendingSnapshot = null;
          if (!snapshot || (disposed && snapshot.active !== false)) continue;
          try {
            await invoke('set_jarvis_ambient_snapshot', { snapshot });
          } catch {
            /* A later authoritative snapshot can retry; never replay stale states. */
          }
        }
      } finally {
        sending = false;
      }
    };

    const flush = () => {
      timer = null;
      if (disposed) return;
      revision = nextRevision(revision);
      const snapshot = projectJarvisAmbientSnapshot({
        revision,
        observedAt: Date.now(),
        voiceOpen: useUIStore.getState().voiceModalOpen,
        voiceState: useVoiceStore.getState().state,
        sessionId: useVoiceStore.getState().session?.sessionId,
        runs: Object.values(useJarvisTaskRunStore.getState().runs),
        energy: currentEnergy(),
      });
      const signature = `${snapshot.active}:${snapshot.sessionId ?? ''}:${snapshot.state}:${snapshot.source}:${snapshot.energy}:${snapshot.transientUntil ?? 0}`;
      if (expiryTimer !== null) {
        window.clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      if (snapshot.transientUntil !== undefined) {
        expiryTimer = window.setTimeout(
          flush,
          Math.max(1, snapshot.transientUntil - Date.now() + 1),
        );
      }
      if (signature === lastSignature) return;
      lastSignature = signature;
      pendingSnapshot = snapshot;
      void drain();
    };

    const schedule = () => {
      if (disposed || timer !== null) return;
      timer = window.setTimeout(flush, ENERGY_FRAME_MS);
    };

    const unsubscribers = [
      useVoiceStore.subscribe(schedule),
      useUIStore.subscribe(schedule),
      useJarvisTaskRunStore.subscribe(schedule),
      subscribeJarvisInputEnergy(schedule),
      subscribeJarvisPlaybackEnergy(schedule),
    ];
    flush();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      // Supersede all queued activity with one monotonic close tombstone.
      pendingSnapshot = Object.freeze({
        revision: nextRevision(revision),
        observedAt: Date.now(),
        active: false,
        state: 'idle',
        source: 'voice',
        energy: 0,
      });
      void drain();
    };
  }, []);
  return isTauriRuntime() ? null : <JarvisEdgeAura snapshot={localSnapshot} />;
}

export function JarvisAmbientOverlayView() {
  const [snapshot, setSnapshot] = React.useState<JarvisAmbientSnapshot>(() =>
    normalizeAmbientSnapshot(null),
  );

  React.useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const applySnapshot = (value: unknown) => {
      if (disposed) return;
      const next = normalizeAmbientSnapshot(value);
      setSnapshot((current) => (next.revision > current.revision ? next : current));
    };
    void Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')])
      .then(async ([{ listen }, { invoke }]) => {
        unlisten = await listen<unknown>(AMBIENT_EVENT, (event) => {
          applySnapshot(event.payload);
        });
        if (disposed) {
          unlisten();
          unlisten = undefined;
          return;
        }
        const initial = await invoke<unknown>('jarvis_ambient_renderer_ready');
        applySnapshot(initial);
      })
      .catch(() => {
        // Keep a newer authoritative event if the readiness request itself fails.
        applySnapshot(null);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return <JarvisEdgeAura snapshot={snapshot} />;
}

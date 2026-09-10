import * as React from 'react';

import { createAuraRenderer, auraEnergy } from './auraRenderer';
import { isJarvisAmbientSnapshot, type JarvisAmbientSnapshot } from './types';
import './JarvisEdgeAura.css';

const IDLE_SNAPSHOT: JarvisAmbientSnapshot = Object.freeze({
  revision: 0,
  state: 'idle',
  source: 'voice',
  observedAt: 0,
  energy: 0,
});

export function normalizeAmbientSnapshot(value: unknown): JarvisAmbientSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return IDLE_SNAPSHOT;
  // Rust serializes an absent Option<i64> as null. Normalize the wire shape
  // before strict validation; never coerce required fields or visibility intent.
  const candidate = { ...value } as Record<string, unknown>;
  if (candidate.transientUntil === null) delete candidate.transientUntil;
  if (candidate.sessionId === null) delete candidate.sessionId;
  return isJarvisAmbientSnapshot(candidate) ? Object.freeze(candidate) : IDLE_SNAPSHOT;
}

export function JarvisEdgeAura({
  snapshot,
  reducedMotion,
}: {
  snapshot: JarvisAmbientSnapshot;
  reducedMotion?: boolean;
}) {
  const safeSnapshot = normalizeAmbientSnapshot(snapshot),
    snapshotRef = React.useRef(safeSnapshot),
    canvasRef = React.useRef<HTMLCanvasElement>(null),
    repaintRef = React.useRef<(() => void) | null>(null);
  snapshotRef.current = safeSnapshot;
  React.useEffect(() => {
    const canvas = canvasRef.current,
      context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const renderer = createAuraRenderer(),
      query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame: number | null = null,
      disposed = false,
      last = 0,
      time = 0,
      energy = 0,
      state = '',
      wasActive = false;
    const isActive = () =>
      snapshotRef.current.active !== false && snapshotRef.current.state !== 'idle';
    const paint = (now: number) => {
      frame = null;
      if (disposed) return;
      const current = snapshotRef.current,
        active = isActive(),
        reduce = reducedMotion ?? query?.matches === true;
      if (!active) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        renderer.destroy();
        wasActive = false;
        energy = 0;
        return;
      }
      if (document.hidden) {
        last = 0;
        return;
      }
      // Avoid redundant paints on high-refresh displays; elapsed time still
      // drives the approved motion speed and voice smoothing.
      if (!reduce && last && now - last < 1000 / 60) {
        frame = window.requestAnimationFrame(paint);
        return;
      }
      const dt = last ? Math.min(100, now - last) : 0;
      last = now;
      if (state !== current.state || !wasActive) {
        state = current.state;
        time = 0;
        energy = 0;
      } else time += dt;
      wasActive = true;
      const ratio = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1)),
        width = Math.round(window.innerWidth * ratio),
        height = Math.round(window.innerHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const target = auraEnergy(current.state, current.energy),
        rate = target > energy ? 0.3 : 0.09;
      energy = reduce
        ? target
        : energy + (target - energy) * (1 - Math.pow(1 - rate, Math.max(dt, 16.67) / 16.67));
      renderer.draw(
        context,
        { ...current, energy },
        window.innerWidth,
        window.innerHeight,
        time,
        reduce,
      );
      if (!reduce) frame = window.requestAnimationFrame(paint);
    };
    const repaint = () => {
      if (frame === null) frame = window.requestAnimationFrame(paint);
    };
    const visibility = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      last = 0;
      if (!document.hidden) repaint();
    };
    repaintRef.current = repaint;
    repaint();
    window.addEventListener('resize', repaint, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    query?.addEventListener('change', repaint);
    return () => {
      disposed = true;
      repaintRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      renderer.destroy();
      window.removeEventListener('resize', repaint);
      document.removeEventListener('visibilitychange', visibility);
      query?.removeEventListener('change', repaint);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [reducedMotion]);
  React.useEffect(() => {
    repaintRef.current?.();
  }, [safeSnapshot.state, safeSnapshot.active, safeSnapshot.energy]);
  const active = safeSnapshot.active !== false && safeSnapshot.state !== 'idle';
  return (
    <div
      className="jarvis-edge-aura"
      data-testid="jarvis-edge-aura"
      data-jarvis-ambient-state={safeSnapshot.state}
      data-active={active}
      data-voice-session={safeSnapshot.sessionId}
      data-energy={safeSnapshot.energy.toFixed(2)}
      aria-hidden="true"
    >
      <canvas className="jarvis-edge-aura__canvas" ref={canvasRef} />
    </div>
  );
}

import * as React from 'react';

import { JARVIS_EDGE_PRESETS } from './presets';
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
  return isJarvisAmbientSnapshot(candidate) ? Object.freeze(candidate) : IDLE_SNAPSHOT;
}

function perimeterPoint(distance: number, width: number, height: number, inset: number) {
  const w = Math.max(1, width - inset * 2);
  const h = Math.max(1, height - inset * 2);
  const perimeter = 2 * (w + h);
  let cursor = ((distance % perimeter) + perimeter) % perimeter;
  if (cursor <= w) return { x: inset + cursor, y: inset };
  cursor -= w;
  if (cursor <= h) return { x: inset + w, y: inset + cursor };
  cursor -= h;
  if (cursor <= w) return { x: inset + w - cursor, y: inset + h };
  cursor -= w;
  return { x: inset, y: inset + h - cursor };
}

function strokeSegment(
  context: CanvasRenderingContext2D,
  progress: number,
  segment: number,
  width: number,
  height: number,
  inset: number,
) {
  const perimeter = 2 * (Math.max(1, width - inset * 2) + Math.max(1, height - inset * 2));
  const start = progress * perimeter;
  const steps = Math.max(16, Math.ceil(segment * 160));
  context.beginPath();
  for (let index = 0; index <= steps; index += 1) {
    const point = perimeterPoint(
      start + (index / steps) * segment * perimeter,
      width,
      height,
      inset,
    );
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
}

function drawAura(
  context: CanvasRenderingContext2D,
  snapshot: JarvisAmbientSnapshot,
  width: number,
  height: number,
  now: number,
  reducedMotion: boolean,
) {
  context.clearRect(0, 0, width, height);
  if (snapshot.active === false || snapshot.state === 'idle') return;
  const preset = JARVIS_EDGE_PRESETS[snapshot.state];
  const energy =
    snapshot.state === 'listening' || snapshot.state === 'speaking'
      ? Math.min(1, Math.pow(snapshot.energy * preset.energyGain, 0.82))
      : 0;
  const phase =
    reducedMotion || preset.periodMs === 0 ? 0 : (now % preset.periodMs) / preset.periodMs;
  const flash =
    snapshot.state === 'needs' || snapshot.state === 'error'
      ? reducedMotion
        ? 0.9
        : 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2))
      : 1;
  const band = preset.minBand + (preset.maxBand - preset.minBand) * energy;
  const inset = Math.max(3, band / 2 + 2);

  context.save();
  context.globalCompositeOperation = 'lighter';
  context.strokeStyle = preset.color;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = preset.color;
  context.shadowBlur = preset.glow + energy * 24;
  context.globalAlpha = preset.alpha * flash * (0.38 + energy * 0.62);
  context.lineWidth = Math.max(4, band);
  context.strokeRect(inset, inset, Math.max(1, width - inset * 2), Math.max(1, height - inset * 2));

  if (
    snapshot.state === 'working' ||
    snapshot.state === 'listening' ||
    snapshot.state === 'speaking'
  ) {
    context.globalAlpha = Math.min(1, (preset.alpha + energy * 0.22) * flash);
    context.lineWidth = Math.max(7, band * (snapshot.state === 'working' ? 1.45 : 1.18));
    context.shadowBlur = preset.glow + 12 + energy * 32;
    const speedBoost = 1 + energy * 1.5;
    strokeSegment(
      context,
      reducedMotion ? 0.08 : (phase * speedBoost) % 1,
      preset.segment + energy * 0.08,
      width,
      height,
      inset,
    );
  }
  context.restore();
}

export function JarvisEdgeAura({
  snapshot,
  reducedMotion,
}: {
  snapshot: JarvisAmbientSnapshot;
  reducedMotion?: boolean;
}) {
  const safeSnapshot = normalizeAmbientSnapshot(snapshot);
  const snapshotRef = React.useRef(safeSnapshot);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const repaintRef = React.useRef<(() => void) | null>(null);
  snapshotRef.current = safeSnapshot;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame: number | null = null;
    let live = true;
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const paint = (now: number) => {
      if (!live) return;
      const ratio = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.round(window.innerWidth * ratio));
      const height = Math.max(1, Math.round(window.innerHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const reduce = reducedMotion ?? motionQuery?.matches === true;
      drawAura(context, snapshotRef.current, window.innerWidth, window.innerHeight, now, reduce);
      if (!reduce && snapshotRef.current.active !== false && snapshotRef.current.state !== 'idle')
        frame = window.requestAnimationFrame(paint);
    };

    const repaint = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(paint);
    };
    repaintRef.current = repaint;
    repaint();
    window.addEventListener('resize', repaint, { passive: true });
    motionQuery?.addEventListener?.('change', repaint);
    return () => {
      live = false;
      repaintRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', repaint);
      motionQuery?.removeEventListener?.('change', repaint);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [reducedMotion, safeSnapshot.state, safeSnapshot.active]);

  // Static/reduced-motion frames must still reflect actual changing audio energy.
  React.useEffect(() => {
    repaintRef.current?.();
  }, [safeSnapshot.energy]);

  return (
    <div
      className="jarvis-edge-aura"
      data-testid="jarvis-edge-aura"
      data-jarvis-ambient-state={safeSnapshot.state}
      data-active={safeSnapshot.active ?? safeSnapshot.state !== 'idle'}
      data-voice-session={safeSnapshot.sessionId}
      data-energy={safeSnapshot.energy.toFixed(2)}
      aria-hidden="true"
    >
      <canvas className="jarvis-edge-aura__canvas" ref={canvasRef} />
    </div>
  );
}

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
  if (candidate.sessionId === null) delete candidate.sessionId;
  return isJarvisAmbientSnapshot(candidate) ? Object.freeze(candidate) : IDLE_SNAPSHOT;
}

function perimeterPoint(distance: number, width: number, height: number, inset: number) {
  const w = Math.max(1, width - inset * 2);
  const h = Math.max(1, height - inset * 2);
  const radius = Math.min(22, w / 2, h / 2);
  const horizontal = w - radius * 2;
  const vertical = h - radius * 2;
  const arc = (Math.PI * radius) / 2;
  const perimeter = 2 * (horizontal + vertical) + arc * 4;
  let cursor = ((distance % perimeter) + perimeter) % perimeter;
  const centers = [
    [inset + w - radius, inset + radius],
    [inset + w - radius, inset + h - radius],
    [inset + radius, inset + h - radius],
    [inset + radius, inset + radius],
  ];
  for (let side = 0; side < 4; side++) {
    const length = side % 2 === 0 ? horizontal : vertical;
    if (cursor <= length) {
      if (side === 0) return { x: inset + radius + cursor, y: inset };
      if (side === 1) return { x: inset + w, y: inset + radius + cursor };
      if (side === 2) return { x: inset + w - radius - cursor, y: inset + h };
      return { x: inset, y: inset + h - radius - cursor };
    }
    cursor -= length;
    if (cursor <= arc) {
      const angle = -Math.PI / 2 + (side * Math.PI) / 2 + cursor / radius;
      return {
        x: centers[side][0] + Math.cos(angle) * radius,
        y: centers[side][1] + Math.sin(angle) * radius,
      };
    }
    cursor -= arc;
  }
  return { x: inset + radius, y: inset };
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
  if (snapshot.active === false || (snapshot.state === 'idle' && snapshot.active !== true)) return;
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
  const depth = Math.min(width, height) * 0.09 + preset.glow + energy * 48;
  const rgba = (hex: string, alpha: number) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return 'rgba(' + (value >> 16) + ',' + ((value >> 8) & 255) + ',' + (value & 255) + ',' + alpha + ')';
  };
  context.save();
  context.globalCompositeOperation = 'source-over';
  // Continuous inward falloff: no outlined rectangle or sharp travelling core.
  const edges = [
    [0, 0, 0, depth, 0, 0, width, depth],
    [width, 0, width - depth, 0, width - depth, 0, depth, height],
    [0, height, 0, height - depth, 0, height - depth, width, depth],
    [0, 0, depth, 0, 0, 0, depth, height],
  ];
  const breathe = reducedMotion ? 1 : 0.84 + 0.16 * Math.sin(phase * Math.PI * 2);
  for (const [x0, y0, x1, y1, x, y, w, h] of edges) {
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    const opacity = preset.alpha * flash * breathe * (0.30 + energy * 0.15);
    gradient.addColorStop(0, rgba(preset.color, opacity));
    gradient.addColorStop(0.25, rgba(preset.color, opacity * 0.52));
    gradient.addColorStop(0.6, rgba(preset.color, opacity * 0.12));
    gradient.addColorStop(1, rgba(preset.color, 0));
    context.fillStyle = gradient;
    context.fillRect(x, y, w, h);
  }
  if (['idle', 'working', 'listening', 'speaking'].includes(snapshot.state)) {
    const colors = [preset.color, '#9b7bff', '#65ffe0'];
    const perimeter = 2 * (width + height);
    for (let index = 0; index < colors.length; index++) {
      const point = perimeterPoint((phase + index / 3) * perimeter, width, height, 0);
      const radius = depth * 2.6;
      const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      gradient.addColorStop(0, rgba(colors[index], 0.48 + energy * 0.16));
      gradient.addColorStop(0.3, rgba(colors[index], 0.24));
      gradient.addColorStop(0.65, rgba(colors[index], 0.06));
      gradient.addColorStop(1, rgba(colors[index], 0));
      context.fillStyle = gradient;
      context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
    }
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
      if (
        !reduce &&
        snapshotRef.current.active !== false &&
        (snapshotRef.current.active === true || snapshotRef.current.state !== 'idle')
      )
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

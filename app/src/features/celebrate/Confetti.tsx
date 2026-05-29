import * as React from 'react';
import { CELEBRATE_EVENT, type CelebrationKind } from './celebrate';

/**
 * Cozy palette — same warm tones the rest of Jarvis uses.
 */
const PALETTE = [
  '#c97b6e', '#7c9870', '#d4a258', '#9d8aa8',
  '#f5e6c8', '#d97757', '#5d7855', '#b88a3f',
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;        // remaining seconds
  maxLife: number;     // initial seconds (for alpha fade)
  rotation: number;
  rotationVel: number;
  color: string;
  shape: 'rect' | 'circle';
  size: number;
}

function countFor(kind: CelebrationKind): number {
  if (kind === 'kanban_done') return 40;
  if (kind === 'big') return 200;
  return 80;
}

/**
 * Decide where particles emit from.
 *  - project_created, kanban_done: bottom-center
 *  - terminal_success:             bottom-right
 *  - big:                          horizontal sweep across the top
 */
function originFor(kind: CelebrationKind, w: number, h: number): { x: number; y: number } {
  if (kind === 'big') {
    return { x: Math.random() * w, y: Math.random() * 40 };
  }
  if (kind === 'terminal_success') {
    return {
      x: w - 60 + (Math.random() - 0.5) * 100,
      y: h - 60 + (Math.random() - 0.5) * 50,
    };
  }
  return {
    x: w / 2 + (Math.random() - 0.5) * 180,
    y: h - 40 + (Math.random() - 0.5) * 30,
  };
}

function spawn(kind: CelebrationKind, w: number, h: number): Particle[] {
  const count = countFor(kind);
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const o = originFor(kind, w, h);
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 4;
    const maxLife = 1.0 + Math.random() * 0.6;
    out.push({
      x: o.x,
      y: o.y,
      vx: Math.cos(angle) * speed,
      vy: -8 - Math.random() * 6, // -8 to -14, per spec
      life: maxLife,
      maxLife,
      rotation: Math.random() * Math.PI * 2,
      rotationVel: (Math.random() - 0.5) * 0.3,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      shape: Math.random() < 0.55 ? 'rect' : 'circle',
      size: 5 + Math.random() * 5,
    });
  }
  return out;
}

/**
 * Pure-canvas confetti overlay. No npm dep.
 *
 * Subscribes to `jarvis:celebrate` events on `window`, spawns particles,
 * and runs a requestAnimationFrame loop until the field is empty.
 * Honors `prefers-reduced-motion`: when reduced, the event is ignored.
 */
export function Confetti() {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = window.devicePixelRatio || 1;
    let cssW = window.innerWidth;
    let cssH = window.innerHeight;
    let particles: Particle[] = [];
    let rafId: number | null = null;
    let lastTime = 0;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      cssW = window.innerWidth;
      cssH = window.innerHeight;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    const tick = (now: number) => {
      // Clamp dt so backgrounded tabs don't teleport particles.
      const rawDt = lastTime ? (now - lastTime) / 1000 : 1 / 60;
      const dt = Math.min(rawDt, 1 / 30);
      lastTime = now;

      // Clear in raw pixel space; redraw in CSS-pixel space.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Physics constants in spec are per-frame at ~60fps; scale by dt.
      const fs = dt * 60;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * fs;
        p.y += p.vy * fs;
        p.vy += 0.36 * fs;             // gravity
        p.vx *= Math.pow(0.995, fs);   // horizontal damping
        p.rotation += p.rotationVel * fs;

        const alpha = Math.max(0, Math.min(1, p.life / p.maxLife));
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') {
          // Paper-strip feel: 2:1 rect.
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (particles.length > 0) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
        lastTime = 0;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };

    const onCelebrate = (e: WindowEventMap[typeof CELEBRATE_EVENT]) => {
      // Reduced motion: short-circuit the canvas; toast still fires elsewhere.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const fresh = spawn(e.detail.kind, cssW, cssH);
      particles.push(...fresh);
      if (rafId === null) {
        lastTime = 0;
        rafId = requestAnimationFrame(tick);
      }
    };

    window.addEventListener(CELEBRATE_EVENT, onCelebrate);

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener(CELEBRATE_EVENT, onCelebrate);
      if (rafId !== null) cancelAnimationFrame(rafId);
      particles = [];
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 80,
      }}
    />
  );
}

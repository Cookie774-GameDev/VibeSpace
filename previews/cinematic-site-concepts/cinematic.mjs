import { getConcept } from './concepts.mjs';

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function resolveJourney(scrollY, viewportHeight, pageHeight) {
  const range = Math.max(1, pageHeight - viewportHeight);
  return clamp(scrollY / range, 0, 1);
}

export function resolveScene(progress, count) {
  const safeCount = Math.max(1, count);
  if (progress >= 1) return { index: safeCount - 1, local: 1 };
  const scaled = clamp(progress, 0, 1) * safeCount;
  const index = Math.min(safeCount - 1, Math.floor(scaled));
  return { index, local: scaled - index };
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function ease(value) {
  const t = clamp(value, 0, 1);
  return 1 - (1 - t) ** 3;
}

function lerp(from, to, progress) {
  return from + (to - from) * progress;
}

function seeded(index) {
  const x = Math.sin(index * 91.733 + 18.21) * 43758.5453;
  return x - Math.floor(x);
}

function clear(ctx, width, height, from, to) {
  const gradient = ctx.createRadialGradient(width * 0.56, height * 0.42, 0, width * 0.5, height * 0.52, width * 0.86);
  gradient.addColorStop(0, to);
  gradient.addColorStop(1, from);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function line(ctx, x1, y1, x2, y2, color, width = 1) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function renderAperture(ctx, width, height, progress, time, concept) {
  clear(ctx, width, height, concept.palette[0], concept.palette[1]);
  const cx = width * lerp(0.68, 0.47, progress);
  const cy = height * 0.48;
  const pulse = 1 + Math.sin(time * 0.00045) * 0.012;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(pulse, pulse);
  for (let i = 12; i >= 0; i -= 1) {
    const depth = i / 12;
    const travel = ease(clamp(progress * 1.3 - depth * 0.32, 0, 1));
    const size = lerp(45, Math.max(width, height) * 1.02, travel) * (1 + depth * 0.08);
    const aspect = 1.32;
    ctx.save();
    ctx.rotate((depth - 0.5) * 0.11 + progress * 0.04);
    roundedRect(ctx, -size * aspect / 2, -size / 2, size * aspect, size, Math.max(5, size * 0.025));
    ctx.strokeStyle = i % 3 === 0 ? rgba(concept.palette[3], 0.62 - depth * 0.22) : rgba(concept.palette[2], 0.12);
    ctx.lineWidth = i % 3 === 0 ? 1.5 : 0.75;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  const horizon = height * 0.77;
  for (let i = 0; i < 14; i += 1) {
    const offset = (i - 7) * width * 0.065;
    line(ctx, cx, horizon, cx + offset * 2.8, height, rgba(concept.palette[3], 0.08), 1);
  }
  line(ctx, 0, horizon, width, horizon, rgba(concept.palette[3], 0.28), 1);

  const panelAlpha = ease(clamp((progress - 0.28) * 2.2, 0, 1));
  for (let i = 0; i < 5; i += 1) {
    const x = width * (0.54 + i * 0.07) - progress * width * 0.2;
    const y = height * (0.24 + (i % 2) * 0.11);
    ctx.fillStyle = rgba(concept.palette[2], 0.025 * panelAlpha);
    ctx.strokeStyle = rgba(i === 2 ? concept.palette[4] : concept.palette[2], 0.18 * panelAlpha);
    roundedRect(ctx, x, y, width * 0.16, height * 0.13, 6);
    ctx.fill();
    ctx.stroke();
  }
}

function renderDesk(ctx, width, height, progress, time, concept) {
  clear(ctx, width, height, concept.palette[0], concept.palette[1]);
  const horizon = height * 0.37;
  const drift = (progress * 0.6 + time * 0.000006) % 1;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(width, horizon);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const desk = ctx.createLinearGradient(0, horizon, 0, height);
  desk.addColorStop(0, rgba(concept.palette[1], 0.25));
  desk.addColorStop(1, concept.palette[0]);
  ctx.fillStyle = desk;
  ctx.fill();
  ctx.restore();

  for (let i = -12; i <= 12; i += 1) {
    const x = width * (0.5 + i * 0.08 - drift * 0.08);
    line(ctx, width * 0.5, horizon, x, height, rgba(concept.palette[2], 0.075), 1);
  }
  for (let i = 0; i < 16; i += 1) {
    const t = i / 15;
    const y = horizon + (t ** 2) * (height - horizon);
    line(ctx, 0, y, width, y, rgba(concept.palette[2], 0.065 * t), 1);
  }

  const instruments = [
    { x: 0.2, y: 0.56, w: 0.14, h: 0.18, c: concept.palette[4] },
    { x: 0.47, y: 0.46, w: 0.21, h: 0.24, c: concept.palette[3] },
    { x: 0.74, y: 0.59, w: 0.16, h: 0.13, c: concept.palette[2] },
  ];
  instruments.forEach((item, index) => {
    const reveal = ease(clamp(progress * 2.3 - index * 0.18, 0, 1));
    const x = width * (item.x - progress * 0.08 + index * progress * 0.035);
    const y = height * item.y - reveal * 24;
    const w = width * item.w;
    const h = height * item.h;
    ctx.shadowBlur = 30;
    ctx.shadowColor = rgba(item.c, 0.18);
    roundedRect(ctx, x - w / 2, y - h / 2, w, h, index === 1 ? 8 : 3);
    ctx.fillStyle = rgba(concept.palette[1], 0.72);
    ctx.fill();
    ctx.strokeStyle = rgba(item.c, 0.42 * reveal);
    ctx.stroke();
    ctx.shadowBlur = 0;
    for (let row = 0; row < 4; row += 1) {
      line(ctx, x - w * 0.35, y - h * 0.25 + row * h * 0.15, x + w * (0.05 + seeded(row + index) * 0.3), y - h * 0.25 + row * h * 0.15, rgba(item.c, 0.3), 1);
    }
  });

  const lampX = width * (0.65 + Math.sin(time * 0.0002) * 0.01);
  const glow = ctx.createRadialGradient(lampX, height * 0.2, 0, lampX, height * 0.2, height * 0.48);
  glow.addColorStop(0, rgba(concept.palette[3], 0.16));
  glow.addColorStop(1, rgba(concept.palette[3], 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

function renderCosmos(ctx, width, height, progress, time, concept) {
  clear(ctx, width, height, concept.palette[0], concept.palette[1]);
  const cx = width * lerp(0.62, 0.48, progress);
  const cy = height * lerp(0.48, 0.52, progress);
  const zoom = lerp(0.72, 2.4, ease(progress));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(zoom, zoom);
  ctx.rotate(progress * 0.18 + time * 0.000012);
  const points = [];
  for (let i = 0; i < 72; i += 1) {
    const angle = seeded(i) * Math.PI * 2;
    const radius = (0.12 + seeded(i + 80) * 0.72) * Math.min(width, height);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * 0.62;
    points.push({ x, y, size: 0.6 + seeded(i + 160) * 2.2 });
  }
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (i % 4 === 0) {
      const next = points[(i * 7 + 11) % points.length];
      line(ctx, point.x, point.y, next.x, next.y, rgba(concept.palette[3], 0.07), 0.5);
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, point.size / zoom, 0, Math.PI * 2);
    ctx.fillStyle = rgba(i % 9 === 0 ? concept.palette[4] : concept.palette[2], 0.35 + seeded(i + 220) * 0.5);
    ctx.fill();
  }
  for (let ring = 0; ring < 5; ring += 1) {
    ctx.beginPath();
    ctx.ellipse(0, 0, width * (0.09 + ring * 0.07), height * (0.05 + ring * 0.043), ring * 0.11, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(ring === 2 ? concept.palette[4] : concept.palette[3], 0.13);
    ctx.lineWidth = 0.7 / zoom;
    ctx.stroke();
  }
  ctx.restore();

  const dive = ease(clamp((progress - 0.48) * 2, 0, 1));
  const size = lerp(10, Math.max(width, height) * 0.72, dive);
  ctx.shadowBlur = 34;
  ctx.shadowColor = rgba(concept.palette[3], 0.3);
  ctx.strokeStyle = rgba(concept.palette[3], 0.65 * dive);
  roundedRect(ctx, cx - size * 0.7, cy - size * 0.45, size * 1.4, size * 0.9, size * 0.06);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function renderFoundry(ctx, width, height, progress, time, concept) {
  clear(ctx, width, height, concept.palette[0], concept.palette[1]);
  const floorY = height * 0.72;
  const travel = progress * width * 0.48;

  for (let rail = 0; rail < 4; rail += 1) {
    const y = floorY + rail * 18;
    line(ctx, 0, y, width, y, rgba(concept.palette[2], 0.11), rail === 0 ? 2 : 1);
  }
  for (let i = -2; i < 18; i += 1) {
    const x = ((i * width * 0.09 - travel) % (width * 1.2)) - width * 0.1;
    line(ctx, x, floorY - 10, x + 32, floorY + 74, rgba(concept.palette[3], 0.16), 2);
  }

  const cores = [
    { base: 0.18, lift: 0.5, size: 34 },
    { base: 0.46, lift: 0.35, size: 48 },
    { base: 0.72, lift: 0.58, size: 39 },
    { base: 0.9, lift: 0.42, size: 28 },
  ];
  cores.forEach((core, index) => {
    const x = width * core.base - travel * (0.22 + index * 0.03);
    const y = floorY - height * core.lift + Math.sin(time * 0.001 + index) * 4;
    const active = ease(clamp(progress * 3 - index * 0.25, 0, 1));
    ctx.shadowBlur = 34;
    ctx.shadowColor = rgba(index === 1 ? concept.palette[4] : concept.palette[3], 0.42);
    ctx.beginPath();
    ctx.arc(x, y, core.size * (0.68 + active * 0.32), 0, Math.PI * 2);
    ctx.fillStyle = rgba(concept.palette[0], 0.84);
    ctx.fill();
    ctx.strokeStyle = rgba(index === 1 ? concept.palette[4] : concept.palette[3], 0.82);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    line(ctx, x, y + core.size, x, floorY, rgba(concept.palette[2], 0.15), 1);
  });

  const gateX = width * lerp(0.78, 0.52, progress);
  ctx.strokeStyle = rgba(concept.palette[3], 0.52);
  ctx.lineWidth = 2;
  ctx.strokeRect(gateX, height * 0.19, width * 0.17, height * 0.49);
  ctx.strokeStyle = rgba(concept.palette[4], 0.16);
  ctx.strokeRect(gateX + 12, height * 0.19 + 12, width * 0.17 - 24, height * 0.49 - 24);
  for (let i = 0; i < 6; i += 1) {
    line(ctx, gateX, height * (0.22 + i * 0.075), gateX + width * 0.17, height * (0.22 + i * 0.075), rgba(concept.palette[3], 0.12), 1);
  }
}

function branch(ctx, x, y, length, angle, depth, sway, concept, progress) {
  if (depth <= 0 || length < 3) return;
  const endX = x + Math.cos(angle + sway) * length;
  const endY = y + Math.sin(angle + sway) * length;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(
    lerp(x, endX, 0.55) + Math.sin(depth) * length * 0.12,
    lerp(y, endY, 0.55),
    endX,
    endY,
  );
  ctx.strokeStyle = rgba(depth % 3 === 0 ? concept.palette[4] : concept.palette[3], 0.08 + depth * 0.035);
  ctx.lineWidth = Math.max(0.45, depth * 0.62);
  ctx.stroke();
  if (depth < 4) {
    ctx.beginPath();
    ctx.arc(endX, endY, Math.max(1.2, depth * 0.72), 0, Math.PI * 2);
    ctx.fillStyle = rgba(depth % 2 ? concept.palette[3] : concept.palette[4], 0.28 + progress * 0.28);
    ctx.fill();
  }
  branch(ctx, endX, endY, length * 0.73, angle - 0.48, depth - 1, sway * 0.78, concept, progress);
  branch(ctx, endX, endY, length * 0.71, angle + 0.42, depth - 1, sway * 0.82, concept, progress);
}

function renderArchive(ctx, width, height, progress, time, concept) {
  clear(ctx, width, height, concept.palette[0], concept.palette[1]);
  const sway = Math.sin(time * 0.00032) * 0.035;
  const growth = ease(clamp(progress * 1.22 + 0.12, 0, 1));
  ctx.save();
  ctx.translate(width * lerp(0.66, 0.52, progress), height * 0.91);
  ctx.scale(0.58 + growth * 0.62, 0.58 + growth * 0.62);
  ctx.shadowBlur = 16;
  ctx.shadowColor = rgba(concept.palette[3], 0.22);
  branch(ctx, 0, 0, height * 0.19, -Math.PI / 2, 8, sway, concept, progress);
  branch(ctx, -width * 0.1, 0, height * 0.14, -Math.PI / 2.3, 7, -sway, concept, progress);
  branch(ctx, width * 0.12, 0, height * 0.13, -Math.PI / 1.8, 7, sway * 1.2, concept, progress);
  ctx.restore();
  ctx.shadowBlur = 0;

  const ground = ctx.createLinearGradient(0, height * 0.78, 0, height);
  ground.addColorStop(0, rgba(concept.palette[3], 0));
  ground.addColorStop(1, rgba(concept.palette[3], 0.1));
  ctx.fillStyle = ground;
  ctx.fillRect(0, height * 0.7, width, height * 0.3);

  for (let i = 0; i < 18; i += 1) {
    const x = seeded(i + 400) * width;
    const y = height * (0.22 + seeded(i + 500) * 0.6);
    const radius = 1 + seeded(i + 600) * 2.5;
    ctx.beginPath();
    ctx.arc(x, y + Math.sin(time * 0.0004 + i) * 8, radius, 0, Math.PI * 2);
    ctx.fillStyle = rgba(i % 4 ? concept.palette[3] : concept.palette[4], 0.18 + seeded(i) * 0.38);
    ctx.fill();
  }
}

const RENDERERS = {
  aperture: renderAperture,
  desk: renderDesk,
  cosmos: renderCosmos,
  foundry: renderFoundry,
  archive: renderArchive,
};

function mountCinematicWorld() {
  const concept = getConcept(document.body.dataset.concept);
  const canvas = document.querySelector('#world-canvas');
  const ctx = canvas?.getContext('2d');
  const copies = [...document.querySelectorAll('.journey-copy')];
  const rails = [...document.querySelectorAll('.scene-rail span')];
  const root = document.documentElement;
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!canvas || !ctx || copies.length !== 3) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let progress = 0;
  let scene = { index: 0, local: 0 };
  let animationFrame = 0;
  let visible = !document.hidden;

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    schedule();
  }

  function updateJourney() {
    progress = reduceQuery.matches
      ? 0.5
      : resolveJourney(window.scrollY, window.innerHeight, document.documentElement.scrollHeight);
    scene = resolveScene(progress, copies.length);
    root.style.setProperty('--progress', progress.toFixed(5));
    root.style.setProperty('--local-progress', scene.local.toFixed(5));
    document.body.dataset.scene = String(scene.index);
    copies.forEach((copy, index) => copy.classList.toggle('is-active', index === scene.index));
    rails.forEach((rail, index) => rail.classList.toggle('is-active', index === scene.index));
  }

  function draw(time = 0) {
    animationFrame = 0;
    updateJourney();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    RENDERERS[concept.id](ctx, width, height, progress, time, concept);
    if (visible && !reduceQuery.matches) animationFrame = requestAnimationFrame(draw);
  }

  function schedule() {
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) schedule();
  });
  reduceQuery.addEventListener?.('change', schedule);
  resize();
}

if (typeof document !== 'undefined') {
  mountCinematicWorld();
}

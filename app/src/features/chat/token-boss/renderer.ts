import type { TokenBossProvider } from './providers';

export const TOKEN_BOSS_WIDTH = 960;
export const TOKEN_BOSS_HEIGHT = 460;
export const TOKEN_BOSS_DURATION_MS = 4_720;
export const TOKEN_BOSS_IMPACT_MS = 2_600;
export const TOKEN_BOSS_HIT_STOP_MS = 78;
export const TOKEN_BOSS_HAMMER_HEAD_DISTANCE = 240;
export const TOKEN_BOSS_USAGE_DRAIN_END_MS = 4_480;
export const TOKEN_BOSS_REFERENCE_SEED = 9_042_026;
export const TOKEN_BOSS_SPARK_COUNT = 34;

const TOKEN_X = TOKEN_BOSS_WIDTH * 0.425;
const TOKEN_Y = TOKEN_BOSS_HEIGHT * 0.708;
const TOKEN_SCALE = 1.12;
const TAU = Math.PI * 2;

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const smooth = (from: number, to: number, value: number) => {
  const amount = clamp((value - from) / (to - from));
  return amount * amount * (3 - 2 * amount);
};
const easeOut = (value: number) => 1 - Math.pow(1 - clamp(value), 3);
const easeIn = (value: number) => Math.pow(clamp(value), 3);
const easeInOut = (value: number) => {
  const amount = clamp(value);
  return amount < 0.5 ? 16 * amount ** 5 : 1 - Math.pow(-2 * amount + 2, 5) / 2;
};

function seededRandom(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const referenceRandom = seededRandom(TOKEN_BOSS_REFERENCE_SEED);
const referenceSparks = Array.from({ length: TOKEN_BOSS_SPARK_COUNT }, (_, index) => ({
  angle: mix(-3.04, -0.3, referenceRandom()),
  speed: mix(105, 330, referenceRandom() ** 0.55),
  length: mix(5, 17, referenceRandom()),
  width: mix(1.2, 3.2, referenceRandom()),
  spin: mix(-5, 5, referenceRandom()),
  delay: mix(0, 0.095, referenceRandom()),
  color: index % 7 === 0 ? 'provider' : index % 3 === 0 ? 'secondary' : '#ff884c',
}));
const referenceDust = Array.from({ length: 24 }, (_, index) => ({
  x: mix(-84, 90, referenceRandom()),
  vx: mix(-44, 42, referenceRandom()),
  vy: mix(-76, -20, referenceRandom()),
  size: mix(4, 13, referenceRandom()),
  delay: mix(0.03, 0.19, referenceRandom()),
  alpha: mix(0.12, 0.36, referenceRandom()),
  color: index % 4 === 0 ? '#a96b49' : '#49372e',
}));
const referenceMotes = Array.from({ length: 18 }, () => ({
  x: referenceRandom() * TOKEN_BOSS_WIDTH,
  y: referenceRandom() * TOKEN_BOSS_HEIGHT,
  radius: mix(0.7, 1.8, referenceRandom()),
  phase: referenceRandom() * TAU,
  drift: mix(2.2, 7.5, referenceRandom()),
  warm: referenceRandom() > 0.25,
}));
const referenceShards = [
  {
    points: [
      [-49, -12],
      [-40, -39],
      [-9, -49],
      [-4, -13],
      [-19, 1],
    ],
    vx: -190,
    vy: -190,
    spin: -5.5,
    delay: 0,
  },
  {
    points: [
      [-9, -49],
      [18, -45],
      [9, -8],
      [-4, -13],
    ],
    vx: -58,
    vy: -250,
    spin: 4.8,
    delay: 0.008,
  },
  {
    points: [
      [18, -45],
      [41, -33],
      [50, -9],
      [13, -2],
      [9, -8],
    ],
    vx: 145,
    vy: -205,
    spin: 6.4,
    delay: 0.016,
  },
  {
    points: [
      [-49, -12],
      [-19, 1],
      [-9, 18],
      [-34, 42],
      [-49, 19],
    ],
    vx: -245,
    vy: -76,
    spin: -7.2,
    delay: 0.014,
  },
  {
    points: [
      [-19, 1],
      [-4, -13],
      [9, -8],
      [13, -2],
      [8, 16],
      [-9, 18],
    ],
    vx: 4,
    vy: -150,
    spin: 3.2,
    delay: 0.005,
  },
  {
    points: [
      [13, -2],
      [50, -9],
      [49, 20],
      [28, 39],
      [8, 16],
    ],
    vx: 230,
    vy: -72,
    spin: 7.4,
    delay: 0.018,
  },
  {
    points: [
      [-34, 42],
      [-9, 18],
      [0, 50],
      [-19, 47],
    ],
    vx: -165,
    vy: 18,
    spin: -4.7,
    delay: 0.027,
  },
  {
    points: [
      [-9, 18],
      [8, 16],
      [28, 39],
      [18, 47],
      [0, 50],
    ],
    vx: 34,
    vy: 58,
    spin: 5.6,
    delay: 0.032,
  },
  {
    points: [
      [28, 39],
      [49, 20],
      [42, 39],
      [18, 47],
    ],
    vx: 175,
    vy: 24,
    spin: 8.2,
    delay: 0.025,
  },
].map((shard) => ({
  ...shard,
  centerX: shard.points.reduce((sum, point) => sum + point[0]!, 0) / shard.points.length,
  centerY: shard.points.reduce((sum, point) => sum + point[1]!, 0) / shard.points.length,
}));

function hexRgb(hex: string) {
  const value = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgba(hex: string, alpha: number) {
  const { r, g, b } = hexRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function tokenBossUsagePercentAt(elapsedMs: number): number {
  return Math.round(100 * (1 - clamp(elapsedMs / TOKEN_BOSS_USAGE_DRAIN_END_MS)));
}

function pixelRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  provider: TokenBossProvider,
  elapsed: number,
) {
  ctx.fillStyle = '#080605';
  ctx.fillRect(0, 0, TOKEN_BOSS_WIDTH, TOKEN_BOSS_HEIGHT);

  const tokenGlow = ctx.createRadialGradient(TOKEN_X, TOKEN_Y - 20, 8, TOKEN_X, TOKEN_Y, 310);
  tokenGlow.addColorStop(0, rgba(provider.accent, 0.2));
  tokenGlow.addColorStop(0.35, rgba(provider.accent2, 0.08));
  tokenGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = tokenGlow;
  ctx.fillRect(80, 20, 680, 430);

  ctx.save();
  ctx.globalAlpha = 0.055 + Math.sin(elapsed * 2.4) * 0.006;
  const beam = ctx.createLinearGradient(250, 0, 590, TOKEN_BOSS_HEIGHT);
  beam.addColorStop(0, rgba(provider.accent2, 0.68));
  beam.addColorStop(0.48, 'rgba(255,119,63,.27)');
  beam.addColorStop(1, 'rgba(255,85,42,0)');
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(228, 0);
  ctx.lineTo(372, 0);
  ctx.lineTo(590, TOKEN_BOSS_HEIGHT);
  ctx.lineTo(415, TOKEN_BOSS_HEIGHT);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const horizon = TOKEN_BOSS_HEIGHT * 0.765;
  const floor = ctx.createLinearGradient(0, horizon, 0, TOKEN_BOSS_HEIGHT);
  floor.addColorStop(0, 'rgba(53,31,23,.28)');
  floor.addColorStop(1, 'rgba(4,3,3,.78)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizon, TOKEN_BOSS_WIDTH, TOKEN_BOSS_HEIGHT - horizon);
  ctx.strokeStyle = '#513126';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(TOKEN_BOSS_WIDTH, horizon);
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = '#8d5138';
  for (let index = -4; index <= 4; index += 1) {
    ctx.beginPath();
    ctx.moveTo(TOKEN_BOSS_WIDTH / 2 + index * 56, horizon);
    ctx.lineTo(TOKEN_BOSS_WIDTH / 2 + index * 154, TOKEN_BOSS_HEIGHT);
    ctx.stroke();
  }
  ctx.restore();

  for (const mote of referenceMotes) {
    const y = (mote.y - elapsed * mote.drift + TOKEN_BOSS_HEIGHT) % TOKEN_BOSS_HEIGHT;
    const flicker = 0.38 + 0.62 * Math.sin(elapsed * 1.7 + mote.phase) ** 2;
    ctx.globalAlpha = flicker * 0.24;
    ctx.fillStyle = mote.warm ? '#f3a16a' : provider.accent;
    ctx.fillRect(Math.round(mote.x / 2) * 2, Math.round(y / 2) * 2, mote.radius, mote.radius);
  }
  ctx.globalAlpha = 1;

  const vignette = ctx.createRadialGradient(480, 260, 80, 480, 260, 610);
  vignette.addColorStop(0.42, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,.72)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, TOKEN_BOSS_WIDTH, TOKEN_BOSS_HEIGHT);
}

function drawCodexMark(ctx: CanvasRenderingContext2D, provider: TokenBossProvider, heat: number) {
  ctx.save();
  for (let index = 0; index < 6; index += 1) {
    ctx.save();
    ctx.rotate((index * Math.PI) / 3);
    ctx.beginPath();
    ctx.moveTo(0, -23);
    ctx.lineTo(11.5, -17);
    ctx.lineTo(17.5, -6);
    ctx.lineTo(14.5, 5.5);
    ctx.lineTo(6.5, 12.5);
    ctx.lineTo(1.2, 5.8);
    ctx.lineTo(8.5, 0.8);
    ctx.lineTo(8.2, -8.5);
    ctx.lineTo(0, -13.2);
    ctx.closePath();
    ctx.fillStyle = heat ? '#ffb56f' : provider.accent;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#081113';
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawProviderMark(
  ctx: CanvasRenderingContext2D,
  provider: TokenBossProvider,
  heat: number,
) {
  if (provider.id === 'codex') {
    drawCodexMark(ctx, provider, heat);
    return;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `950 ${provider.symbol.length >= 3 ? 15 : provider.symbol.length === 2 ? 19 : 25}px ui-monospace, monospace`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#071012';
  ctx.strokeText(provider.symbol, 0, 0);
  ctx.shadowColor = heat ? '#ff8a48' : provider.accent;
  ctx.shadowBlur = heat ? 13 : 11;
  ctx.fillStyle = heat ? '#fff0c5' : provider.accent2;
  ctx.fillText(provider.symbol, 0, 0);
  ctx.shadowBlur = 0;
}

function drawProviderTokenLocal(
  ctx: CanvasRenderingContext2D,
  provider: TokenBossProvider,
  heat = 0,
) {
  ctx.save();
  ctx.shadowColor = provider.accent;
  ctx.shadowBlur = 24;
  ctx.fillStyle = rgba(provider.accent, 0.25);
  ctx.beginPath();
  ctx.arc(0, 0, 52, 0, TAU);
  ctx.fill();
  ctx.restore();

  for (let layer = 9; layer >= 1; layer -= 1) {
    ctx.save();
    ctx.translate(0, layer * 0.72);
    const edge = ctx.createLinearGradient(-48, -25, 48, 30);
    edge.addColorStop(0, '#151d1f');
    edge.addColorStop(0.35, '#76543d');
    edge.addColorStop(0.72, '#293334');
    edge.addColorStop(1, '#131a1c');
    ctx.fillStyle = edge;
    ctx.beginPath();
    ctx.arc(0, 0, 51, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  const rim = ctx.createRadialGradient(-18, -19, 3, 0, 0, 56);
  rim.addColorStop(0, provider.accent2);
  rim.addColorStop(0.22, '#d5c199');
  rim.addColorStop(0.7, '#394344');
  rim.addColorStop(1, '#141c1e');
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(0, 0, 51, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#d4aa70';
  ctx.lineWidth = 2;
  ctx.stroke();

  const face = ctx.createRadialGradient(-12, -13, 1, 0, 0, 42);
  face.addColorStop(0, heat ? '#4a3025' : '#243336');
  face.addColorStop(0.48, heat ? '#2d201b' : '#132023');
  face.addColorStop(1, '#070d0f');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(0, 0, 39, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = heat ? '#ff9b59' : provider.accent;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  for (let index = 0; index < 6; index += 1) {
    const angle = (index * Math.PI) / 3 + Math.PI / 6;
    ctx.fillStyle = '#b89968';
    ctx.fillRect(Math.cos(angle) * 33 - 1, Math.sin(angle) * 33 - 1, 2, 2);
  }

  ctx.save();
  ctx.translate(0, -2);
  drawProviderMark(ctx, provider, heat);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 7px ui-monospace, monospace';
  ctx.fillStyle = '#d7b47d';
  ctx.fillText(provider.name.toUpperCase(), 0, 29);
  ctx.font = '600 4.6px ui-monospace, monospace';
  ctx.fillStyle = '#718083';
  ctx.fillText(`${provider.code}-01 // TOKEN`, 0, -31);
}

function drawToken(ctx: CanvasRenderingContext2D, provider: TokenBossProvider, elapsed: number) {
  const reveal = easeOut((elapsed - 0.16) / 0.64);
  if (reveal <= 0) return;
  const post = elapsed - TOKEN_BOSS_IMPACT_MS / 1000;

  ctx.save();
  ctx.globalAlpha = reveal * (post > 0 ? 1 - smooth(0.08, 0.82, post) : 0.55);
  const shadow = ctx.createRadialGradient(TOKEN_X, TOKEN_Y + 60, 2, TOKEN_X, TOKEN_Y + 60, 76);
  shadow.addColorStop(0, 'rgba(0,0,0,.72)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(TOKEN_X, TOKEN_Y + 60, 78, 15, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  if (post <= 0.078) {
    const lock = smooth(2.18, 2.56, elapsed);
    const float = Math.sin(elapsed * 4.8) * 4.2 * (1 - lock);
    const rotation = Math.sin(elapsed * 1.35) * 0.032 * (1 - lock);
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 6.1);
    const heat = post > 0 ? smooth(0, 0.03, post) : 0;
    ctx.save();
    ctx.translate(TOKEN_X, TOKEN_Y + float + heat * 5);
    ctx.rotate(rotation);
    ctx.scale(
      TOKEN_SCALE * (1 + pulse * 0.012) * (1 + heat * 0.13),
      TOKEN_SCALE * 0.94 * (1 - heat * 0.22),
    );
    drawProviderTokenLocal(ctx, provider, heat);
    ctx.restore();
    if (post <= 0) {
      ctx.save();
      ctx.translate(TOKEN_X, TOKEN_Y + float);
      ctx.globalAlpha = (0.15 + 0.035 * Math.sin(elapsed * 5)) * reveal;
      ctx.strokeStyle = provider.accent;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(0, 2, 68, 18, -0.04, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.56 * reveal;
      for (let index = 0; index < 6; index += 1) {
        const angle = elapsed * 0.52 + (index * Math.PI) / 3;
        ctx.fillStyle = index % 2 ? provider.accent : provider.accent2;
        ctx.fillRect(
          Math.round((Math.cos(angle) * 67 - 1) / 2) * 2,
          Math.round((Math.sin(angle) * 18 + 1) / 2) * 2,
          3,
          3,
        );
      }
      ctx.restore();
    }
    if (elapsed > 2.49) {
      ctx.save();
      ctx.translate(TOKEN_X, TOKEN_Y);
      ctx.strokeStyle = '#fff0c9';
      ctx.shadowColor = '#fff0c2';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.7;
      for (const points of [
        [
          [12, -10],
          [3, -3],
          [-4, 9],
          [-25, 31],
        ],
        [
          [12, -10],
          [20, -2],
          [39, 14],
        ],
        [
          [12, -10],
          [10, -22],
          [16, -43],
        ],
      ]) {
        ctx.beginPath();
        points.forEach(([x, y], index) => (index ? ctx.lineTo(x!, y!) : ctx.moveTo(x!, y!)));
        ctx.stroke();
      }
      ctx.restore();
    }
    return;
  }

  const shardTime = post - 0.078;
  const fade = 1 - smooth(1.12, 1.62, shardTime);
  for (const shard of referenceShards) {
    const time = shardTime - shard.delay;
    if (time < 0 || fade <= 0) continue;
    const x = TOKEN_X + shard.centerX * TOKEN_SCALE + shard.vx * time;
    const y = TOKEN_Y + shard.centerY * TOKEN_SCALE * 0.94 + shard.vy * time + 245 * time * time;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(shard.spin * time);
    ctx.globalAlpha = fade;
    ctx.scale(TOKEN_SCALE, TOKEN_SCALE * 0.94);
    ctx.translate(-shard.centerX, -shard.centerY);
    ctx.beginPath();
    shard.points.forEach(([pointX, pointY], index) =>
      index ? ctx.lineTo(pointX!, pointY!) : ctx.moveTo(pointX!, pointY!),
    );
    ctx.closePath();
    ctx.clip();
    drawProviderTokenLocal(ctx, provider, Math.max(0, 1 - time * 5));
    ctx.restore();
  }
}

function drawHammer(
  ctx: CanvasRenderingContext2D,
  pivotX: number,
  pivotY: number,
  angle: number,
  alpha: number,
  trail = false,
) {
  ctx.save();
  ctx.translate(pivotX, pivotY);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;
  if (trail) {
    ctx.globalCompositeOperation = 'screen';
    ctx.shadowColor = '#ff7b43';
    ctx.shadowBlur = 14;
  }
  const handle = ctx.createLinearGradient(-7, 0, 8, 0);
  handle.addColorStop(0, '#3a2119');
  handle.addColorStop(0.4, '#9b5d3b');
  handle.addColorStop(0.62, '#d1945f');
  handle.addColorStop(1, '#321d17');
  ctx.fillStyle = handle;
  ctx.fillRect(-7, 4, 14, 215);
  ctx.fillStyle = '#151718';
  ctx.fillRect(-47, 196, 94, 51);
  ctx.fillStyle = '#6e3e2c';
  ctx.fillRect(-54, 204, 108, 34);
  ctx.fillStyle = '#d47a49';
  ctx.fillRect(-48, 208, 96, 7);
  ctx.fillStyle = '#2b1c18';
  ctx.fillRect(-40, 239, 80, 12);
  ctx.restore();
}

function hammerAngle(elapsed: number, impactAngle: number) {
  const rest = -0.34;
  const windup = -3.68;
  if (elapsed < 1.03) return rest;
  if (elapsed < 2.08) return mix(rest, windup, easeInOut((elapsed - 1.03) / 1.05));
  if (elapsed < 2.6) return mix(windup, impactAngle, easeIn((elapsed - 2.08) / 0.52));
  if (elapsed < 2.678) return impactAngle;
  if (elapsed < 3.08)
    return mix(impactAngle, impactAngle + 0.34, easeOut((elapsed - 2.678) / 0.402));
  return impactAngle + 0.34;
}

function drawBoss(ctx: CanvasRenderingContext2D, provider: TokenBossProvider, elapsed: number) {
  const visible = smooth(0.5, 1.04, elapsed);
  if (visible <= 0) return;
  const x = mix(TOKEN_BOSS_WIDTH + 150, TOKEN_BOSS_WIDTH * 0.715, easeOut((elapsed - 0.58) / 0.78));
  const y = TOKEN_BOSS_HEIGHT * 0.855;
  const pivotX = x - 54;
  const pivotY = y - 146;
  const dx = TOKEN_X - pivotX;
  const dy = TOKEN_Y + 1 - pivotY;
  const impactAngle = Math.atan2(-dx, dy) - TAU;
  const angle = hammerAngle(elapsed, impactAngle);

  if (elapsed > 2.18 && elapsed < 2.635) {
    for (let index = 4; index >= 1; index -= 1) {
      drawHammer(
        ctx,
        pivotX,
        pivotY,
        hammerAngle(Math.max(0, elapsed - index * 0.03), impactAngle),
        visible * (5 - index) * 0.025,
        true,
      );
    }
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = visible;
  pixelRect(ctx, -104, -178, 53, 74, '#3b251e');
  pixelRect(ctx, 57, -178, 53, 74, '#44291f');
  pixelRect(ctx, -112, -162, 18, 44, '#7b3d2a');
  pixelRect(ctx, 94, -162, 18, 44, '#7b3d2a');
  pixelRect(ctx, -52, -86, 38, 63, '#4e2d23');
  pixelRect(ctx, 18, -86, 38, 63, '#452a21');
  pixelRect(ctx, -61, -19, 58, 16, '#6e3f2d');
  pixelRect(ctx, 9, -19, 58, 16, '#6e3f2d');
  pixelRect(ctx, -77, -179, 154, 106, '#643625');
  pixelRect(ctx, -69, -171, 138, 89, '#201817');
  pixelRect(ctx, -63, -166, 126, 28, '#8e4930');
  pixelRect(ctx, -57, -132, 114, 43, '#32211c');
  pixelRect(ctx, -75, -107, 150, 18, '#171211');
  pixelRect(ctx, -65, -105, 130, 9, '#a75837');
  ctx.shadowColor = provider.accent;
  ctx.shadowBlur = 16;
  pixelRect(ctx, -19, -145, 38, 38, provider.accent);
  ctx.shadowBlur = 0;
  pixelRect(ctx, -15, -141, 30, 30, '#0c1416');
  pixelRect(ctx, -72, -306, 22, 29, '#583126');
  pixelRect(ctx, 50, -306, 22, 29, '#583126');
  pixelRect(ctx, -86, -296, 172, 102, '#713d2b');
  pixelRect(ctx, -78, -289, 156, 88, '#241a17');
  pixelRect(ctx, -69, -279, 138, 67, '#070a0b');
  pixelRect(ctx, -61, -271, 122, 51, '#0e1517');
  ctx.shadowColor = '#70e8f3';
  ctx.shadowBlur = 16;
  pixelRect(ctx, -45, -252, 34, 7, '#75e4ea');
  pixelRect(ctx, 11, -252, 34, 7, '#75e4ea');
  ctx.shadowBlur = 0;
  pixelRect(ctx, -39, -250, 23, 3, '#efffff');
  pixelRect(ctx, 16, -250, 23, 3, '#efffff');
  pixelRect(ctx, -31, -227, 62, 4, '#ea834e');
  pixelRect(ctx, -89, -167, 33, 70, '#743c2b');
  pixelRect(ctx, 59, -166, 32, 69, '#693728');
  ctx.restore();

  drawHammer(ctx, pivotX, pivotY, angle, visible);
}

function drawImpact(ctx: CanvasRenderingContext2D, provider: TokenBossProvider, post: number) {
  if (post < 0) return;
  const motionPost = Math.max(0, post - (TOKEN_BOSS_HIT_STOP_MS / 1000) * 0.45);
  const ringProgress = easeOut(motionPost / 0.52);
  const ringFade = 1 - smooth(0.32, 0.82, motionPost);
  ctx.save();
  ctx.translate(TOKEN_X, TOKEN_Y + 5);
  ctx.globalAlpha = ringFade * 0.82;
  ctx.strokeStyle = '#ff9a5f';
  ctx.lineWidth = mix(5, 1, ringProgress);
  ctx.beginPath();
  ctx.ellipse(0, 16, 20 + ringProgress * 190, 6 + ringProgress * 41, 0, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = ringFade * 0.34;
  ctx.strokeStyle = provider.accent;
  ctx.beginPath();
  ctx.ellipse(0, 16, 12 + ringProgress * 132, 4 + ringProgress * 27, 0, 0, TAU);
  ctx.stroke();

  for (const spark of referenceSparks) {
    const time = motionPost - spark.delay;
    if (time <= 0 || time > 1.05) continue;
    const x = Math.cos(spark.angle) * spark.speed * time;
    const y = Math.sin(spark.angle) * spark.speed * time + 230 * time * time;
    const color =
      spark.color === 'provider'
        ? provider.accent
        : spark.color === 'secondary'
          ? provider.accent2
          : spark.color;
    ctx.save();
    ctx.translate(Math.round(x / 2) * 2, Math.round(y / 2) * 2);
    ctx.rotate(spark.angle + spark.spin * time);
    ctx.globalAlpha = 1 - smooth(0.46, 1.05, time);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    ctx.fillRect(-spark.length * 0.5, -spark.width * 0.5, spark.length, spark.width);
    ctx.restore();
  }

  for (const particle of referenceDust) {
    const time = motionPost - particle.delay;
    if (time <= 0 || time > 1.35) continue;
    ctx.globalAlpha = (1 - smooth(0.48, 1.35, time)) * particle.alpha;
    ctx.fillStyle = particle.color;
    ctx.fillRect(
      Math.round((particle.x + particle.vx * time) / 2) * 2,
      Math.round((19 + particle.vy * time + 28 * time * time) / 2) * 2,
      particle.size * (1 + time * 0.7),
      particle.size * 0.48,
    );
  }

  if (post < 0.24) {
    const core = 1 - post / 0.24;
    const glow = ctx.createRadialGradient(0, -2, 2, 0, -2, 100 * (1 - core * 0.14));
    glow.addColorStop(0, `rgba(255,255,225,${core})`);
    glow.addColorStop(0.18, `rgba(255,190,98,${core * 0.86})`);
    glow.addColorStop(0.53, `rgba(255,78,40,${core * 0.43})`);
    glow.addColorStop(1, 'rgba(255,63,28,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = glow;
    ctx.fillRect(-116, -118, 232, 232);
  }
  ctx.restore();
}

function drawHud(ctx: CanvasRenderingContext2D, provider: TokenBossProvider, elapsedMs: number) {
  const elapsed = elapsedMs / 1000;
  const usage = tokenBossUsagePercentAt(elapsedMs);
  ctx.save();
  ctx.fillStyle = 'rgba(7,9,10,.7)';
  ctx.strokeStyle = rgba(provider.accent, 0.34);
  ctx.lineWidth = 1;
  ctx.fillRect(44, TOKEN_BOSS_HEIGHT - 89, 292, 55);
  ctx.strokeRect(44.5, TOKEN_BOSS_HEIGHT - 88.5, 291, 54);
  ctx.fillStyle = '#b99c84';
  ctx.font = '700 8.5px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${provider.name.toUpperCase()}  //  WEEKLY USAGE`, 56, TOKEN_BOSS_HEIGHT - 74);
  ctx.fillStyle = '#14191a';
  ctx.fillRect(56, TOKEN_BOSS_HEIGHT - 58, 268, 8);
  const bar = ctx.createLinearGradient(56, 0, 324, 0);
  bar.addColorStop(0, provider.accent2);
  bar.addColorStop(0.64, provider.accent);
  bar.addColorStop(1, '#ff7443');
  ctx.fillStyle = bar;
  ctx.fillRect(56, TOKEN_BOSS_HEIGHT - 58, 268 * (usage / 100), 8);
  ctx.fillStyle = usage === 0 ? '#ff9162' : provider.accent2;
  ctx.textAlign = 'right';
  ctx.font = '900 14px ui-monospace, monospace';
  ctx.fillText(`${String(usage).padStart(3, '0')}%`, 324, TOKEN_BOSS_HEIGHT - 73);
  ctx.textAlign = 'left';
  ctx.fillStyle = usage === 0 ? '#ff8b5a' : '#887466';
  ctx.font = '650 7.5px ui-monospace, monospace';
  ctx.fillText(
    usage === 0 ? 'STATUS  //  DEPLETED' : `DRAINING  //  ${100 - usage}% COMPLETE`,
    56,
    TOKEN_BOSS_HEIGHT - 42,
  );

  const post = Math.max(0, elapsed - TOKEN_BOSS_IMPACT_MS / 1000);
  if (post < 0.82) {
    ctx.globalAlpha = 1 - smooth(0.54, 0.82, post);
    ctx.fillStyle = '#d7aa84';
    ctx.font = '700 12.5px ui-monospace, monospace';
    ctx.fillText(`VIBESPACE  //  ${provider.name.toUpperCase()} TOKEN`, 44, 48);
    ctx.fillStyle = provider.accent;
    ctx.font = '600 8px ui-monospace, monospace';
    ctx.fillText('FINAL BOSS  //  WEEKLY LIMIT EXECUTION', 44, 67);
  } else {
    ctx.globalAlpha = 1 - smooth(1.85, 2.08, post);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe2bd';
    ctx.font = `900 ${provider.name.length > 10 ? 24 : 31}px ui-monospace, monospace`;
    ctx.fillText(`${provider.name.toUpperCase()} TOKEN SMASHED`, TOKEN_BOSS_WIDTH / 2, 105);
    ctx.fillStyle = provider.accent;
    ctx.font = '700 9px ui-monospace, monospace';
    ctx.fillText(
      `WEEKLY USAGE ${String(usage).padStart(3, '0')}%  //  DIRECT HAMMER IMPACT CONFIRMED`,
      TOKEN_BOSS_WIDTH / 2,
      132,
    );
  }
  ctx.restore();
}

export function renderTokenBossFrame(
  ctx: CanvasRenderingContext2D,
  provider: TokenBossProvider,
  elapsedMs: number,
) {
  const elapsed = clamp(elapsedMs, 0, TOKEN_BOSS_DURATION_MS) / 1000;
  ctx.clearRect(0, 0, TOKEN_BOSS_WIDTH, TOKEN_BOSS_HEIGHT);
  const alpha = Math.min(smooth(0, 0.24, elapsed), 1 - smooth(4.24, 4.72, elapsed));
  const post = elapsed - TOKEN_BOSS_IMPACT_MS / 1000;
  const shake = post >= 0 && post < 0.56 ? Math.pow(1 - post / 0.56, 1.5) : 0;
  const impactPulse = post >= 0 ? Math.exp(-post * 8.4) : 0;
  const zoom =
    1 +
    smooth(0.82, 2.48, elapsed) * 0.048 -
    smooth(3.3, 4.2, elapsed) * 0.014 +
    impactPulse * 0.052;
  const panX = -smooth(1.1, 2.45, elapsed) * 10 + smooth(3.15, 4.1, elapsed) * 7;
  const panY = smooth(1.4, 2.45, elapsed) * 3;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(
    Math.sin(post * 101) * 10 * shake + Math.sin(post * 43) * 3.5 * shake + panX,
    Math.cos(post * 121) * 6.4 * shake + panY,
  );
  ctx.translate(TOKEN_BOSS_WIDTH / 2, TOKEN_BOSS_HEIGHT / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-TOKEN_BOSS_WIDTH / 2, -TOKEN_BOSS_HEIGHT / 2);
  drawBackground(ctx, provider, elapsed);
  drawToken(ctx, provider, elapsed);
  drawBoss(ctx, provider, elapsed);
  drawImpact(ctx, provider, post);
  drawHud(ctx, provider, elapsedMs);
  ctx.restore();

  ctx.fillStyle = '#020202';
  const letterbox = 27 * smooth(0, 0.34, elapsed);
  ctx.globalAlpha = alpha * 0.97;
  ctx.fillRect(0, 0, TOKEN_BOSS_WIDTH, letterbox);
  ctx.fillRect(0, TOKEN_BOSS_HEIGHT - letterbox, TOKEN_BOSS_WIDTH, letterbox);
  ctx.globalAlpha = 1;
  if (post >= 0 && post < 0.145) {
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = `rgba(255,232,199,${(1 - post / 0.145) * 0.56})`;
    ctx.fillRect(0, 0, TOKEN_BOSS_WIDTH, TOKEN_BOSS_HEIGHT);
    ctx.globalCompositeOperation = 'source-over';
  }
}

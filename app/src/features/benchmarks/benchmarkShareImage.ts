export interface BenchmarkShareRow {
  model: string;
  provider: string;
  score: string;
  inputPrice: string;
  outputPrice: string;
  context: string;
  logoSrc?: string;
}

export interface BenchmarkShareImageOptions {
  category: 'Overall' | 'Speed' | 'Cost';
  unit: string;
  direction: 'higher' | 'lower';
  sourceObservedAt: string;
  sourceUrl: string;
  rows: readonly BenchmarkShareRow[];
}

const WIDTH = 1600;
const HEIGHT = 1640;
const ROWS_PER_COLUMN = 13;
const ROW_HEIGHT = 94;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve(null), 5000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    image.src = src;
  });
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function modelLines(ctx: CanvasRenderingContext2D, model: string, maxWidth: number): string[] {
  const words = model.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 2) return [lines[0], ellipsis(ctx, lines.slice(1).join(' '), maxWidth)];
  return lines.map((value) => ellipsis(ctx, value, maxWidth));
}

function drawContainedImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  size: number,
) {
  const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  ctx.drawImage(image, x + (size - width) / 2, y + (size - height) / 2, width, height);
}

function observedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export async function createBenchmarkShareImage(
  options: BenchmarkShareImageOptions,
): Promise<Blob> {
  if (!options.rows.length) throw new Error('No ranked models are available to share.');

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image export is unavailable in this browser.');

  const imageSources = [
    '/vibespace-icon.png',
    '/assets/themes/warm/benchmarks/continuation-v2/benchmark-scroll-composite-v2.webp',
    ...new Set(options.rows.map((row) => row.logoSrc).filter((src): src is string => !!src)),
  ];
  const images = new Map(
    await Promise.all(imageSources.map(async (src) => [src, await loadImage(src)] as const)),
  );

  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, '#fff8ed');
  background.addColorStop(0.58, '#f8ead8');
  background.addColorStop(1, '#f1dbc0');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const scene = images.get(imageSources[1]);
  if (scene) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(785, 0, 815, 306);
    ctx.clip();
    ctx.globalAlpha = 0.3;
    ctx.drawImage(scene, 0, 0, WIDTH, 900);
    ctx.restore();
  }

  ctx.fillStyle = '#d76643';
  roundedRect(ctx, 62, 54, 76, 76, 19);
  ctx.fill();
  const brand = images.get('/vibespace-icon.png');
  if (brand) drawContainedImage(ctx, brand, 62, 54, 76);
  else {
    ctx.fillStyle = '#fffaf2';
    ctx.font = '700 54px system-ui, sans-serif';
    ctx.fillText('V', 80, 110);
  }
  ctx.fillStyle = '#39281d';
  ctx.font = '700 35px system-ui, sans-serif';
  ctx.fillText('VibeSpace', 156, 99);

  ctx.fillStyle = '#b85635';
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.fillText('MODEL BENCHMARKS', 64, 184);
  ctx.fillStyle = '#39281d';
  ctx.font = '700 66px Georgia, serif';
  ctx.fillText(`${options.category} leaderboard`, 60, 251);
  ctx.fillStyle = '#6e5543';
  ctx.font = '21px system-ui, sans-serif';
  ctx.fillText(
    `Top ${options.rows.length} models  ·  ${options.unit}  ·  ${options.direction} is better`,
    64,
    290,
  );

  ctx.textAlign = 'right';
  ctx.fillStyle = '#765b46';
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText(`ARTIFICIAL ANALYSIS  ·  ${observedDate(options.sourceObservedAt)}`, 1535, 93);
  ctx.textAlign = 'left';

  for (const [index, row] of options.rows.slice(0, 25).entries()) {
    const column = Math.floor(index / ROWS_PER_COLUMN);
    const position = index % ROWS_PER_COLUMN;
    const x = column === 0 ? 62 : 821;
    const y = 330 + position * ROW_HEIGHT;
    const width = 717;

    ctx.fillStyle = index < 3 ? 'rgba(255, 250, 241, 0.94)' : 'rgba(255, 250, 241, 0.78)';
    roundedRect(ctx, x, y, width, 84, 17);
    ctx.fill();
    ctx.strokeStyle = index < 3 ? '#dfa67c' : '#e8cfb4';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = index < 3 ? '#bd5734' : '#816b59';
    ctx.font = '700 21px system-ui, sans-serif';
    ctx.fillText(String(index + 1).padStart(2, '0'), x + 20, y + 49);

    ctx.fillStyle = '#fffaf3';
    roundedRect(ctx, x + 60, y + 22, 40, 40, 11);
    ctx.fill();
    ctx.strokeStyle = '#e5ccb1';
    ctx.stroke();
    const logo = row.logoSrc ? images.get(row.logoSrc) : null;
    if (logo) drawContainedImage(ctx, logo, x + 66, y + 28, 28);
    else {
      ctx.fillStyle = '#765b46';
      ctx.font = '700 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(row.provider.slice(0, 2).toUpperCase(), x + 80, y + 49);
      ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#36291f';
    ctx.font = '600 18px system-ui, sans-serif';
    const lines = modelLines(ctx, row.model, 425);
    lines.forEach((line, lineIndex) => ctx.fillText(line, x + 113, y + 29 + lineIndex * 21));

    ctx.fillStyle = '#806959';
    ctx.font = '14px system-ui, sans-serif';
    const details = `${row.provider}  ·  ${row.inputPrice} / ${row.outputPrice} per 1M  ·  ${row.context} ctx`;
    ctx.fillText(ellipsis(ctx, details, 490), x + 113, y + 72);

    ctx.textAlign = 'right';
    ctx.fillStyle = index < 3 ? '#ba5736' : '#46362a';
    ctx.font = '700 27px system-ui, sans-serif';
    ctx.fillText(row.score, x + width - 21, y + 48);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = '#8f6b51';
  ctx.fillRect(62, 1568, 1476, 1);
  ctx.fillStyle = '#765b46';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(
    'Source: Artificial Analysis  ·  Scores and prices are source supplied; unavailable values shown as —',
    64,
    1601,
  );
  ctx.textAlign = 'right';
  ctx.fillText(ellipsis(ctx, options.sourceUrl, 565), 1536, 1601);
  ctx.textAlign = 'left';

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The leaderboard image could not be encoded.'));
    }, 'image/png');
  });
}

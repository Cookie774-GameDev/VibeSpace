import * as React from 'react';
import './WarmHexProgress.css';

const MAX_CANVAS_WIDTH = 2_048;
const MAX_CANVAS_HEIGHT = 768;
const MAX_PIXEL_RATIO = 2;

export interface WarmHexProgressProps {
  progress: number | null;
  label: string;
  detail?: string;
  mode?: 'compact' | 'full';
  density?: 'standard' | 'fine';
  paused?: boolean;
  failed?: boolean;
  estimated?: boolean;
  reducedMotion?: boolean;
  className?: string;
}

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function useReducedMotion(override: boolean | undefined): boolean {
  const [systemPreference, setSystemPreference] = React.useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  React.useEffect(() => {
    if (override !== undefined || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemPreference(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [override]);

  return override ?? systemPreference;
}

function hexPath(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  context.beginPath();
  for (let point = 0; point < 6; point += 1) {
    const angle = (Math.PI / 3) * point;
    const pointX = x + Math.cos(angle) * radius;
    const pointY = y + Math.sin(angle) * radius;
    if (point === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.closePath();
}

function drawWarmHexes(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  progress: number,
  mode: 'compact' | 'full',
  density: 'standard' | 'fine',
  phase: number,
  indeterminate: boolean,
): void {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(
    1,
    rect.width || canvas.clientWidth || (mode === 'compact' ? 320 : 720),
  );
  const cssHeight = Math.max(
    1,
    rect.height || canvas.clientHeight || (mode === 'compact' ? 56 : 168),
  );
  const requestedRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
  const ratio = Math.min(
    requestedRatio,
    MAX_CANVAS_WIDTH / cssWidth,
    MAX_CANVAS_HEIGHT / cssHeight,
  );
  const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
  const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = '#130e0a';
  context.fillRect(0, 0, cssWidth, cssHeight);

  const radius =
    density === 'fine'
      ? Math.max(2.5, Math.min(3.1, cssWidth / 155))
      : Math.max(mode === 'compact' ? 4.2 : 6.5, cssWidth / 180);
  const stepX = radius * 1.52;
  const stepY = radius * 1.74;
  const completedX = cssWidth * (progress / 100);
  const sweepX = ((Math.sin(phase * 0.45) + 1) / 2) * cssWidth;
  const glowWidth =
    density === 'fine'
      ? Math.max(radius * 18, cssWidth * 0.22)
      : Math.max(radius * 5, cssWidth * 0.075);
  const columns = Math.ceil(cssWidth / stepX) + 2;
  const rows = Math.ceil(cssHeight / stepY) + 2;

  for (let column = -1; column < columns; column += 1) {
    const x = column * stepX;
    for (let row = -1; row < rows; row += 1) {
      const y = row * stepY + (column % 2 === 0 ? 0 : stepY / 2);
      const isComplete = !indeterminate && x <= completedX;
      const edgeDistance = Math.abs(x - completedX);
      const edgeGlow = isComplete ? Math.max(0, 1 - edgeDistance / glowWidth) : 0;
      const estimatingGlow = indeterminate ? Math.max(0, 1 - Math.abs(x - sweepX) / glowWidth) : 0;
      const workingGlow =
        density === 'fine' ? Math.max(0, 1 - Math.abs(x - sweepX) / glowWidth) : 0;
      const shimmer = Math.max(edgeGlow, workingGlow * 0.7) *
        (0.72 + Math.sin(phase + row * 0.45 + column * 0.31) * 0.18);
      const warmBand = Math.max(0, Math.min(1, x / Math.max(1, completedX)));

      if (estimatingGlow > 0) {
        context.fillStyle = `rgba(214, 95, 50, ${0.18 + estimatingGlow * 0.56})`;
      } else if (!isComplete) {
        context.fillStyle =
          workingGlow > 0
            ? `rgba(255, 165, 105, ${0.2 + workingGlow * 0.62})`
            : 'rgba(82, 38, 24, 0.22)';
      } else if (shimmer > 0.5) {
        context.fillStyle = `rgba(255, 198, 137, ${Math.min(0.96, 0.7 + shimmer * 0.24)})`;
      } else if (warmBand > 0.72) {
        context.fillStyle = 'rgba(214, 95, 50, 0.84)';
      } else {
        context.fillStyle = 'rgba(126, 51, 29, 0.78)';
      }

      hexPath(context, x, y, radius * 0.9);
      context.fill();
    }
  }
}

export function WarmHexProgress({
  progress,
  label,
  detail,
  mode = 'full',
  density = 'standard',
  paused = false,
  failed = false,
  estimated = false,
  reducedMotion: reducedMotionOverride,
  className,
}: WarmHexProgressProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion(reducedMotionOverride);
  const indeterminate = progress === null || !Number.isFinite(progress);
  const exactProgress =
    typeof progress === 'number' && Number.isFinite(progress) ? boundedProgress(progress) : 0;
  const displayedProgress = indeterminate ? null : Math.round(exactProgress);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    let disposed = false;
    let frame: number | null = null;
    const startedAt = performance.now();
    const animated =
      !paused &&
      !reducedMotion &&
      (indeterminate || (exactProgress < 100 && (exactProgress > 0 || density === 'fine')));

    const render = (time = startedAt) => {
      if (disposed) return;
      drawWarmHexes(
        canvas,
        context,
        exactProgress,
        mode,
        density,
        animated ? (time - startedAt) / 560 : 0,
        indeterminate,
      );
    };
    const tick = (time: number) => {
      render(time);
      if (!disposed) frame = window.requestAnimationFrame(tick);
    };

    render();
    if (animated) frame = window.requestAnimationFrame(tick);

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            render();
          })
        : null;
    observer?.observe(canvas);

    return () => {
      disposed = true;
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [density, exactProgress, indeterminate, mode, paused, reducedMotion]);

  const classes = ['warm-hex-progress', `warm-hex-progress--${mode}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : exactProgress}
      aria-valuetext={
        indeterminate
          ? 'Estimating time…'
          : `${estimated ? 'Approximately ' : ''}${displayedProgress}%${failed ? ', failed' : paused ? ', paused' : ''}`
      }
      data-motion={reducedMotion ? 'reduced' : 'full'}
      data-paused={paused ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-density={density}
      data-estimated={estimated ? 'true' : 'false'}
      data-indeterminate={indeterminate ? 'true' : 'false'}
    >
      <canvas ref={canvasRef} className="warm-hex-progress__canvas" aria-hidden="true" />
      <div className="warm-hex-progress__scrim" aria-hidden="true" />
      <div className="warm-hex-progress__content">
        <div className="warm-hex-progress__copy">
          <span className="warm-hex-progress__label">{label}</span>
          {detail ? <span className="warm-hex-progress__detail">{detail}</span> : null}
        </div>
        <span className="warm-hex-progress__value">
          {displayedProgress === null
            ? 'Estimating…'
            : `${estimated ? '≈ ' : ''}${displayedProgress}%`}
        </span>
      </div>
    </div>
  );
}

import * as React from 'react';
import { isSafeWallpaperAssetUrl } from './wallpapers';
import type { WorkbenchWallpaperConfig } from './types';

interface WallpaperHostProps {
  config: WorkbenchWallpaperConfig;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return reduced;
}

function CanvasWallpaper({
  config,
  reducedMotion,
}: WallpaperHostProps & { reducedMotion: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const pointerRef = React.useRef({ x: 0.62, y: 0.32 });

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frame = 0;
    let animation = 0;
    const seed = Array.from(
      { length: config.quality === 'high' ? 110 : config.quality === 'low' ? 34 : 66 },
      (_, index) => ({
        x: ((index * 73) % 997) / 997,
        y: ((index * 181) % 991) / 991,
        size: 0.5 + ((index * 29) % 19) / 9,
        speed: 0.08 + ((index * 17) % 11) / 110,
      }),
    );

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, config.quality === 'high' ? 2 : 1.35);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      const px = config.interactive ? pointerRef.current.x * width : width * 0.62;
      const py = config.interactive ? pointerRef.current.y * height : height * 0.32;

      if (config.id === 'space-clouds') {
        const clouds = [
          { x: width * 0.2 + px * 0.07, y: height * 0.28 + py * 0.04, r: width * 0.34, hue: 268 },
          { x: width * 0.68 - px * 0.04, y: height * 0.6 - py * 0.03, r: width * 0.38, hue: 202 },
          { x: width * 0.72 + px * 0.025, y: height * 0.16 + py * 0.02, r: width * 0.24, hue: 28 },
        ];
        for (const cloud of clouds) {
          const gradient = context.createRadialGradient(
            cloud.x,
            cloud.y,
            0,
            cloud.x,
            cloud.y,
            cloud.r,
          );
          gradient.addColorStop(0, `hsla(${cloud.hue}, 74%, 58%, ${0.12 * config.intensity})`);
          gradient.addColorStop(
            0.42,
            `hsla(${cloud.hue + 18}, 64%, 38%, ${0.08 * config.intensity})`,
          );
          gradient.addColorStop(1, 'transparent');
          context.fillStyle = gradient;
          context.fillRect(0, 0, width, height);
        }
      }

      for (const point of seed) {
        const drift = config.paused || reducedMotion ? 0 : frame * point.speed;
        const x = (point.x * width + drift) % width;
        const y = (point.y * height + Math.sin((frame + point.x * 400) / 140) * 4) % height;
        const distance = Math.hypot(x - px, y - py);
        const response = config.interactive ? Math.max(0, 1 - distance / (width * 0.22)) : 0;
        context.beginPath();
        context.arc(
          x + response * (x - px) * 0.05,
          y + response * (y - py) * 0.05,
          point.size * ratio,
          0,
          Math.PI * 2,
        );
        context.fillStyle =
          config.id === 'particles'
            ? `rgba(238, 177, 112, ${0.18 + response * 0.5})`
            : `rgba(244, 235, 218, ${0.22 + response * 0.55})`;
        context.fill();
      }
      frame += 1;
      if (!config.paused && !reducedMotion) animation = window.requestAnimationFrame(draw);
    };

    draw();
    const onResize = () => draw();
    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
      };
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      window.cancelAnimationFrame(animation);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [
    config.id,
    config.intensity,
    config.interactive,
    config.paused,
    config.quality,
    reducedMotion,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="workbench-wallpaper-canvas [html[data-theme=monochrome]_&]:hidden"
      aria-hidden="true"
    />
  );
}

export function WallpaperHost({ config }: WallpaperHostProps) {
  const reducedMotion = useReducedMotion();
  const paused = config.paused || reducedMotion;
  const assetKind = config.id === 'custom-video' ? 'video' : 'image';
  const safeAsset =
    config.assetUrl && isSafeWallpaperAssetUrl(config.assetUrl, assetKind) ? config.assetUrl : null;

  return (
    <div
      data-testid="workbench-wallpaper"
      data-wallpaper={config.id}
      data-paused={paused ? 'true' : 'false'}
      className={`workbench-wallpaper workbench-wallpaper--${config.id}`}
      style={
        {
          pointerEvents: 'none',
          '--wallpaper-intensity': config.intensity,
          '--wallpaper-brightness': config.brightness,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {(config.id === 'space-clouds' || config.id === 'starfield' || config.id === 'particles') && (
        <CanvasWallpaper config={{ ...config, paused }} reducedMotion={reducedMotion} />
      )}
      {config.id === 'custom-image' && safeAsset && (
        <img
          src={safeAsset}
          alt=""
          draggable={false}
          className="[html[data-theme=monochrome]_&]:hidden"
        />
      )}
      {config.id === 'custom-video' && safeAsset && (
        <video
          src={safeAsset}
          muted
          loop
          playsInline
          autoPlay={!paused}
          className="[html[data-theme=monochrome]_&]:hidden"
        />
      )}
      <div className="workbench-wallpaper-vignette" />
    </div>
  );
}

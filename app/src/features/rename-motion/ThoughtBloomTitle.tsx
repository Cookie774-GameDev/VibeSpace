import * as React from 'react';
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';
import {
  createThoughtBloomParticles,
  getCanvasPixelSize,
  hashThoughtBloomSeed,
  MAX_ANIMATED_TITLE_GRAPHEMES,
  splitTitleGraphemes,
  THOUGHT_BLOOM_DURATION_MS,
  type ThoughtBloomOrigin,
} from './thoughtBloomEngine';

interface ThoughtBloomTitleProps {
  title: string;
  className?: string;
}

interface ThoughtBloomRun {
  id: number;
  previousTitle: string;
  nextTitle: string;
  seed: number;
}

const OLD_TITLE_DURATION_SECONDS = 0.72;
const NEW_TITLE_START_SECONDS = 0.28;
const NEW_TITLE_DURATION_SECONDS = 0.54;

function resolveAccentHsl(element: HTMLElement): string {
  const styles = getComputedStyle(element);
  let value = styles.getPropertyValue('--accent-copper').trim();

  for (let depth = 0; depth < 3; depth += 1) {
    const reference = /^var\((--[^),\s]+)(?:,[^)]+)?\)$/.exec(value);
    if (!reference?.[1]) break;
    value = styles.getPropertyValue(reference[1]).trim();
  }

  return /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/.test(value) ? value : '14 64% 60%';
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reducedMotion;
}

export function ThoughtBloomTitle({ title, className }: ThoughtBloomTitleProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [run, setRun] = React.useState<ThoughtBloomRun | null>(null);
  const previousTitleRef = React.useRef(title);
  const runIdRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);
  const stageRef = React.useRef<HTMLSpanElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  const cancelFrame = React.useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  React.useLayoutEffect(() => {
    const previousTitle = previousTitleRef.current;
    if (previousTitle === title) return;

    previousTitleRef.current = title;
    runIdRef.current += 1;
    cancelFrame();

    if (reducedMotion) {
      setRun(null);
      return;
    }

    const id = runIdRef.current;
    setRun({
      id,
      previousTitle,
      nextTitle: title,
      seed: hashThoughtBloomSeed(`${title}|${id}|thought-bloom`),
    });
  }, [cancelFrame, reducedMotion, title]);

  React.useLayoutEffect(() => {
    if (!run) return;

    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const stageBounds = stage.getBoundingClientRect();
    const oldCharacters = stage.querySelectorAll<HTMLElement>('[data-thought-bloom-old-char]');
    const origins: ThoughtBloomOrigin[] = Array.from(oldCharacters, (character) => {
      const bounds = character.getBoundingClientRect();
      return {
        x: bounds.left - stageBounds.left + bounds.width / 2,
        y: bounds.top - stageBounds.top + bounds.height / 2,
        width: bounds.width,
        height: bounds.height,
      };
    }).filter((origin) => origin.width > 0 && origin.height > 0);

    const pixelSize = getCanvasPixelSize(
      stageBounds.width,
      stageBounds.height,
      window.devicePixelRatio,
    );
    canvas.width = pixelSize.width;
    canvas.height = pixelSize.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelSize.dpr, 0, 0, pixelSize.dpr, 0, 0);

    const particles = createThoughtBloomParticles(origins, run.seed);
    const accentColor = resolveAccentHsl(stage);
    const startedAt = performance.now();

    const renderFrame = (now: number) => {
      if (runIdRef.current !== run.id) return;
      const progress = Math.min((now - startedAt) / THOUGHT_BLOOM_DURATION_MS, 1);
      context.clearRect(0, 0, stageBounds.width, stageBounds.height);

      for (const particle of particles) {
        const localProgress = (progress - particle.delay) / particle.life;
        if (localProgress <= 0 || localProgress >= 1) continue;

        const travel = localProgress * 42;
        const x = particle.x + particle.velocityX * travel;
        const y =
          particle.y +
          particle.velocityY * travel +
          particle.gravity * localProgress * localProgress * 24;
        const fade = 1 - localProgress;

        context.beginPath();
        context.fillStyle = `hsl(${accentColor} / ${particle.alpha * fade})`;
        context.arc(x, y, particle.radius * (0.72 + fade * 0.28), 0, Math.PI * 2);
        context.fill();
      }

      if (progress < 1) {
        frameRef.current = requestAnimationFrame(renderFrame);
      } else {
        frameRef.current = null;
        context.clearRect(0, 0, stageBounds.width, stageBounds.height);
        if (runIdRef.current === run.id) setRun(null);
      }
    };

    frameRef.current = requestAnimationFrame(renderFrame);
    const cancelOnResize = () => {
      if (runIdRef.current !== run.id) return;
      runIdRef.current += 1;
      cancelFrame();
      context.clearRect(0, 0, stageBounds.width, stageBounds.height);
      setRun(null);
    };
    window.addEventListener('resize', cancelOnResize, { once: true });

    return () => {
      window.removeEventListener('resize', cancelOnResize);
      cancelFrame();
      context.clearRect(0, 0, stageBounds.width, stageBounds.height);
    };
  }, [cancelFrame, run]);

  React.useEffect(() => cancelFrame, [cancelFrame]);

  return (
    <span
      ref={stageRef}
      data-thought-bloom-title
      data-thought-bloom-state={run ? 'blooming' : 'idle'}
      data-testid="thought-bloom-stage"
      className={cn('relative block h-[1lh] min-w-0 flex-1 overflow-hidden', className)}
    >
      {run ? (
        <>
          <span className="sr-only">{title}</span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 block whitespace-nowrap"
          >
            {splitTitleGraphemes(run.previousTitle)
              .slice(0, MAX_ANIMATED_TITLE_GRAPHEMES)
              .map((character, index) => (
                <motion.span
                  key={`${run.id}-old-${index}`}
                  data-thought-bloom-old-char={character.trim() ? true : undefined}
                  className="inline-block"
                  animate={{
                    opacity: [1, 0.72, 0],
                    x: [0, index % 2 === 0 ? -1.5 : 1.5, index % 2 === 0 ? -4 : 4],
                    y: [0, -1, -3],
                    rotate: [0, index % 2 === 0 ? -1.5 : 1.5],
                    scale: [1, 0.995, 0.97],
                    filter: ['blur(0px)', 'blur(0.5px)', 'blur(2.5px)'],
                  }}
                  transition={{
                    duration: OLD_TITLE_DURATION_SECONDS,
                    delay: index * 0.006,
                    ease: [0.32, 0, 0.67, 0],
                  }}
                >
                  {character === ' ' ? '\u00a0' : character}
                </motion.span>
              ))}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 block whitespace-nowrap"
          >
            {splitTitleGraphemes(run.nextTitle)
              .slice(0, MAX_ANIMATED_TITLE_GRAPHEMES)
              .map((character, index, characters) => (
                <motion.span
                  key={`${run.id}-new-${index}`}
                  className="inline-block"
                  initial={{ opacity: 0, y: 6, scale: 0.99, filter: 'blur(8px)' }}
                  animate={{
                    opacity: 1,
                    y: [6, -0.5, 0],
                    scale: [0.99, 1.006, 1],
                    filter: ['blur(8px)', 'blur(0.5px)', 'blur(0px)'],
                  }}
                  transition={{
                    duration: NEW_TITLE_DURATION_SECONDS,
                    delay:
                      NEW_TITLE_START_SECONDS + (index / Math.max(1, characters.length - 1)) * 0.42,
                    ease: [0.18, 0.78, 0.2, 1],
                  }}
                >
                  {character === ' ' ? '\u00a0' : character}
                </motion.span>
              ))}
          </span>
          <canvas
            ref={canvasRef}
            data-testid="thought-bloom-particles"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/45"
            initial={{ left: '-2px', opacity: 0 }}
            animate={{ left: '100%', opacity: [0, 0.42, 0] }}
            transition={{ duration: 0.12, delay: 1.68, ease: [0.2, 0.75, 0.2, 1] }}
          />
        </>
      ) : (
        <span className="block truncate">{title}</span>
      )}
    </span>
  );
}

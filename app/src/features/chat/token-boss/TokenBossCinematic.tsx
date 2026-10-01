import * as React from 'react';
import { TOKEN_BOSS_REQUEST_EVENT, type TokenBossRequest } from './events';
import { getTokenBossProvider, type TokenBossProvider } from './providers';
import {
  renderTokenBossFrame,
  TOKEN_BOSS_DURATION_MS,
  TOKEN_BOSS_HEIGHT,
  TOKEN_BOSS_WIDTH,
} from './renderer';
import './token-boss.css';

interface Playback {
  request: TokenBossRequest;
  provider: TokenBossProvider;
}

function scheduleImpactAudio(provider: TokenBossProvider): () => void {
  const AudioContextConstructor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return () => undefined;
  let context: AudioContext | null = null;
  let timer = 0;
  try {
    context = new AudioContextConstructor();
    if (context.state === 'suspended') void context.resume();
    timer = window.setTimeout(() => {
      if (!context || context.state !== 'running') return;
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(0.34, now + 0.015);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
      master.connect(context.destination);

      const sub = context.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(72, now);
      sub.frequency.exponentialRampToValueAtTime(25, now + 0.62);
      sub.connect(master);
      sub.start(now);
      sub.stop(now + 0.72);

      const metal = context.createOscillator();
      metal.type = provider.id === 'ollama' ? 'triangle' : 'square';
      metal.frequency.setValueAtTime(154, now);
      metal.frequency.exponentialRampToValueAtTime(83, now + 0.48);
      metal.connect(master);
      metal.start(now);
      metal.stop(now + 0.5);
    }, 2_580);
  } catch {
    void context?.close();
    context = null;
  }
  return () => {
    window.clearTimeout(timer);
    void context?.close();
  };
}

export function TokenBossCinematic({
  chatId,
  /** Smaller layout for pet mini-panel / compact chat chrome. */
  compact = false,
}: {
  chatId: string;
  compact?: boolean;
}) {
  const [playback, setPlayback] = React.useState<Playback | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const frameRef = React.useRef(0);
  const playbackRef = React.useRef<Playback | null>(null);
  const cleanupAudioRef = React.useRef<() => void>(() => undefined);

  const stop = React.useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    cleanupAudioRef.current();
    cleanupAudioRef.current = () => undefined;
    const restoreFocus = playbackRef.current?.request.restoreFocus;
    playbackRef.current = null;
    setPlayback(null);
    restoreFocus?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<TokenBossRequest>).detail;
      if (!request || request.chatId !== chatId || playbackRef.current) return;
      const next = { request, provider: getTokenBossProvider(request.providerId) };
      playbackRef.current = next;
      setPlayback(next);
    };
    window.addEventListener(TOKEN_BOSS_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(TOKEN_BOSS_REQUEST_EVENT, onRequest);
  }, [chatId]);

  React.useEffect(() => {
    if (!playback) return;
    const canvas = canvasRef.current;
      const context = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !context) {
      stop();
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const duration = reduced ? 1_480 : TOKEN_BOSS_DURATION_MS;
    const start = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round((rect.width || TOKEN_BOSS_WIDTH) * dpr));
      canvas.height = Math.max(1, Math.round((rect.height || TOKEN_BOSS_HEIGHT) * dpr));
      context.setTransform(
        canvas.width / TOKEN_BOSS_WIDTH,
        0,
        0,
        canvas.height / TOKEN_BOSS_HEIGHT,
        0,
        0,
      );
      context.imageSmoothingEnabled = false;
    };
    resize();

    if (playback.request.allowAudio && !reduced) {
      cleanupAudioRef.current = scheduleImpactAudio(playback.provider);
    }

    const draw = (now: number) => {
      const raw = Math.max(0, now - start);
      const elapsed = reduced
        ? raw < 380
          ? 950
          : raw < 1_080
            ? 3_480
            : 4_220 + 500 * clampReduced((raw - 1_080) / 400)
        : raw;
      renderTokenBossFrame(context, playback.provider, elapsed);
      if (raw >= duration) {
        stop();
        return;
      }
      frameRef.current = window.requestAnimationFrame(draw);
    };
    frameRef.current = window.requestAnimationFrame(draw);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', resize);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      cleanupAudioRef.current();
      cleanupAudioRef.current = () => undefined;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
    };
  }, [playback, stop]);

  React.useEffect(() => stop, [stop]);

  if (!playback) return null;
  return (
    <div
      className={
        compact ? 'token-boss-cinematic token-boss-cinematic--compact' : 'token-boss-cinematic'
      }
      role="dialog"
      aria-modal="true"
      aria-label={`${playback.provider.name} Token Boss cinematic`}
      data-provider={playback.provider.id}
      data-token-boss-compact={compact ? 'true' : undefined}
      style={
        {
          '--token-boss-accent': playback.provider.accent,
          '--token-boss-accent-2': playback.provider.accent2,
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} aria-hidden />
      <div className="token-boss-cinematic__caption">
        <strong>{playback.provider.name} token</strong>
        <span>{playback.provider.tagline}</span>
      </div>
      <span className="token-boss-cinematic__skip">
        {compact ? 'ESC · SKIP' : 'ESC TO SKIP · 4.72S'}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {playback.provider.name} Token Boss cinematic started. The visual usage meter does not
        change real usage or billing.
      </span>
    </div>
  );
}

function clampReduced(value: number) {
  return Math.max(0, Math.min(1, value));
}

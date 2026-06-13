import * as React from 'react';

interface VoiceActivityWaveformProps {
  levelRef: React.RefObject<number>;
  active: boolean;
}

const BAR_COUNT = 36;
const ACTIVE_FRAME_MS = 48;

function drawStaticWaveform(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): void {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  const gap = 2.8 * scale;
  const barWidth = Math.max(1 * scale, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
  const centerY = height / 2;
  const idleHeight = 1.4 * scale;
  context.fillStyle = 'rgba(249, 139, 8, 0.22)';

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const x = index * (barWidth + gap);
    const y = centerY - idleHeight / 2;
    context.beginPath();
    context.roundRect(x, y, barWidth, idleHeight, barWidth / 2);
    context.fill();
  }
}

export const VoiceActivityWaveform = React.memo(function VoiceActivityWaveform({
  levelRef,
  active,
}: VoiceActivityWaveformProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    if (!active) {
      drawStaticWaveform(context, canvas);
      return;
    }

    let frame = 0;
    let smoothedLevel = 0;
    let lastDraw = 0;
    let gradient: CanvasGradient | null = null;
    let gradientHeight = 0;

    const draw = (time: number) => {
      if (time - lastDraw < ACTIVE_FRAME_MS) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      lastDraw = time;

      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gradient = null;
      }

      context.clearRect(0, 0, width, height);
      const target = Math.min(1, Math.max(0, levelRef.current ?? 0));
      smoothedLevel += (target - smoothedLevel) * (target > smoothedLevel ? 0.42 : 0.18);

      const gap = 2.8 * scale;
      const barWidth = Math.max(1 * scale, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
      const centerY = height / 2;
      const phase = time * 0.005;

      if (!gradient || gradientHeight !== height) {
        gradient = context.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(248, 174, 44, 0.58)');
        gradient.addColorStop(0.5, 'rgba(249, 139, 8, 1)');
        gradient.addColorStop(1, 'rgba(176, 82, 13, 0.58)');
        gradientHeight = height;
      }
      context.fillStyle = gradient;

      for (let index = 0; index < BAR_COUNT; index += 1) {
        const normalized = index / Math.max(1, BAR_COUNT - 1);
        const envelope = Math.sin(normalized * Math.PI);
        const variation =
          0.48 + Math.sin(phase + index * 0.68) * 0.2 + Math.sin(phase * 1.6 + index * 0.27) * 0.16;
        const spike = index % 13 === 0 || index % 23 === 0 ? 1.55 : 1;
        const amplitude =
          (1.4 * scale + envelope * variation * smoothedLevel * height * 0.68) * spike;
        const x = index * (barWidth + gap);
        const y = centerY - amplitude / 2;
        context.beginPath();
        context.roundRect(x, y, barWidth, amplitude, barWidth / 2);
        context.fill();
      }

      frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [active, levelRef]);

  return <canvas ref={canvasRef} className="h-8 w-full" aria-label="Live microphone level" />;
});

import * as React from 'react';

interface VoiceActivityWaveformProps {
  levelRef: React.RefObject<number>;
  active: boolean;
}

const BAR_COUNT = 76;

export function VoiceActivityWaveform({ levelRef, active }: VoiceActivityWaveformProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frame = 0;
    let smoothedLevel = 0;

    const draw = (time: number) => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width * scale));
      const height = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.clearRect(0, 0, width, height);
      const target = active ? Math.min(1, Math.max(0, levelRef.current ?? 0)) : 0.025;
      smoothedLevel += (target - smoothedLevel) * (target > smoothedLevel ? 0.32 : 0.12);

      const gap = 3.2 * scale;
      const barWidth = Math.max(1 * scale, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
      const centerY = height / 2;
      const phase = time * 0.006;

      for (let index = 0; index < BAR_COUNT; index += 1) {
        const normalized = index / Math.max(1, BAR_COUNT - 1);
        const envelope = Math.sin(normalized * Math.PI);
        const variation =
          0.48 + Math.sin(phase + index * 0.68) * 0.2 + Math.sin(phase * 1.6 + index * 0.27) * 0.16;
        const spike = index % 13 === 0 || index % 23 === 0 ? 1.85 : 1;
        const amplitude =
          (1.6 * scale + envelope * variation * smoothedLevel * height * 0.72) * spike;
        const x = index * (barWidth + gap);
        const y = centerY - amplitude / 2;

        const gradient = context.createLinearGradient(0, y, 0, y + amplitude);
        gradient.addColorStop(0, 'rgba(248, 174, 44, 0.58)');
        gradient.addColorStop(0.5, 'rgba(249, 139, 8, 1)');
        gradient.addColorStop(1, 'rgba(176, 82, 13, 0.58)');
        context.fillStyle = gradient;
        context.beginPath();
        context.roundRect(x, y, barWidth, amplitude, barWidth / 2);
        context.fill();

        if (index % 2 === 0) {
          context.fillStyle = 'rgba(176, 82, 13, 0.55)';
          context.beginPath();
          context.arc(x + barWidth / 2, centerY, 0.85 * scale, 0, Math.PI * 2);
          context.fill();
        }
      }

      frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [active, levelRef]);

  return <canvas ref={canvasRef} className="h-8 w-full" aria-label="Live microphone level" />;
}

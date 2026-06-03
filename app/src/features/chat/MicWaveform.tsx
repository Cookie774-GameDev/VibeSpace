import { useEffect, useRef } from 'react';

interface MicWaveformProps {
  volumeRef: React.RefObject<number>;
}

export function MicWaveform({ volumeRef }: MicWaveformProps) {
  const bar1 = useRef<HTMLDivElement>(null);
  const bar2 = useRef<HTMLDivElement>(null);
  const bar3 = useRef<HTMLDivElement>(null);
  const bar4 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animationId: number;

    const update = () => {
      const vol = volumeRef.current ?? 0;
      
      // Map volume to height scale (min 0.2, max 1.0)
      const s1 = 0.2 + vol * 0.8;
      // Staggered response for organic sound wave look
      const s2 = 0.2 + Math.pow(vol, 1.2) * 0.8;
      const s3 = 0.2 + Math.pow(vol, 0.8) * 0.8;
      const s4 = 0.2 + Math.max(0, vol - 0.15) * 0.95;

      if (bar1.current) bar1.current.style.transform = `scaleY(${s1})`;
      if (bar2.current) bar2.current.style.transform = `scaleY(${s2})`;
      if (bar3.current) bar3.current.style.transform = `scaleY(${s3})`;
      if (bar4.current) bar4.current.style.transform = `scaleY(${s4})`;

      animationId = requestAnimationFrame(update);
    };

    animationId = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [volumeRef]);

  return (
    <div className="flex items-center justify-center gap-[2.5px] h-3.5 w-3.5" aria-label="Microphone volume level indicator">
      <div
        ref={bar1}
        className="w-[2px] h-full bg-accent-copper rounded-full origin-center transition-transform duration-75 ease-out scale-y-[0.2]"
      />
      <div
        ref={bar2}
        className="w-[2px] h-full bg-accent-copper rounded-full origin-center transition-transform duration-75 ease-out scale-y-[0.2]"
      />
      <div
        ref={bar3}
        className="w-[2px] h-full bg-accent-copper rounded-full origin-center transition-transform duration-75 ease-out scale-y-[0.2]"
      />
      <div
        ref={bar4}
        className="w-[2px] h-full bg-accent-copper rounded-full origin-center transition-transform duration-75 ease-out scale-y-[0.2]"
      />
    </div>
  );
}

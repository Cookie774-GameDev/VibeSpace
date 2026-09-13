import { useEffect, useRef, type RefObject } from 'react';

/** Live amplitude, with fast attack and gentle decay. No synthetic activity. */
export function DictationLevelMeter({ levelRef }: { levelRef: RefObject<number> }) {
  const meter = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    let level = 0;
    let previous = 0;
    const draw = (time: number) => {
      // This window has its own visibility; main-window hide events must not
      // freeze dictation. Always schedule the next frame so showing resumes it.
      frame = requestAnimationFrame(draw);
      if (document.visibilityState === 'hidden' || time - previous < 32) return;
      previous = time;
      const sample = typeof levelRef.current === 'number' && Number.isFinite(levelRef.current)
        ? levelRef.current : 0;
      const target = Math.sqrt(Math.max(0, Math.min(1, sample)));
      level += (target - level) * (target > level ? 0.7 : 0.25);
      for (const [index, bar] of Array.from(meter.current?.children ?? []).entries()) {
        const envelope = 0.45 + 0.55 * Math.sin((index / 15) * Math.PI);
        (bar as HTMLElement).style.height = `${2 + 18 * level * envelope}px`;
        (bar as HTMLElement).style.opacity = `${0.35 + 0.65 * level}`;
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelRef]);
  return (
    <div
      ref={meter}
      data-dictation-level-meter
      aria-hidden="true"
      className="flex h-5 w-full items-center justify-between gap-[2px] text-accent-copper"
    >
      {Array.from({ length: 16 }, (_, index) => (
        <span
          key={index}
          className="w-[3px] shrink-0 rounded-full bg-current"
          style={{ height: 2, opacity: 0.35 }}
        />
      ))}
    </div>
  );
}

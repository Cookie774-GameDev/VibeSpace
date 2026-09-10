import { useEffect, useRef, useState } from 'react';
import axo from '@/assets/pets/characters/vibespace-axolotl/previews/canonical-master-128.png';
import './AxoMotion.css';

export function AxoMotion({
  activity = 'idle',
  focusToken = 0,
}: {
  activity?: 'idle' | 'working' | 'success' | 'error';
  focusToken?: number;
}) {
  const previous = useRef({ activity, focusToken });
  const root = useRef<SVGSVGElement>(null);
  const [flourish, setFlourish] = useState<'focus' | 'success' | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const before = previous.current;
    previous.current = { activity, focusToken };
    const next =
      activity === 'error' || activity === 'working'
        ? null
        : before.activity === 'working' && activity === 'success'
          ? 'success'
          : focusToken > 0 && before.focusToken !== focusToken
            ? 'focus'
            : null;
    setFlourish(next);
    if (!next) return;
    const timer = window.setTimeout(() => setFlourish(null), 1400);
    return () => window.clearTimeout(timer);
  }, [activity, focusToken]);

  useEffect(() => {
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            intersecting = entry.isIntersecting;
            update();
          });
    if (root.current) observer?.observe(root.current);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const motion =
    activity === 'working' ? 'working' : activity === 'error' ? 'idle' : (flourish ?? 'idle');
  return (
    <svg
      ref={root}
      viewBox="0 0 160 160"
      className="axo-motion"
      aria-hidden="true"
      focusable="false"
      data-axo-motion={motion}
      data-paused={!visible}
    >
      <g
        className="axo-motion__signal"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="square"
      >
        <path d="M12 46V24H34 M126 24H148V46 M12 114V136H34 M126 136H148V114" />
      </g>
      <image className="axo-motion__character" href={axo} x="16" y="16" width="128" height="128" />
      <path
        className="axo-motion__check"
        d="M108 122l10 10 22-24"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
      />
    </svg>
  );
}

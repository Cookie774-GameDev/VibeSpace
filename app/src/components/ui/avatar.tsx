import * as React from 'react';
import { cn, hueFromString } from '@/lib/utils';

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When provided, derives the gradient hue from the seed (deterministic). */
  seed?: string;
  /** Single character or short string shown if no image */
  initials?: string;
  /** Optional image URL */
  src?: string;
  /** Pixel size; default 24 */
  size?: number;
  /** Optional icon/content rendered instead of initials. */
  children?: React.ReactNode;
}

/**
 * A deterministic avatar - colored gradient circle with initials.
 * Used everywhere we display an agent or user.
 */
export function Avatar({ seed, initials, src, size = 24, className, style, children, ...props }: AvatarProps) {
  const baseHue = seed ? hueFromString(seed) : 220;
  const hue2 = (baseHue + 60) % 360;
  const gradient = `linear-gradient(135deg, hsl(${baseHue}, 70%, 60%) 0%, hsl(${hue2}, 70%, 50%) 100%)`;
  const fontSize = Math.max(10, Math.floor(size * 0.4));
  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full overflow-hidden font-semibold text-white shrink-0 select-none',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: src ? undefined : gradient,
        fontSize,
        ...style,
      }}
      {...props}
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : children ? (
        children
      ) : (
        <span style={{ lineHeight: 1 }}>{(initials ?? seed ?? '?').slice(0, 2).toUpperCase()}</span>
      )}
    </div>
  );
}

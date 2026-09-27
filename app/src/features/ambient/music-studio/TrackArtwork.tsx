import * as React from 'react';
import { MUSIC_STUDIO_LIBRARY } from './catalog';

// Curated from five generated 4 × 5 sheets (100 candidates, 63 selected).
const coverTiles = [
  [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13],
  [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 13, 14, 18],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 19],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 19],
] as const;

const selectedCovers = coverTiles.flatMap((tiles, sheet) =>
  tiles.map((tile) => ({ sheet: sheet + 1, tile })),
);
const coversByTrackId = new Map(
  MUSIC_STUDIO_LIBRARY.map((track, index) => [
    track.id,
    selectedCovers[(index * 17) % selectedCovers.length]!,
  ]),
);

export function trackCoverTile(seed: string): { sheet: number; tile: number } | undefined {
  return coversByTrackId.get(seed);
}

export interface TrackArtworkRecipe {
  signature: string;
  hueA: number;
  hueB: number;
  angle: number;
  shape: number;
  bars: readonly number[];
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function trackArtworkRecipe(seed: string): TrackArtworkRecipe {
  const hash = stableHash(seed);
  const alternate = stableHash(`${seed}:vibespace-art`);
  const bars = Array.from({ length: 9 }, (_, index) => {
    const shifted = (hash >>> ((index % 4) * 8)) ^ (alternate >>> (((index + 1) % 4) * 8));
    return 18 + (shifted & 47);
  });
  return {
    signature: `${hash.toString(16)}:${alternate.toString(16)}`,
    hueA: hash % 360,
    hueB: (alternate % 240) + 60,
    angle: (hash >>> 9) % 360,
    shape: (alternate >>> 12) % 6,
    bars,
  };
}

function initials(name: string): string {
  const words = name.split(/\s+/u).filter(Boolean);
  return `${words[0]?.[0] ?? 'V'}${words.length > 1 ? (words.at(-1)?.[0] ?? '') : (words[0]?.[1] ?? '')}`.toUpperCase();
}

export function TrackArtwork({
  seed,
  name,
  className = '',
}: {
  seed: string;
  name: string;
  className?: string;
}) {
  const cover = trackCoverTile(seed);
  const recipe = React.useMemo(() => trackArtworkRecipe(seed), [seed]);
  const reactId = React.useId().replace(/:/gu, '');
  const gradientId = `music-art-${reactId}`;
  const accentX = 18 + (recipe.shape % 3) * 22;
  const accentY = 20 + Math.floor(recipe.shape / 3) * 32;

  if (cover) {
    return (
      <span
        role="img"
        aria-label={`Artwork for ${name}`}
        className={`block shrink-0 overflow-hidden rounded-lg bg-[#17191e] ${className}`}
        data-cover-tile={`${cover.sheet}-${cover.tile}`}
        style={{
          backgroundImage: `url(/music-studio/cover-sheet-${String(cover.sheet).padStart(2, '0')}.png)`,
          backgroundSize: '400% 500%',
          backgroundPosition: `${((cover.tile % 4) * 100) / 3}% ${Math.floor(cover.tile / 4) * 25}%`,
        }}
      />
    );
  }

  return (
    <svg
      role="img"
      aria-label={`Artwork for ${name}`}
      viewBox="0 0 96 96"
      className={`shrink-0 overflow-hidden rounded-lg ${className}`}
      data-artwork-signature={recipe.signature}
    >
      <defs>
        <linearGradient id={gradientId} gradientTransform={`rotate(${recipe.angle} .5 .5)`}>
          <stop offset="0" stopColor={`hsl(${recipe.hueA} 78% 48%)`} />
          <stop offset="1" stopColor={`hsl(${recipe.hueB} 72% 24%)`} />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="12" fill={`url(#${gradientId})`} />
      <circle cx={accentX} cy={accentY} r={18 + recipe.shape * 2} fill="white" opacity=".14" />
      <path
        d={`M-8 ${80 - recipe.shape * 5} Q 28 ${34 + recipe.shape * 4} 104 ${62 - recipe.shape * 3} V104 H-8Z`}
        fill="black"
        opacity=".2"
      />
      <g aria-hidden="true" transform="translate(12 62)">
        {recipe.bars.map((height, index) => (
          <rect
            key={index}
            x={index * 8}
            y={(32 - height) / 2}
            width="4"
            height={height / 2}
            rx="2"
            fill="white"
            opacity={0.45 + (index % 3) * 0.16}
          />
        ))}
      </g>
      <text
        x="12"
        y="32"
        fill="white"
        fontSize="20"
        fontWeight="800"
        fontFamily="Inter, sans-serif"
        letterSpacing="1"
      >
        {initials(name)}
      </text>
    </svg>
  );
}

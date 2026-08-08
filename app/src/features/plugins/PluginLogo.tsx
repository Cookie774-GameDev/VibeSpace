import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { resolveRuntimePlan } from '@/lib/runtimeProfile';
import { getPluginLogoSources } from './pluginLogos';
import type { PluginManifest } from './types';

type PluginLogoPlugin = Pick<PluginManifest, 'id' | 'name' | 'credentialUrl' | 'docsUrl'>;

export interface PluginLogoProps {
  plugin: PluginLogoPlugin;
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLASS = {
  sm: { box: 'h-6 w-6', img: 'h-4 w-4', text: 'text-[8px]' },
  md: { box: 'h-8 w-8', img: 'h-5 w-5', text: 'text-[10px]' },
} as const;

const loadedLogoSources = new Set<string>();

function pluginInitials(name: string): string {
  const genericWords = new Set(['app', 'connector', 'integration', 'plugin', 'service', 'tool']);
  const words = (name.match(/[A-Za-z0-9]+/g) ?? []).filter(
    (word) => !genericWords.has(word.toLowerCase()),
  );
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();

  const primary = words[0] ?? 'Plugin';
  const capitals = primary.match(/[A-Z]/g) ?? [];
  if (capitals.length >= 2) return capitals.slice(0, 2).join('');
  return primary.slice(0, 2).toUpperCase();
}

function pluginHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

export function PluginLogo({ plugin, size = 'md', className }: PluginLogoProps) {
  const remoteSourcesEnabled = resolveRuntimePlan().isOrdinary;
  const sources = useMemo(
    () => (remoteSourcesEnabled ? getPluginLogoSources(plugin) : []),
    [plugin, remoteSourcesEnabled],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const dims = SIZE_CLASS[size];
  const src = sources[sourceIndex];
  const [loaded, setLoaded] = useState(() => Boolean(src && loadedLogoSources.has(src)));
  const hue = pluginHue(plugin.id);

  useEffect(() => {
    setSourceIndex(0);
    setExhausted(false);
    setLoaded(Boolean(sources[0] && loadedLogoSources.has(sources[0])));
  }, [plugin.id, sources.join('|')]);

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md',
        dims.box,
        className,
      )}
      aria-hidden
    >
      <span
        data-testid="plugin-logo-fallback"
        className={cn(
          'absolute inset-0 flex items-center justify-center font-bold tracking-[-0.04em] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]',
          dims.text,
        )}
        style={{
          background: `linear-gradient(145deg, hsl(${hue} 58% 44%), hsl(${(hue + 28) % 360} 58% 28%))`,
        }}
      >
        {pluginInitials(plugin.name)}
      </span>
      {!exhausted && src ? (
        <img
          src={src}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          data-loaded={loaded ? 'true' : 'false'}
          className={cn(
            'relative object-contain transition-opacity duration-150 motion-reduce:transition-none',
            dims.img,
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => {
            loadedLogoSources.add(src);
            setLoaded(true);
          }}
          onError={() => {
            setLoaded(false);
            if (sourceIndex + 1 < sources.length) setSourceIndex((index) => index + 1);
            else setExhausted(true);
          }}
        />
      ) : null}
    </span>
  );
}

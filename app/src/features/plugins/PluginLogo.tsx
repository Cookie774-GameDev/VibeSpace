import { useEffect, useMemo, useState } from 'react';
import { Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPluginLogoSources } from './pluginLogos';
import type { PluginManifest } from './types';

type PluginLogoPlugin = Pick<PluginManifest, 'id' | 'name' | 'credentialUrl' | 'docsUrl'>;

export interface PluginLogoProps {
  plugin: PluginLogoPlugin;
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLASS = {
  sm: { box: 'h-6 w-6', img: 'h-4 w-4', icon: 'h-3.5 w-3.5' },
  md: { box: 'h-8 w-8', img: 'h-5 w-5', icon: 'h-4 w-4' },
} as const;

export function PluginLogo({ plugin, size = 'md', className }: PluginLogoProps) {
  const sources = useMemo(() => getPluginLogoSources(plugin), [plugin]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const dims = SIZE_CLASS[size];

  useEffect(() => {
    setSourceIndex(0);
    setExhausted(false);
  }, [plugin.id, sources.join('|')]);

  const src = sources[sourceIndex];

  if (exhausted || !src) {
    return (
      <span
        className={cn(
          'rounded-md bg-elevated flex items-center justify-center shrink-0',
          dims.box,
          className,
        )}
        aria-hidden
      >
        <Plug className={cn('text-accent-cyan', dims.icon)} />
      </span>
    );
  }

  return (
    <span
      className={cn(
        'rounded-md bg-elevated flex items-center justify-center shrink-0 overflow-hidden',
        dims.box,
        className,
      )}
    >
      <img
        src={src}
        alt=""
        aria-hidden
        className={cn('object-contain', dims.img)}
        onError={() => {
          if (sourceIndex + 1 < sources.length) setSourceIndex((index) => index + 1);
          else setExhausted(true);
        }}
      />
    </span>
  );
}

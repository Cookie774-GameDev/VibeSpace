import * as React from 'react';
import {
  Bot,
  Bug,
  Code2,
  Compass,
  Hammer,
  MessageCircle,
  Palette,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DEFAULT_VIBESPACE_EMOJI_ID,
  findVibeSpaceEmoji,
  type VibeSpaceEmojiDefinition,
} from './catalog';
import { emojiAssetStore, type EmojiAssetStore } from './uploadStore';

const ICONS: Record<VibeSpaceEmojiDefinition['icon'], LucideIcon> = {
  spark: Sparkles,
  builder: Hammer,
  navigator: Compass,
  analyst: Bot,
  guardian: ShieldCheck,
  creator: Palette,
  researcher: Search,
  debugger: Bug,
  communicator: MessageCircle,
  automator: Code2,
};

export interface EmojiMarkProps {
  token?: string;
  label?: string;
  className?: string;
  assetStore?: EmojiAssetStore;
}

export function EmojiMark({
  token,
  label,
  className,
  assetStore = emojiAssetStore,
}: EmojiMarkProps) {
  const [assetUrl, setAssetUrl] = React.useState<string | null>(null);
  const [loadedToken, setLoadedToken] = React.useState<string | null>(null);
  const definition = findVibeSpaceEmoji(token ?? '');
  const isUpload = token?.startsWith('upload:') ?? false;

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setAssetUrl(null);
    setLoadedToken(null);
    if (!isUpload || !token) return;
    void assetStore
      .get(token)
      .then((asset) => {
        if (cancelled || !asset) return;
        objectUrl = URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType }));
        setAssetUrl(objectUrl);
        setLoadedToken(token);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetStore, isUpload, token]);

  if (assetUrl && loadedToken === token) {
    return (
      <span
        aria-label={label}
        data-emoji-id={token}
        className={cn(
          'inline-flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-lg',
          className,
        )}
      >
        <img src={assetUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      </span>
    );
  }

  const resolved =
    definition ??
    (isUpload || !token?.trim() ? findVibeSpaceEmoji(DEFAULT_VIBESPACE_EMOJI_ID) : undefined);
  if (resolved) {
    const Icon = ICONS[resolved.icon];
    return (
      <span
        aria-label={label}
        data-emoji-id={resolved.id}
        title={label ? undefined : resolved.name}
        className={cn(
          'inline-flex aspect-square shrink-0 items-center justify-center rounded-lg border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]',
          className,
        )}
        style={{ color: resolved.foreground, background: resolved.background }}
      >
        <Icon aria-hidden="true" className="h-[58%] w-[58%]" strokeWidth={2.35} />
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      data-emoji-id={token}
      className={cn(
        'inline-flex aspect-square shrink-0 items-center justify-center text-[1em] leading-none',
        className,
      )}
    >
      {token}
    </span>
  );
}

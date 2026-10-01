import * as React from 'react';
import { Plus, Search, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEFAULT_VIBESPACE_EMOJI_ID, VIBESPACE_EMOJIS, searchVibeSpaceEmojis } from './catalog';
import { EmojiMark } from './EmojiMark';
import {
  emojiAssetStore,
  type CustomEmojiSummary,
  type EmojiAssetStore,
  type EmojiDimensionReader,
} from './uploadStore';

export interface EmojiPickerProps {
  value?: string;
  onChange: (value: string) => void;
  label: string;
  legacyTokens?: readonly string[];
  assetStore?: EmojiAssetStore;
  readDimensions?: EmojiDimensionReader;
}

function compactTokens(value?: string): string[] {
  const selected = value?.startsWith('vibe:') ? value : DEFAULT_VIBESPACE_EMOJI_ID;
  return [
    selected,
    ...VIBESPACE_EMOJIS.map((emoji) => emoji.id).filter((id) => id !== selected),
  ].slice(0, 5);
}

function uploadedName(file: File): string {
  return file.name.replace(/\.[^.]+$/u, '').trim() || 'Custom emoji';
}

export function EmojiPicker({
  value,
  onChange,
  label,
  legacyTokens = [],
  assetStore = emojiAssetStore,
  readDimensions,
}: EmojiPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [uploads, setUploads] = React.useState<CustomEmojiSummary[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const compact = React.useMemo(() => compactTokens(value), [value]);
  const catalog = React.useMemo(() => searchVibeSpaceEmojis(query), [query]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleLegacyTokens = legacyTokens.filter(
    (token) => !normalizedQuery || token.toLowerCase().includes(normalizedQuery),
  );
  const visibleUploads = uploads.filter((upload) =>
    upload.name.toLowerCase().includes(normalizedQuery),
  );

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void assetStore
      .list()
      .then((items) => {
        if (!cancelled) {
          setUploads((current) => {
            const byId = new Map(items.map((item) => [item.id, item]));
            for (const item of current) byId.set(item.id, item);
            return [...byId.values()].sort(
              (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
            );
          });
        }
      })
      .catch(() => {
        if (!cancelled) setError('Custom emoji storage is unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, [assetStore, open]);

  const select = React.useCallback(
    (token: string) => {
      onChange(token);
      setOpen(false);
      setQuery('');
      setError(null);
    },
    [onChange],
  );

  const handleOptionKey = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
    token: string,
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(token);
      return;
    }
    const columns = 8;
    const count = visibleLegacyTokens.length + catalog.length + visibleUploads.length;
    let next = index;
    if (event.key === 'ArrowRight') next = Math.min(count - 1, index + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') next = Math.min(count - 1, index + columns);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await assetStore.save(file, uploadedName(file), readDimensions);
      setUploads((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      onChange(saved.id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Custom emoji upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5" aria-label={`${label} quick choices`}>
        {compact.map((token) => {
          const definition = VIBESPACE_EMOJIS.find((emoji) => emoji.id === token);
          const name = definition?.name ?? 'Selected icon';
          return (
            <button
              key={token}
              type="button"
              aria-label={`Choose ${name}`}
              aria-pressed={value === token}
              onClick={() => onChange(token)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background transition-colors',
                'hover:border-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2',
                value === token && 'border-accent-cyan ring-1 ring-accent-cyan/60',
              )}
            >
              <EmojiMark token={token} className="h-7 w-7" assetStore={assetStore} />
            </button>
          );
        })}
        <button
          type="button"
          aria-label={`Open full ${label} picker`}
          aria-expanded={open}
          onClick={() => {
            setOpen((current) => !current);
            setError(null);
          }}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border bg-background text-muted-foreground hover:border-accent-cyan hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label={`Choose ${label}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute left-0 top-full z-50 mt-2 w-[min(390px,calc(100vw-3rem))] rounded-xl border border-border bg-elevated p-3 shadow-lift"
        >
          <div className="mb-3 flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                aria-label={`Search ${label}`}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                placeholder="Search 100 VibeSpace icons"
              />
            </label>
            <label className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold text-foreground hover:border-accent-cyan focus-within:ring-2 focus-within:ring-accent-cyan">
              <Upload aria-hidden="true" className="h-4 w-4" />
              {uploading ? 'Adding…' : 'Upload'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Upload custom emoji"
                className="sr-only"
                disabled={uploading}
                onChange={handleUpload}
              />
            </label>
            <button
              type="button"
              aria-label={`Close ${label} picker`}
              onClick={() => setOpen(false)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="mb-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <div
            role="listbox"
            aria-label={`${label} choices`}
            className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto pr-1"
          >
            {visibleLegacyTokens.map((token, index) => (
              <button
                key={`legacy:${token}`}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-label={`Existing ${label} ${token}`}
                aria-selected={value === token}
                title={`Existing ${label} ${token}`}
                tabIndex={index === 0 ? 0 : -1}
                onClick={() => select(token)}
                onKeyDown={(event) => handleOptionKey(event, index, token)}
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-transparent text-xl hover:border-accent-cyan focus-visible:border-accent-cyan focus-visible:outline-none"
              >
                <EmojiMark token={token} className="h-8 w-8" assetStore={assetStore} />
              </button>
            ))}
            {catalog.map((emoji, index) => (
              <button
                key={emoji.id}
                ref={(node) => {
                  optionRefs.current[visibleLegacyTokens.length + index] = node;
                }}
                type="button"
                role="option"
                aria-label={emoji.name}
                aria-selected={value === emoji.id}
                title={emoji.name}
                tabIndex={visibleLegacyTokens.length === 0 && index === 0 ? 0 : -1}
                onClick={() => select(emoji.id)}
                onKeyDown={(event) =>
                  handleOptionKey(event, visibleLegacyTokens.length + index, emoji.id)
                }
                className="flex h-10 w-10 items-center justify-center rounded-lg border border-transparent hover:border-accent-cyan focus-visible:border-accent-cyan focus-visible:outline-none"
              >
                <EmojiMark token={emoji.id} className="h-8 w-8" assetStore={assetStore} />
              </button>
            ))}
            {visibleUploads.map((upload, uploadIndex) => {
              const index = visibleLegacyTokens.length + catalog.length + uploadIndex;
              return (
                <button
                  key={upload.id}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-label={upload.name}
                  aria-selected={value === upload.id}
                  title={upload.name}
                  tabIndex={
                    visibleLegacyTokens.length === 0 && catalog.length === 0 && uploadIndex === 0
                      ? 0
                      : -1
                  }
                  onClick={() => select(upload.id)}
                  onKeyDown={(event) => handleOptionKey(event, index, upload.id)}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border border-transparent hover:border-accent-cyan focus-visible:border-accent-cyan focus-visible:outline-none"
                >
                  <EmojiMark token={upload.id} className="h-8 w-8" assetStore={assetStore} />
                </button>
              );
            })}
          </div>

          {visibleLegacyTokens.length === 0 &&
            catalog.length === 0 &&
            visibleUploads.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No matching icons.</p>
            )}
          <p className="mt-2 text-xs text-muted-foreground">
            PNG, JPEG, or WebP · 32–512 px · up to 256 KB
          </p>
        </div>
      )}
    </div>
  );
}

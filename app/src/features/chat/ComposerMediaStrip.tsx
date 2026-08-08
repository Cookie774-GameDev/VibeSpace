import { FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { isSupportedVideoPath } from './imageAttachments';

function mediaPreviewUrl(image: ChatImageAttachment): string {
  if (image.data.startsWith('data:')) return image.data;
  return `data:${image.mimeType};base64,${image.data}`;
}

function isFullVideoAttachment(image: ChatImageAttachment): boolean {
  return image.mimeType.startsWith('video/') || isSupportedVideoPath(image.name);
}

export function ComposerMediaStrip({
  images,
  files,
  onRemoveImage,
  onRemoveFile,
  onActivateFile,
  onActivateImage,
  compact = false,
}: {
  images: readonly ChatImageAttachment[];
  files: readonly string[];
  onRemoveImage: (id: string) => void;
  onRemoveFile: (path: string) => void;
  onActivateFile?: (path: string) => void;
  onActivateImage?: (image: ChatImageAttachment) => void;
  compact?: boolean;
}) {
  if (images.length === 0 && files.length === 0) return null;

  return (
    <div
      className={cn(
        'border-b border-border/70 bg-elevated/40',
        compact ? 'px-2 py-1.5' : 'px-2.5 py-2',
      )}
      data-composer-media-strip="true"
      aria-label="Attached media"
    >
      <div className="flex gap-2 overflow-x-auto pb-0.5">
        {images.map((image) => {
          const src = mediaPreviewUrl(image);
          const video = isFullVideoAttachment(image);
          return (
            <div
              key={image.id}
              role="button"
              tabIndex={0}
              className={cn(
                'group relative shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-background shadow-soft',
                compact ? 'h-16 w-16' : 'h-20 w-20',
              )}
              data-composer-media-preview={video ? 'video' : 'image'}
              onClick={() => onActivateImage?.(image)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onActivateImage?.(image);
                }
              }}
              title={image.name}
            >
              {video ? (
                <video
                  src={src}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  draggable={false}
                />
              ) : (
                <img
                  src={src}
                  alt={image.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              )}
              {video ? (
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/65 px-1 text-[10px] font-medium text-white">
                  Video
                </span>
              ) : null}
              <button
                type="button"
                className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white opacity-90 hover:bg-black"
                aria-label={`Remove ${image.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveImage(image.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
              <span className="sr-only">{image.name}</span>
            </div>
          );
        })}
        {files.map((path, index) => {
          const name = path.split(/[/\\]/).pop() ?? path;
          const video = isSupportedVideoPath(name);
          return (
            <button
              key={`${path}:${index}`}
              type="button"
              className={cn(
                'group relative flex shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-border bg-background shadow-soft',
                compact ? 'h-16 w-16' : 'h-20 w-20',
              )}
              data-composer-media-preview={video ? 'video-file' : 'file'}
              onClick={() => onActivateFile?.(path)}
              title={path}
            >
              <FileText className="h-6 w-6 text-muted-foreground" aria-hidden />
              <span className="max-w-full truncate px-1 text-[10px] text-muted-foreground">
                {name}
              </span>
              {video ? (
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/65 px-1 text-[10px] font-medium text-white">
                  Video
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={0}
                className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white opacity-90 hover:bg-black"
                aria-label={`Remove ${name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveFile(path);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onRemoveFile(path);
                  }
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

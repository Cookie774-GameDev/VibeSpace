import { describeFsError, readImageFileBase64 } from '@/lib/fs';
import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  imageMimeTypeForPath,
  isSupportedImagePath,
  type ChatImageAttachment,
} from '@/lib/ai/vision';

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SUPPORTED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/** Max media items kept on a single composer draft (multi drag/drop/paste). */
export const MAX_COMPOSER_MEDIA_ATTACHMENTS = 24;
/** Max images accepted from one FileList batch. */
export const MAX_IMAGES_PER_BATCH = 16;
/** Max full videos accepted from one FileList batch. */
export const MAX_VIDEOS_PER_BATCH = 8;
/** Full video byte cap (kept local as data URL for preview/send). */
export const VIDEO_ATTACHMENT_MAX_BYTES = 40 * 1024 * 1024;

export function isSupportedVideoMime(mimeType: string): boolean {
  return SUPPORTED_VIDEO_MIME_TYPES.has(mimeType);
}

export function isSupportedVideoPath(pathOrName: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(pathOrName);
}

export function splitVideoFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => {
    const mimeType = file.type || '';
    return isSupportedVideoMime(mimeType) || isSupportedVideoPath(file.name);
  });
}

/** Browser files that should attach as chat paths/media (not only images). */
export function splitAttachableFiles(files: FileList | File[]): {
  images: File[];
  videos: File[];
  other: File[];
} {
  const images = splitImageFiles(files);
  const videos = splitVideoFiles(files).filter((file) => !images.includes(file));
  const other = Array.from(files).filter(
    (file) => !images.includes(file) && !videos.includes(file),
  );
  return { images, videos, other };
}

/**
 * Desktop WebViews often expose an absolute `path` on OS File objects.
 * Browser-only File objects do not — callers must fall back to temp text attach.
 */
export function browserFileLocalPath(file: File): string | null {
  const candidate = file as File & { path?: unknown };
  if (typeof candidate.path === 'string') {
    const trimmed = candidate.path.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const TEXT_LIKE_MIME = /^(text\/|application\/(json|xml|javascript|x-javascript|sql|csv))/i;
const TEXT_LIKE_EXT =
  /\.(txt|md|markdown|json|csv|tsv|xml|ya?ml|toml|ini|log|js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|html|css|scss|less|sql|env|gitignore|dockerfile)$/i;

export function isTextLikeBrowserFile(file: File): boolean {
  if (file.type && TEXT_LIKE_MIME.test(file.type)) return true;
  return TEXT_LIKE_EXT.test(file.name || '');
}

export type ClassifiedBrowserAttachFiles = {
  images: File[];
  videos: File[];
  /** General files with a real local path (desktop drop). */
  pathFiles: Array<{ file: File; path: string }>;
  /** Text-like files without a path (clipboard/browser) → temp attach. */
  textWithoutPath: File[];
  /** Binary/other without a path — cannot attach honestly without redesign. */
  unsupportedWithoutPath: File[];
};

/** Pure classification for paste/drop FileList handling (shipped Composer entry). */
export function classifyBrowserFilesForAttach(
  files: FileList | File[],
): ClassifiedBrowserAttachFiles {
  const { images, videos, other } = splitAttachableFiles(files);
  const pathFiles: ClassifiedBrowserAttachFiles['pathFiles'] = [];
  const textWithoutPath: File[] = [];
  const unsupportedWithoutPath: File[] = [];
  for (const file of other) {
    const path = browserFileLocalPath(file);
    if (path) {
      pathFiles.push({ file, path });
      continue;
    }
    if (isTextLikeBrowserFile(file)) textWithoutPath.push(file);
    else unsupportedWithoutPath.push(file);
  }
  return { images, videos, pathFiles, textWithoutPath, unsupportedWithoutPath };
}

export async function readBrowserFileAsText(
  file: File,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(
      `File is too large to attach as text (max ${Math.round(maxBytes / 1024 / 1024)} MB).`,
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}

function mediaId(seed: string): string {
  // Always unique so multi-drop / multi-paste of the same file is allowed.
  return `media_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}_${Math.abs(hash(seed)).toString(36)}`;
}

function hash(value: string): number {
  let out = 0;
  for (let i = 0; i < value.length; i += 1) {
    out = Math.imul(31, out) + value.charCodeAt(i);
  }
  return out;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read media file.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? '' : dataUrl.slice(comma + 1);
}

export async function imageAttachmentFromBrowserFile(file: File): Promise<ChatImageAttachment> {
  const mimeType = file.type || imageMimeTypeForPath(file.name) || '';
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('Only PNG, JPG, WEBP, and GIF images are supported.');
  }
  if (file.size > IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new Error('Image is too large. Use an image under 8 MB.');
  }
  const dataUrl = await readFileAsDataUrl(file);
  const data = dataUrlToBase64(dataUrl);
  if (!data) throw new Error('Could not read image data.');
  return {
    id: mediaId(`${file.name}:${file.size}`),
    name: file.name || 'image',
    mimeType,
    data,
    size: file.size,
  };
}

/** Attach the full video (not frame samples) for multi drag/drop/paste. */
export async function videoAttachmentFromBrowserFile(file: File): Promise<ChatImageAttachment> {
  const mimeType = file.type || (isSupportedVideoPath(file.name) ? 'video/mp4' : '') || 'video/mp4';
  if (!isSupportedVideoMime(mimeType) && !isSupportedVideoPath(file.name)) {
    throw new Error('Only MP4, WEBM, and MOV videos are supported.');
  }
  if (file.size > VIDEO_ATTACHMENT_MAX_BYTES) {
    throw new Error('Video is too large. Use a clip under 40 MB.');
  }
  const dataUrl = await readFileAsDataUrl(file);
  const data = dataUrlToBase64(dataUrl);
  if (!data) throw new Error('Could not read video data.');
  const path = browserFileLocalPath(file) ?? undefined;
  return {
    id: mediaId(`${file.name}:${file.size}:video`),
    name: file.name || 'video',
    mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4',
    data,
    size: file.size,
    sourcePath: path,
  };
}

/** Append media without deduping so multi drops of the same file are kept. */
export function appendComposerMedia(
  current: readonly ChatImageAttachment[],
  next: readonly ChatImageAttachment[],
  max = MAX_COMPOSER_MEDIA_ATTACHMENTS,
): ChatImageAttachment[] {
  return [...current, ...next].slice(0, max);
}

export function appendComposerMediaResult(
  current: readonly ChatImageAttachment[],
  next: readonly ChatImageAttachment[],
  max = MAX_COMPOSER_MEDIA_ATTACHMENTS,
): { items: ChatImageAttachment[]; truncated: number } {
  const combined = [...current, ...next];
  if (combined.length <= max) return { items: combined, truncated: 0 };
  return { items: combined.slice(0, max), truncated: combined.length - max };
}

/** Build vision-safe LLM attachments: keep images; sample frames from full videos. */
export async function visionAttachmentsForSend(
  attachments: readonly ChatImageAttachment[],
): Promise<ChatImageAttachment[]> {
  const out: ChatImageAttachment[] = [];
  for (const item of attachments) {
    if (item.mimeType.startsWith('image/')) {
      out.push(item);
      continue;
    }
    if (!item.mimeType.startsWith('video/')) continue;
    try {
      const binary = atob(
        item.data.startsWith('data:') ? item.data.slice(item.data.indexOf(',') + 1) : item.data,
      );
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], item.name || 'video.mp4', { type: item.mimeType });
      const { extractVideoFramesAsImages } = await import('./videoAttachments');
      out.push(...(await extractVideoFramesAsImages(file, { maxFrames: 4 })));
    } catch {
      // Skip unreadable videos for the model path; UI still keeps the full clip.
    }
  }
  return out;
}

export async function imageAttachmentFromPath(path: string): Promise<ChatImageAttachment> {
  if (!isSupportedImagePath(path)) {
    throw new Error('Only PNG, JPG, WEBP, and GIF images are supported.');
  }
  const result = await readImageFileBase64(path);
  if (!result.ok) {
    throw new Error(describeFsError(result.error));
  }
  return {
    id: mediaId(`${path}:${result.size}`),
    name: path.split(/[/\\]/).pop() ?? path,
    mimeType: result.mimeType,
    data: result.data,
    sourcePath: path,
    size: result.size,
  };
}

export function splitImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => {
    const mimeType = file.type || imageMimeTypeForPath(file.name) || '';
    return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
  });
}

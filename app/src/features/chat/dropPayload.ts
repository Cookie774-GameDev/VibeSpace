import { CONTEXT_MIME } from '@/features/context/tree';

export const FILE_MIME = 'application/x-jarvis-file';
export const TERMINAL_MIME = 'application/x-jarvis-terminal';

export type ChatDropKind = 'context' | 'terminal' | 'file' | 'os-files';

export type ChatDropPayload =
  | { kind: 'context'; raw: string }
  | { kind: 'terminal'; raw: string }
  | { kind: 'file'; path: string };

type DataTransferLike = {
  types: readonly string[];
  getData(type: string): string;
  files?: FileList | null;
};

function hasType(types: readonly string[], type: string): boolean {
  return Array.from(types).includes(type);
}

/** True when the OS is dragging real filesystem files (photos, videos, docs). */
export function hasOsFileDrag(types: readonly string[]): boolean {
  // Chromium/Tauri report "Files"; Firefox often uses "application/x-moz-file".
  return (
    hasType(types, 'Files') ||
    hasType(types, 'application/x-moz-file') ||
    hasType(types, 'public.file-url')
  );
}

export function getChatDragKind(types: readonly string[]): ChatDropKind | null {
  if (hasType(types, CONTEXT_MIME)) return 'context';
  if (hasType(types, TERMINAL_MIME)) return 'terminal';
  // OS file drags must win over generic text/plain (which some desktops also set).
  if (hasOsFileDrag(types)) return 'os-files';
  if (hasType(types, FILE_MIME) || hasType(types, 'text/plain')) return 'file';
  return null;
}

export function getChatDropPayload(dataTransfer: DataTransferLike): ChatDropPayload | null {
  const { types } = dataTransfer;

  if (hasType(types, CONTEXT_MIME)) {
    const raw = dataTransfer.getData(CONTEXT_MIME);
    if (raw.trim()) return { kind: 'context', raw };
  }

  if (hasType(types, TERMINAL_MIME)) {
    const raw = dataTransfer.getData(TERMINAL_MIME);
    if (raw.trim()) return { kind: 'terminal', raw };
  }

  if (hasType(types, FILE_MIME)) {
    const path = dataTransfer.getData(FILE_MIME).trim();
    if (path) return { kind: 'file', path };
  }

  // Do not treat OS multi-file drops as a single text/plain path.
  if (!hasType(types, CONTEXT_MIME) && !hasType(types, TERMINAL_MIME) && !hasOsFileDrag(types)) {
    const path = dataTransfer.getData('text/plain').trim();
    if (path) return { kind: 'file', path };
  }

  return null;
}

export const MEDIA_ATTACH_EVENT = 'jarvis:media:attach';

export type MediaAttachDetail = {
  chatId?: string;
  files: File[];
};

export function dispatchMediaAttach(chatId: string, files: FileList | File[]): void {
  const list = Array.from(files);
  if (list.length === 0) return;
  window.dispatchEvent(
    new CustomEvent<MediaAttachDetail>(MEDIA_ATTACH_EVENT, {
      detail: { chatId: String(chatId), files: list },
    }),
  );
}

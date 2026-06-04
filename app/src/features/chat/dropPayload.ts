import { CONTEXT_MIME } from '@/features/context/tree';

export const FILE_MIME = 'application/x-jarvis-file';
export const TERMINAL_MIME = 'application/x-jarvis-terminal';

export type ChatDropKind = 'context' | 'terminal' | 'file';

export type ChatDropPayload =
  | { kind: 'context'; raw: string }
  | { kind: 'terminal'; raw: string }
  | { kind: 'file'; path: string };

type DataTransferLike = {
  types: readonly string[];
  getData(type: string): string;
};

function hasType(types: readonly string[], type: string): boolean {
  return Array.from(types).includes(type);
}

export function getChatDragKind(types: readonly string[]): ChatDropKind | null {
  if (hasType(types, CONTEXT_MIME)) return 'context';
  if (hasType(types, TERMINAL_MIME)) return 'terminal';
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

  if (!hasType(types, CONTEXT_MIME) && !hasType(types, TERMINAL_MIME)) {
    const path = dataTransfer.getData('text/plain').trim();
    if (path) return { kind: 'file', path };
  }

  return null;
}

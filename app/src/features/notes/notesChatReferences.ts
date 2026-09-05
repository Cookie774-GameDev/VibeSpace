import type { Part } from '@/types';

export interface ChatNoteReference {
  projectId: string;
  scopeHash: string;
  id: string;
  title: string;
}

/** Decode only Notes references; other context/file attachments retain their existing UI. */
export function parseChatNoteReference(part: Part): ChatNoteReference | null {
  if (
    part.kind !== 'file_ref' ||
    part.ref.kind !== 'memory' ||
    !part.ref.id.startsWith('context:p')
  )
    return null;
  let remaining = part.ref.id.slice('context:p'.length);
  const field = () => {
    const prefix = /^(\d+):/u.exec(remaining);
    if (!prefix) return null;
    const length = Number(prefix[1]);
    remaining = remaining.slice(prefix[0].length);
    if (!Number.isSafeInteger(length) || length < 1 || length > remaining.length) return null;
    const value = remaining.slice(0, length);
    remaining = remaining.slice(length);
    return value;
  };
  const projectId = field();
  const mapId = field();
  const nodeId = field();
  const note = /^notes:([a-f0-9]{24}):(.+)$/u.exec(mapId ?? '');
  if (!projectId || !note || nodeId !== `note:${note[2]}` || remaining !== 'note') return null;
  return {
    projectId,
    scopeHash: note[1],
    id: note[2],
    title: part.ref.excerpt?.replace(/^Context: /u, '') || 'Untitled note',
  };
}

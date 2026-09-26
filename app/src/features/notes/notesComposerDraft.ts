import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { noteScopeKey, sameNoteScope, type NoteReference, type NoteScope } from './notesContracts';

type ComposerDraft = { text: string; references: NoteReference[] };

const STORAGE_PREFIX = 'vibespace:composer-draft:v1:';
const MAX_DRAFT_LENGTH = 500_000;
const drafts = new Map<string, ComposerDraft>();

function storageForDrafts(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function notesComposerKey(scope: NoteScope | null, chatId: string): string {
  if (!chatId) return '';
  if (scope) return JSON.stringify([noteScopeKey(scope), chatId]);

  // Chats outside a project still need their own account/workspace-scoped draft.
  const auth = useAuthStore.getState();
  const accountId = resolveAccountIdentity(auth)?.accountId;
  return accountId && auth.workspaceId
    ? JSON.stringify([accountId, String(auth.workspaceId), '', chatId])
    : '';
}

function safeReferences(value: unknown, scope: NoteScope | null): NoteReference[] {
  if (!scope || !Array.isArray(value)) return [];
  return value
    .filter(
      (ref): ref is NoteReference =>
        !!ref &&
        typeof ref === 'object' &&
        typeof ref.id === 'string' &&
        typeof ref.title === 'string' &&
        typeof ref.revision === 'string' &&
        typeof ref.accountId === 'string' &&
        typeof ref.projectId === 'string' &&
        sameNoteScope(ref, scope),
    )
    .map((ref) => ({ ...ref }));
}

export function readNotesComposerDraft(scope: NoteScope | null, chatId: string): ComposerDraft {
  const key = notesComposerKey(scope, chatId);
  if (!key) return { text: '', references: [] };
  let draft = drafts.get(key);
  if (!draft) {
    try {
      const raw = storageForDrafts()?.getItem(STORAGE_PREFIX + key);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (
          saved &&
          typeof saved === 'object' &&
          'text' in saved &&
          typeof saved.text === 'string' &&
          saved.text.length <= MAX_DRAFT_LENGTH
        ) {
          draft = {
            text: saved.text,
            references: safeReferences('references' in saved ? saved.references : [], scope),
          };
          drafts.set(key, draft);
        }
      }
    } catch {
      // Storage may be unavailable while the app is starting; keep the in-memory draft.
    }
  }
  return {
    text: draft?.text ?? '',
    references: draft?.references.map((ref) => ({ ...ref })) ?? [],
  };
}

export function checkpointNotesComposer(
  scope: NoteScope | null,
  chatId: string,
  text: string,
  references: readonly NoteReference[],
): void {
  const key = notesComposerKey(scope, chatId);
  if (
    !key ||
    text.length > MAX_DRAFT_LENGTH ||
    references.some((ref) => !scope || !sameNoteScope(ref, scope))
  )
    return;

  const storage = storageForDrafts();
  if (!text && references.length === 0) {
    drafts.delete(key);
    try {
      storage?.removeItem(STORAGE_PREFIX + key);
    } catch {
      // The live composer can still be cleared when storage is unavailable.
    }
    return;
  }

  const draft = { text, references: references.map((ref) => ({ ...ref })) };
  drafts.set(key, draft);
  try {
    storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
  } catch {
    // Keep the current session's draft even if durable storage is temporarily full.
  }
}

/** Carry an unfinished message into a newly created chat without erasing its original copy. */
export function copyNotesComposerDraft(
  scope: NoteScope | null,
  sourceChatId: string,
  destinationChatId: string,
): void {
  if (!sourceChatId || !destinationChatId || sourceChatId === destinationChatId) return;
  const source = readNotesComposerDraft(scope, sourceChatId);
  if (!source.text && source.references.length === 0) return;
  const destination = readNotesComposerDraft(scope, destinationChatId);
  if (destination.text || destination.references.length > 0) return;
  checkpointNotesComposer(scope, destinationChatId, source.text, source.references);
}

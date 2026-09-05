import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import type { Message } from '@/types';
import { parseChatNoteReference, type ChatNoteReference } from './notesChatReferences';
import { currentNoteScope, openNoteReference } from './notesRuntime';
import { noteDigest, noteScopeKey } from './notesContracts';

async function openReference(reference: ChatNoteReference) {
  try {
    const scope = currentNoteScope();
    if (
      !scope ||
      scope.projectId !== reference.projectId ||
      (await noteDigest(noteScopeKey(scope))).slice(0, 24) !== reference.scopeHash
    ) {
      throw new Error('Return to this note’s account and project to open it.');
    }
    openNoteReference({ ...scope, id: reference.id });
  } catch (error) {
    toast.error('Cannot open note', error instanceof Error ? error.message : 'Please retry.');
  }
}

export function NotesSessionReferences({ messages }: { messages: readonly Message[] }) {
  const references = useMemo(() => {
    const unique = new Map<string, ChatNoteReference>();
    for (const message of messages) {
      if (message.role !== 'user') continue;
      for (const part of message.parts) {
        const reference = parseChatNoteReference(part);
        if (reference) unique.set(`${reference.scopeHash}:${reference.id}`, reference);
      }
    }
    return [...unique.values()];
  }, [messages]);
  if (!references.length) return null;
  return (
    <section aria-label="Referenced notes" className="border-t border-border/60 pt-3">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        Referenced notes · {references.length}
      </h3>
      <div className="flex flex-col gap-1">
        {references.map((reference) => (
          <Button
            key={`${reference.scopeHash}:${reference.id}`}
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => void openReference(reference)}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{reference.title}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

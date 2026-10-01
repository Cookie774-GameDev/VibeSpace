import * as React from 'react';
import { toast } from '@/components/ui/toast';
import { chatRepo } from '@/lib/db';
import type { ChatId } from '@/types';

interface UseChatTitleEditorOptions {
  chatId: ChatId;
  title: string;
}

/** Shared, ID-preserving inline title editor for main and Pet chat surfaces. */
export function useChatTitleEditor({ chatId, title }: UseChatTitleEditorOptions) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(title);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const currentChatIdRef = React.useRef(chatId);
  const observedTitleRef = React.useRef(title);
  const saveSequenceRef = React.useRef(0);
  const savingRef = React.useRef(false);

  React.useEffect(() => {
    if (currentChatIdRef.current !== chatId) {
      currentChatIdRef.current = chatId;
      observedTitleRef.current = title;
      saveSequenceRef.current += 1;
      savingRef.current = false;
      setSaving(false);
      setEditing(false);
      setDraft(title);
      return;
    }

    if (observedTitleRef.current !== title) {
      observedTitleRef.current = title;
      if (!editing) setDraft(title);
    }
  }, [chatId, editing, title]);

  React.useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = React.useCallback(() => {
    if (savingRef.current || editing) return;
    setDraft(title);
    setEditing(true);
  }, [editing, title]);

  const cancel = React.useCallback(() => {
    if (savingRef.current) return;
    setDraft(title);
    setEditing(false);
  }, [title]);

  const commit = React.useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;

    const nextTitle = draft.trim();
    if (!nextTitle) {
      toast.warning('Title required', 'Chat titles cannot be empty.');
      setEditing(true);
      return false;
    }

    if (nextTitle === title.trim()) {
      setDraft(title);
      setEditing(false);
      return true;
    }

    const targetChatId = chatId;
    const saveSequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = saveSequence;
    savingRef.current = true;
    setSaving(true);

    try {
      await chatRepo.update(targetChatId, { title: nextTitle });
      if (currentChatIdRef.current === targetChatId && saveSequenceRef.current === saveSequence) {
        setDraft(nextTitle);
        setEditing(false);
      }
      return true;
    } catch (error) {
      if (currentChatIdRef.current === targetChatId && saveSequenceRef.current === saveSequence) {
        setEditing(true);
        toast.error('Could not rename', error instanceof Error ? error.message : 'Try again.');
      }
      return false;
    } finally {
      if (saveSequenceRef.current === saveSequence) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [chatId, draft, title]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    },
    [cancel, commit],
  );

  return {
    editing,
    draft,
    saving,
    inputRef,
    setDraft,
    startEditing,
    cancel,
    commit,
    handleKeyDown,
  };
}

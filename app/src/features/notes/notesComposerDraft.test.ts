import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointNotesComposer,
  copyNotesComposerDraft,
  notesComposerKey,
  readNotesComposerDraft,
} from './notesComposerDraft';
import type { NoteScope } from './notesContracts';

const scope: NoteScope = { accountId: 'draft-account', projectId: 'draft-project' };

beforeEach(() => {
  window.localStorage.clear();
});

describe('chat composer drafts', () => {
  it('retains ordinary text in each chat after a module reload', async () => {
    checkpointNotesComposer(scope, 'draft-chat-one', 'A long unfinished first message', []);
    checkpointNotesComposer(scope, 'draft-chat-two', 'Another unfinished message', []);

    vi.resetModules();
    const restarted = await import('./notesComposerDraft');
    expect(restarted.readNotesComposerDraft(scope, 'draft-chat-one').text).toBe(
      'A long unfinished first message',
    );
    expect(restarted.readNotesComposerDraft(scope, 'draft-chat-two').text).toBe(
      'Another unfinished message',
    );
    expect(
      restarted.readNotesComposerDraft(
        { accountId: 'another-account', projectId: scope.projectId },
        'draft-chat-one',
      ).text,
    ).toBe('');
  });

  it('copies an unsent draft into a new chat while preserving the original', () => {
    checkpointNotesComposer(scope, 'draft-copy-source', 'Keep this paragraph', []);
    copyNotesComposerDraft(scope, 'draft-copy-source', 'draft-copy-destination');

    expect(readNotesComposerDraft(scope, 'draft-copy-source').text).toBe('Keep this paragraph');
    expect(readNotesComposerDraft(scope, 'draft-copy-destination').text).toBe(
      'Keep this paragraph',
    );
  });

  it('clears a sent draft without affecting other chats', () => {
    checkpointNotesComposer(scope, 'draft-sent', 'Message to send', []);
    checkpointNotesComposer(scope, 'draft-keep', 'Still composing', []);
    checkpointNotesComposer(scope, 'draft-sent', '', []);

    expect(readNotesComposerDraft(scope, 'draft-sent').text).toBe('');
    expect(readNotesComposerDraft(scope, 'draft-keep').text).toBe('Still composing');
    expect(
      window.localStorage.getItem(
        `vibespace:composer-draft:v1:${notesComposerKey(scope, 'draft-sent')}`,
      ),
    ).toBeNull();
  });
});

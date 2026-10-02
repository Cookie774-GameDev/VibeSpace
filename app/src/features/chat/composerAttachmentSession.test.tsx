import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';
import { useComposerAttachmentSession } from './composerAttachmentSession';

const fixture = vi.hoisted(() => ({ empty: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _d: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('./useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'missing' }),
}));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('composer private attachment view lifetime', () => {
  it('restores complete files and image bytes after a view unmount without browser storage', () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderHook(() => useComposerAttachmentSession('attachment/account/workspace/project/chat'));
    const image = { id: 'synthetic-image', name: 'fixture.png', mimeType: 'image/png', data: 'c3ludGhldGlj' };
    act(() => {
      first.result.current.setAttachedFiles(['C:/fixture/notes.txt']);
      first.result.current.setAttachedImages([image]);
    });
    first.unmount();
    const reopened = renderHook(() => useComposerAttachmentSession('attachment/account/workspace/project/chat'));
    expect(reopened.result.current.attachments.files).toEqual(['C:/fixture/notes.txt']);
    expect(reopened.result.current.attachments.images).toEqual([image]);
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    reopened.unmount();
  });

  it('changes chat without transferring chips and restores each original draft independently', () => {
    const view = renderHook(({ scope }) => useComposerAttachmentSession(scope), {
      initialProps: { scope: 'attachment/switch/account/project/chat-a' },
    });
    act(() => view.result.current.setAttachedFiles(['C:/fixture/a.txt']));
    view.rerender({ scope: 'attachment/switch/account/project/chat-b' });
    expect(view.result.current.attachments.files).toEqual([]);
    act(() => view.result.current.setAttachedFiles(['C:/fixture/b.txt']));
    view.rerender({ scope: 'attachment/switch/account/project/chat-a' });
    expect(view.result.current.attachments.files).toEqual(['C:/fixture/a.txt']);
    view.unmount();
  });

  it('isolates account, workspace and project even when the chat identifier is identical', () => {
    const first = renderHook(() => useComposerAttachmentSession('attachment/account-a/workspace-a/project-a/same-chat'));
    act(() => first.result.current.setAttachedFiles(['C:/fixture/private.txt']));
    for (const scope of [
      'attachment/account-b/workspace-a/project-a/same-chat',
      'attachment/account-a/workspace-b/project-a/same-chat',
      'attachment/account-a/workspace-a/project-b/same-chat',
    ]) {
      const other = renderHook(() => useComposerAttachmentSession(scope));
      expect(other.result.current.attachments.files).toEqual([]);
      other.unmount();
    }
    first.unmount();
  });

  it('binds a late file-picker result to its original chat rather than the current view', () => {
    const view = renderHook(({ scope }) => useComposerAttachmentSession(scope), {
      initialProps: { scope: 'attachment/late/old' },
    });
    const finishOriginalPicker = view.result.current.setAttachedFiles;
    view.rerender({ scope: 'attachment/late/new' });
    act(() => view.result.current.setAttachedFiles(['C:/fixture/new.txt']));
    act(() => finishOriginalPicker(files => [...files, 'C:/fixture/old.txt']));
    expect(view.result.current.attachments.files).toEqual(['C:/fixture/new.txt']);
    view.rerender({ scope: 'attachment/late/old' });
    expect(view.result.current.attachments.files).toEqual(['C:/fixture/old.txt']);
    view.unmount();
  });

  it('clears accepted attachments for every mount while retaining other chats', () => {
    const first = renderHook(() => useComposerAttachmentSession('attachment/accepted/chat'));
    const second = renderHook(() => useComposerAttachmentSession('attachment/accepted/chat'));
    const other = renderHook(() => useComposerAttachmentSession('attachment/accepted/other'));
    act(() => {
      first.result.current.setAttachedFiles(['C:/fixture/submitted.txt']);
      other.result.current.setAttachedFiles(['C:/fixture/unsent.txt']);
    });
    expect(second.result.current.attachments.files).toHaveLength(1);
    act(() => first.result.current.setAttachedFiles([]));
    expect(second.result.current.attachments.files).toEqual([]);
    expect(other.result.current.attachments.files).toEqual(['C:/fixture/unsent.txt']);
    first.unmount(); second.unmount(); other.unmount();
  });

  it('keeps actual Composer chips and its complete large draft with their original chat on switch and reopen', async () => {
    const originalAuth = useAuthStore.getState();
    useAuthStore.setState({ localUserId: 'attachment-component-user' as never, cloudSession: null,
      workspaceId: 'attachment-component-workspace' as never, projectId: 'attachment-component-project' as never,
      chatModelSelection: { mode: 'none' } });
    const draft = '  Native synthetic multiline draft — 東京\n' + 'Preserve every complete line.\n'.repeat(3500);
    const composer = (chatId: string) => <TooltipProvider><Composer chatId={chatId} /></TooltipProvider>;
    const attach = (chatId: string, path: string) => act(() => {
      window.dispatchEvent(new CustomEvent('jarvis:file:attach', { detail: { chatId, path } }));
    });
    try {
      const view = render(composer('attachment-component-chat-a'));
      attach('attachment-component-chat-a', 'C:/fixture/a.txt');
      await screen.findByRole('button', { name: 'Remove a.txt' });
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: draft } });
      view.rerender(composer('attachment-component-chat-b'));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove a.txt' })).toBeNull());
      attach('attachment-component-chat-b', 'C:/fixture/b.txt');
      await screen.findByRole('button', { name: 'Remove b.txt' });
      view.rerender(composer('attachment-component-chat-a'));
      await screen.findByRole('button', { name: 'Remove a.txt' });
      expect(screen.queryByRole('button', { name: 'Remove b.txt' })).toBeNull();
      await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(draft));
      expect(draft).toHaveLength(105040);
      view.unmount();
      render(composer('attachment-component-chat-a'));
      await screen.findByRole('button', { name: 'Remove a.txt' });
      expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(draft);
    } finally { useAuthStore.setState(originalAuth); }
  });
});

import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import type { Message } from '@/types';
import { clearRedoStack, peekRedoDepth, popRedoTurn } from '@/features/chat/chatUndoRedo';
import { Composer } from '@/features/chat/Composer';

const LARGE_DRAFT =
  '  Native synthetic multiline draft — 東京\n' + 'Preserve every complete line.\n'.repeat(3500);
const LARGE_DRAFT_SHA256 = '8f2fceda614b93895d9b51d1ea3e91a4165b49a97e98686d4626ef52c0085fb0';

function expectLargeDraft(input: HTMLTextAreaElement) {
  expect(input.value).toHaveLength(105040);
  expect(input.value).toBe(LARGE_DRAFT);
  expect(createHash('sha256').update(input.value).digest('hex')).toBe(LARGE_DRAFT_SHA256);
}

const fixture = vi.hoisted(() => ({ empty: [] as unknown[] }));

it('removes only the submitted undo command and preserves its complete large draft remainder', async () => {
  clearRedoStack('draft-undo-preservation');
  const history = [{
    id: 'combined-owned-user', chat_id: 'draft-undo-preservation', role: 'user',
    parts: [{ kind: 'text', text: '/connect' }], created_at: 1, updated_at: 1,
  }, {
    id: 'combined-owned-receipt', chat_id: 'draft-undo-preservation', role: 'system',
    parts: [{ kind: 'text', text: 'Opened Providers.' }], created_at: 2, updated_at: 2,
  }] as Message[];
  vi.spyOn(messageRepo, 'listByChat').mockResolvedValue(history);
  const remove = vi.spyOn(messageRepo, 'delete').mockResolvedValue(undefined);
  render(<TooltipProvider><Composer chatId={'draft-undo-preservation' as never} /></TooltipProvider>);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/undo\n' + LARGE_DRAFT } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(remove.mock.calls).toEqual(history.map(message => [message.id])));
  await waitFor(() => expect(document.querySelector('[data-slash-command-state="succeeded"]')).not.toBeNull());
  expect(peekRedoDepth('draft-undo-preservation')).toBe(1);
  expectLargeDraft(input);
});
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _d: unknown, fallback: unknown) =>
    Array.isArray(fallback) && fallback.length === 0 ? fixture.empty : fallback,
}));
vi.mock('@/features/chat/useChatBackendAffinity', () => ({ useChatBackendAffinity: () => undefined }));
vi.mock('@/features/chat/HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('@/features/chat/HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'missing' }),
}));

const originalAuth = useAuthStore.getState();
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useAuthStore.setState({
    localUserId: 'draft-test-user' as never,
    cloudSession: null,
    workspaceId: 'draft-test-workspace' as never,
    projectId: 'draft-test-project' as never,
    chatModelSelection: { mode: 'none' },
  });
  vi.spyOn(messageRepo, 'create').mockResolvedValue({ id: 'draft-test-message' } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.setState(originalAuth);
  clearRedoStack('draft-undo-preservation');
});

it('preserves a large multiline draft when an immediate command is selected at its end', async () => {
  render(
    <TooltipProvider>
      <Composer chatId={'draft-command-preservation' as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: LARGE_DRAFT + '/connect' } });
  expect(input.value).toHaveLength(105048);
  expect(createHash('sha256').update(input.value).digest('hex')).toBe(
    'b99d5635731a8daf2752ab76147bc8075e2d6e096ff1f1702c357a78a176ca26',
  );
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.keyUp(input, { key: 't' });
  await waitFor(() =>
    expect(
      document.querySelector('[role="option"][data-value="vibespace:vibespace:connect"]'),
    ).not.toBeNull(),
  );
  const option = document.querySelector(
    '[role="option"][data-value="vibespace:vibespace:connect"]',
  )!;
  fireEvent.click(option);
  await waitFor(() => expectLargeDraft(input));
  await waitFor(() =>
    expect(['succeeded', 'failed', 'cancelled']).toContain(
      document.querySelector('[data-slash-command-state]')?.getAttribute('data-slash-command-state'),
    ),
  );
  expectLargeDraft(input);
});

it('does not erase a newer draft when an asynchronous local result settles', async () => {
  let finish!: (value: never) => void;
  vi.mocked(messageRepo.create).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <TooltipProvider>
      <Composer chatId={'draft-async-preservation' as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/performance status' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(messageRepo.create).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: LARGE_DRAFT } });
  finish({ id: 'draft-result' } as never);
  await waitFor(() =>
    expect(document.querySelector('[data-slash-command-state="succeeded"]')).not.toBeNull(),
  );
  expectLargeDraft(input);
});

it('restores text-only drafts when the same composer changes chats', async () => {
  const view = render(
    <TooltipProvider>
      <Composer chatId={'draft-first-chat' as never} />
    </TooltipProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: LARGE_DRAFT },
  });
  view.rerender(
    <TooltipProvider>
      <Composer chatId={'draft-second-chat' as never} />
    </TooltipProvider>,
  );
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      '',
    ),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'Second chat draft' },
  });
  view.rerender(
    <TooltipProvider>
      <Composer chatId={'draft-first-chat' as never} />
    </TooltipProvider>,
  );
  await waitFor(() =>
    expectLargeDraft(screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement),
  );
});

it('preserves the exact large draft while undo removes the prior complete turn and retains redo', async () => {
  clearRedoStack('draft-undo-preservation');
  render(
    <TooltipProvider>
      <Composer chatId={'draft-undo-preservation' as never} />
    </TooltipProvider>,
  );
  const history: Message[] = [
    {
      id: 'draft-prior-user' as Message['id'],
      chat_id: 'draft-undo-preservation' as Message['chat_id'],
      role: 'user',
      parts: [{ kind: 'text', text: 'Previous user turn.' }],
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 'draft-prior-assistant' as Message['id'],
      chat_id: 'draft-undo-preservation' as Message['chat_id'],
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Previous complete reply.' }],
      created_at: 2,
      updated_at: 2,
    },
  ];
  let finish!: (messages: Message[]) => void;
  const readHistory = vi.spyOn(messageRepo, 'listByChat').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const removeMessage = vi.spyOn(messageRepo, 'delete').mockResolvedValue(undefined);
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '/undo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(readHistory).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: LARGE_DRAFT } });
  finish(history);
  await waitFor(() =>
    expect(document.querySelector('[data-slash-command-state="succeeded"]')).not.toBeNull(),
  );
  expect(removeMessage.mock.calls).toEqual(history.map(message => [message.id]));
  expect(peekRedoDepth('draft-undo-preservation')).toBe(1);
  expect(popRedoTurn('draft-undo-preservation')?.messages).toEqual(history);
  expectLargeDraft(input);
});

it('restores the exact large draft after remount and isolates a different account in the same chat', async () => {
  const view = render(
    <TooltipProvider>
      <Composer chatId={'draft-account-preservation' as never} />
    </TooltipProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: LARGE_DRAFT },
  });
  act(() => useAuthStore.setState({ localUserId: 'draft-test-other-user' as never }));
  await waitFor(() =>
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(''),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'Other account draft.' },
  });
  act(() => useAuthStore.setState({ localUserId: 'draft-test-user' as never }));
  await waitFor(() =>
    expectLargeDraft(screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement),
  );
  view.unmount();
  render(
    <TooltipProvider>
      <Composer chatId={'draft-account-preservation' as never} />
    </TooltipProvider>,
  );
  expectLargeDraft(screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement);
});



import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { Composer } from './Composer';

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
});

it('preserves a large multiline draft when an immediate command is selected at its end', async () => {
  render(
    <TooltipProvider>
      <Composer chatId={'draft-command-preservation' as never} />
    </TooltipProvider>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  const draft =
    '  Native synthetic multiline draft — 東京\n' + 'Preserve every complete line.\n'.repeat(3500);
  fireEvent.change(input, { target: { value: draft + '/connect' } });
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
  await waitFor(() => expect(input.value).toBe(draft));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(input.value).toBe(draft);
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
  fireEvent.change(input, { target: { value: 'A newer unsent draft\nKeep all of it.' } });
  finish({ id: 'draft-result' } as never);
  await waitFor(() =>
    expect(document.querySelector('[data-slash-command-state="succeeded"]')).not.toBeNull(),
  );
  expect(input.value).toBe('A newer unsent draft\nKeep all of it.');
});

it('restores text-only drafts when the same composer changes chats', async () => {
  const view = render(
    <TooltipProvider>
      <Composer chatId={'draft-first-chat' as never} />
    </TooltipProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
    target: { value: 'First chat\nA full unsent draft' },
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
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
      'First chat\nA full unsent draft',
    ),
  );
});

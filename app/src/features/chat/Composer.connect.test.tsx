import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { db, messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { getChatActivityEvents } from './activity/activityStore';
import { Composer } from './Composer';

const liveQueryFixture = vi.hoisted(() => ({ emptyArray: [] as unknown[] }));
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_query: unknown, _deps: unknown, defaultValue: unknown) =>
    Array.isArray(defaultValue) && defaultValue.length === 0
      ? liveQueryFixture.emptyArray
      : defaultValue,
}));
vi.mock('./HarnessReadinessGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HarnessReadinessGate')>();
  return {
    ...actual,
    useHarnessRuntimeState: () => ({
      kind: 'ready' as const,
      source: 'managed' as const,
      version: 'test-runtime',
    }),
  };
});

const originalAuth = useAuthStore.getState();

function renderComposer() {
  return render(
    <TooltipProvider>
      <Composer chatId={'chat-connect' as never} />
    </TooltipProvider>,
  );
}

describe('Composer secure /connect integration', () => {
  beforeEach(async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    sessionStorage.clear();
    useAuthStore.setState({
      workspaceId: 'workspace-1' as never,
      projectId: 'project-1' as never,
    });
    useUIStore.setState({ settingsOpen: false, activeChatId: 'chat-connect' as never });
    await db.messages
      .where('chat_id')
      .equals('chat-connect' as never)
      .delete();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    useAuthStore.setState({
      workspaceId: originalAuth.workspaceId,
      projectId: originalAuth.projectId,
    });
  });

  it('discovers and keyboard-selects bare /connect as an immediate local Providers action', async () => {
    const create = vi.spyOn(messageRepo, 'create');
    const modelSend = vi.fn();
    window.addEventListener('jarvis:send', modelSend);
    const activityBefore = getChatActivityEvents('chat-connect').length;
    renderComposer();
    create.mockClear();

    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '/conn', selectionStart: 5 } });
    const option = await screen.findByRole('option', { name: /\/connect/i });
    expect(screen.getByRole('combobox', { name: 'Message' })).toBe(input);
    expect(input.getAttribute('aria-controls')).toBe(option.closest('[role="listbox"]')?.id);
    await waitFor(() => expect(option.getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(useUIStore.getState().settingsOpen).toBe(true));
    await waitFor(async () => {
      const rows = await messageRepo.list({ chat_id: 'chat-connect' as never });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe('user');
      expect(rows[0]?.parts).toEqual([
        { kind: 'text', text: '/connect' },
        { kind: 'local_command_receipt', version: 1, modelDispatch: 'skipped', receipts: [{ commandId: expect.any(String), status: 'completed' }] },
      ]);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(modelSend).not.toHaveBeenCalled();
    expect(getChatActivityEvents('chat-connect')).toHaveLength(activityBefore);
    window.removeEventListener('jarvis:send', modelSend);
  });

  it('opens and persists one exact provider focus without sending Chat text', async () => {
    const create = vi.spyOn(messageRepo, 'create');
    const providerEvents: string[] = [];
    const onFocus = (event: Event) => {
      providerEvents.push(
        (event as CustomEvent<{ providerId?: string }>).detail?.providerId ?? 'missing',
      );
    };
    window.addEventListener('jarvis:settings:provider', onFocus);
    renderComposer();
    create.mockClear();

    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '  /connect openrouter  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(useUIStore.getState().settingsOpen).toBe(true));
    expect(sessionStorage.getItem('vibespace.settings.provider-focus.v1')).toBe('openrouter');
    await waitFor(() => expect(providerEvents).toEqual(['openrouter']));
    await waitFor(async () => {
      const rows = await messageRepo.list({ chat_id: 'chat-connect' as never });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe('user');
      expect(rows[0]?.parts).toEqual([
        { kind: 'text', text: '  /connect openrouter  ' },
        { kind: 'local_command_receipt', version: 1, modelDispatch: 'skipped', receipts: [{ commandId: expect.any(String), status: 'completed' }] },
      ]);
    });
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );
    expect(create).toHaveBeenCalledTimes(1);
    window.removeEventListener('jarvis:settings:provider', onFocus);
  });

  it('rejects credential-like connect text once without echo, authority access, or transcript', async () => {
    const create = vi.spyOn(messageRepo, 'create');
    const warning = vi.spyOn(toast, 'warning');
    renderComposer();
    create.mockClear();
    const input = screen.getByRole('textbox', { name: 'Message' });

    fireEvent.change(input, { target: { value: '/connect sk-private' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        'Invalid command',
        'Choose one supported provider in Settings.',
      ),
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sk-private');
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(useUIStore.getState().settingsOpen).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});

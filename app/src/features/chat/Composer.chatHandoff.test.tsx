import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Message } from '@/types/chat';
import { chatRepo, messageRepo } from '@/lib/db';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { GROQ_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { VIBESPACE_CHAT_MIME } from './chatDragPayload';
import {
  Composer,
  buildComposerChatHandoffPayload,
  buildQueuedComposerChatHandoff,
  composerChatHandoffDeliveryKey,
  createComposerQueuedMessage,
  deliverComposerChatHandoff,
  dispatchComposerSendWithAcceptance,
  resolveComposerChatHandoffDraft,
  resolveComposerPersistedText,
  shouldClearComposerHandoff,
} from './Composer';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';

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

const sourceChat: Chat = {
  id: 'chat-source' as Chat['id'],
  workspace_id: 'workspace-1' as Chat['workspace_id'],
  project_id: 'project-1' as NonNullable<Chat['project_id']>,
  title: 'Canonical source title',
  mode: 'chat',
  active_agent_ids: [],
  created_at: 1,
  updated_at: 2,
};
const targetChat: Chat = {
  ...sourceChat,
  id: 'chat-target' as Chat['id'],
  title: 'Target',
};
const message = (text: string, updatedAt = 99): Message => ({
  id: `message-${updatedAt}` as Message['id'],
  chat_id: sourceChat.id,
  role: 'assistant',
  parts: [{ kind: 'text', text }],
  created_at: updatedAt,
  updated_at: updatedAt,
});
const projection: ChatHandoffProjectionV1 = {
  version: 1,
  policyVersion: 1,
  source: {
    chatId: 'chat-source',
    title: 'Source chat',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
  },
  snapshotAt: 100,
  boundaryAt: 10,
  boundaryMessageId: 'message-1',
  goal: 'Finish Task 2',
  status: 'Last visible assistant activity',
  lastMeaningfulActivity: 'Projection is green.',
  recentSections: [
    {
      messageId: 'message-1',
      role: 'assistant',
      createdAt: 99,
      visibleText: 'Projection is green.',
      chunks: ['Projection is green.'],
    },
  ],
  olderDigest: 'No older visible history.',
  summaries: { files: [], tools: [], actions: [], decisions: [], blockers: [], results: [] },
};
const originalAuth = useAuthStore.getState();

function enableTestModel() {
  setDiscoveredConnectionModels(GROQ_API_CONNECTION.id, [
    {
      id: 'llama-3.3-70b-versatile',
      label: 'Llama 3.3 70B Versatile',
      source: 'provider_list',
      lastVerifiedAt: 1,
    },
  ]);
  useAuthStore.setState({
    apiKeys: { groq: 'test-provider-key' },
    offlineMode: false,
    stackPreset: 'off',
    chatModelSelection: selectionFromOption('groq', 'llama-3.3-70b-versatile', GROQ_API_CONNECTION),
  });
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
  resetDiscoveredConnectionModelsForTests();
  useAuthStore.setState({
    apiKeys: originalAuth.apiKeys,
    offlineMode: originalAuth.offlineMode,
    stackPreset: originalAuth.stackPreset,
    chatModelSelection: originalAuth.chatModelSelection,
  });
});

describe('Composer chat handoff integration', () => {
  it('re-resolves canonical source/messages, rejects self/stale drops, replaces without sending', async () => {
    const dispatch = vi.fn();
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce([message('First canonical snapshot')])
      .mockResolvedValueOnce([message('Replacement canonical snapshot', 100)]);
    const getChat = vi.fn(async (id: string) =>
      id === 'chat-source' ? sourceChat : id === 'chat-target' ? targetChat : undefined,
    );
    const deps = { getChat, listMessages, canAccess: () => true };
    const payload = {
      version: 1 as const,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Stale display title',
    };

    const first = await resolveComposerChatHandoffDraft(
      { payload, targetChatId: 'chat-target', now: 101 },
      deps,
    );
    const replacement = await resolveComposerChatHandoffDraft(
      { payload, targetChatId: 'chat-target', now: 102 },
      deps,
    );
    const self = await resolveComposerChatHandoffDraft(
      { payload, targetChatId: 'chat-source', now: 103 },
      deps,
    );
    const stale = await resolveComposerChatHandoffDraft(
      { payload: { ...payload, workspaceId: 'stale-workspace' }, targetChatId: 'chat-target' },
      deps,
    );

    expect(first).toMatchObject({ ok: true, projection: { source: { title: sourceChat.title } } });
    expect(replacement).toMatchObject({
      ok: true,
      projection: { lastMeaningfulActivity: 'Replacement canonical snapshot' },
    });
    expect(self).toEqual({ ok: false, reason: 'same_chat' });
    expect(stale).toEqual({ ok: false, reason: 'chat_unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('captures an immutable queued handoff snapshot before later draft replacement', () => {
    const queued = buildQueuedComposerChatHandoff({
      projection,
      instruction: 'Use the accepted snapshot.',
      draftText: 'Continue A.',
    });
    const later = buildComposerChatHandoffPayload({
      projection: { ...projection, source: { ...projection.source, title: 'Replacement' } },
      instruction: 'Use replacement.',
      draftText: 'Continue B.',
    });

    expect(queued.text).toContain('Continue A.');
    expect(queued.text).not.toContain('Continue B.');
    expect(queued.payload.part.handoff.sourceTitle).toBe('Source chat');
    expect(later.part.handoff.sourceTitle).toBe('Replacement');
  });

  it('creates a real queue item for a handoff-only draft and rejects an ordinary empty draft', () => {
    const handoffOnly = createComposerQueuedMessage({
      draft: '',
      flushMode: 'after-run',
      handoff: {
        projection,
        instruction: 'Use the default instruction.',
      },
      now: 100,
      id: 'queued-handoff',
    });
    const ordinaryEmpty = createComposerQueuedMessage({
      draft: '',
      flushMode: 'after-run',
      handoff: null,
      now: 100,
      id: 'queued-empty',
    });

    expect(handoffOnly?.message).toMatchObject({
      id: 'queued-handoff',
      text: 'Handoff from Source chat',
    });
    expect(handoffOnly?.payload?.part.kind).toBe('chat_handoff');
    expect(handoffOnly?.visibleHandoffKey).toBe(
      composerChatHandoffDeliveryKey(
        buildComposerChatHandoffPayload({
          projection,
          instruction: 'Use the default instruction.',
          draftText: '',
        }),
      ),
    );
    expect(ordinaryEmpty).toBeNull();
  });

  it('uses the complete canonical handoff as the delivery idempotency key', () => {
    const first = buildComposerChatHandoffPayload({
      projection,
      instruction: 'Continue.',
      draftText: '',
    });
    const changed = buildComposerChatHandoffPayload({
      projection: { ...projection, status: 'Different canonical status' },
      instruction: 'Continue.',
      draftText: '',
    });

    expect(composerChatHandoffDeliveryKey(first)).not.toBe(composerChatHandoffDeliveryKey(changed));
  });

  it('clears an exact submitted queued handoff but preserves a newer visible card', () => {
    expect(
      shouldClearComposerHandoff({
        submittedHandoffKey: 'queued-handoff',
        currentVisibleHandoffKey: 'queued-handoff',
        handoffPayloadProvided: true,
      }),
    ).toBe(true);
    expect(
      shouldClearComposerHandoff({
        submittedHandoffKey: 'queued-handoff',
        currentVisibleHandoffKey: 'replacement-handoff',
        handoffPayloadProvided: true,
      }),
    ).toBe(false);
  });

  it('redacts credentials typed into the editable instruction before persistence', () => {
    const stripeFixture = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_');
    const githubFixture = `ghp_${'1234567890abcdefghijklmnopqrstuv'}`;
    const payload = buildComposerChatHandoffPayload({
      projection,
      instruction: `Use ${stripeFixture}.`,
      draftText: `Then inspect ${githubFixture}.`,
    });

    expect(JSON.stringify(payload)).not.toMatch(/sk_live_|ghp_123/);
    expect(payload.part.handoff.instruction).toContain('[REDACTED]');
  });

  it('persists once, preserves a dispatch receipt on failure, and clears only after retry acceptance', async () => {
    const failedPersistDispatch = vi.fn<() => Promise<void>>();
    const failedPersist = await deliverComposerChatHandoff({
      key: 'handoff-persist-failure',
      persist: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
      dispatch: failedPersistDispatch,
    });
    const persist = vi.fn(async () => ({ id: 'message-1' }));
    const dispatch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('runtime unavailable'))
      .mockResolvedValueOnce(undefined);
    const first = await deliverComposerChatHandoff({ key: 'handoff-1', persist, dispatch });
    const retry = await deliverComposerChatHandoff({
      key: 'handoff-1',
      previousReceipt: first.receipt,
      persist,
      dispatch,
    });

    expect(failedPersist).toMatchObject({ ok: false, receipt: null });
    expect(failedPersistDispatch).not.toHaveBeenCalled();
    expect(first.ok).toBe(false);
    expect(first.receipt?.value).toEqual({ id: 'message-1' });
    expect(retry.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('preserves canonical handoff prompt text instead of temporary oversized summaries', () => {
    const canonical = `handoff ${'x'.repeat(30_000)}`;
    expect(
      resolveComposerPersistedText({
        sendText: canonical,
        handoff: true,
        oversizedSummary: 'Temporary attachment summary',
      }),
    ).toBe(canonical);
  });

  it('acknowledges success, rejects early runtime errors, and times out a missing listener', async () => {
    vi.useFakeTimers();
    const accepted = dispatchComposerSendWithAcceptance(
      { chatId: 'chat-target', cancellationKey: 'message-1', text: 'safe' },
      { timeoutMs: 100 },
    );
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', {
        detail: { chatId: 'chat-target', cancellationKey: 'other-message', status: 'running' },
      }),
    );
    let settled = false;
    void accepted.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', {
        detail: { chatId: 'chat-target', cancellationKey: 'message-1', status: 'running' },
      }),
    );
    await expect(accepted).resolves.toBeUndefined();

    const rejected = dispatchComposerSendWithAcceptance(
      { chatId: 'chat-target', cancellationKey: 'message-2', text: 'safe' },
      { timeoutMs: 100 },
    );
    window.dispatchEvent(
      new CustomEvent('jarvis:run-state', {
        detail: { chatId: 'chat-target', cancellationKey: 'message-2', status: 'error' },
      }),
    );
    await expect(rejected).rejects.toThrow('rejected before acceptance');

    const missing = dispatchComposerSendWithAcceptance(
      { chatId: 'chat-target', cancellationKey: 'message-3', text: 'safe' },
      { timeoutMs: 100 },
    );
    const missingExpectation = expect(missing).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(100);
    await missingExpectation;
  });

  it('renders Composer, resolves a real drop, replaces the card, and never auto-sends', async () => {
    useUIStore.setState({ activeChatId: 'chat-target' });
    const create = vi.spyOn(messageRepo, 'create');
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) =>
      String(id) === 'chat-source' ? sourceChat : targetChat,
    );
    let sourceRead = 0;
    vi.spyOn(messageRepo, 'listByChat').mockImplementation(async (id) => {
      if (String(id) !== 'chat-source') return [];
      sourceRead += 1;
      return sourceRead === 1
        ? [message('First rendered snapshot')]
        : [message('Replacement rendered snapshot', 100)];
    });
    const send = vi.fn();
    const warning = vi.spyOn(toast, 'warning');
    window.addEventListener('jarvis:send', send);
    const payload = JSON.stringify({
      version: 1,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Untrusted display title',
    });
    const dataTransfer = {
      types: [VIBESPACE_CHAT_MIME],
      files: [],
      getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? payload : ''),
    };

    const { container } = render(
      <TooltipProvider>
        <Composer chatId="chat-target" />
      </TooltipProvider>,
    );
    const dropZone = container.querySelector('[data-composer-drop-zone="true"]');
    expect(dropZone).not.toBeNull();
    const selfPayload = JSON.stringify({
      version: 1,
      chatId: 'chat-target',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Target',
    });
    fireEvent.drop(dropZone!, {
      dataTransfer: {
        ...dataTransfer,
        getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? selfPayload : ''),
      },
    });
    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        'That chat is already here',
        'Choose a different source chat.',
      ),
    );
    expect(screen.queryByLabelText('Pending handoff from Target')).toBeNull();

    fireEvent.drop(dropZone!, { dataTransfer });
    fireEvent.click(await screen.findByRole('button', { name: 'Reference Canonical source title' }));
    expect(await screen.findByText(/First rendered snapshot/)).not.toBeNull();
    expect(screen.getByText('Canonical source title')).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    fireEvent.drop(dropZone!, { dataTransfer });
    await waitFor(() => expect(screen.getByText(/Replacement rendered snapshot/)).not.toBeNull());
    expect(screen.queryByText(/First rendered snapshot/)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    window.removeEventListener('jarvis:send', send);
  });

  it('persists one canonical handoff part, preserves the rendered card on dispatch failure, and retries without duplicate persistence', async () => {
    enableTestModel();
    useUIStore.setState({ activeChatId: 'chat-target' });
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) =>
      String(id) === 'chat-source' ? sourceChat : targetChat,
    );
    vi.spyOn(messageRepo, 'listByChat').mockResolvedValue([
      message('Rendered persistence snapshot'),
    ]);
    const persisted: Message = {
      id: 'persisted-handoff' as Message['id'],
      chat_id: targetChat.id,
      role: 'user',
      parts: [],
      created_at: 200,
      updated_at: 200,
    };
    const create = vi.spyOn(messageRepo, 'create').mockImplementation(async (input) => ({
      ...persisted,
      parts: input.parts,
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: Array<{ chatId: string; cancellationKey: string; text: string }> = [];
    const onSend = (event: Event) => {
      const detail = (
        event as CustomEvent<{ chatId: string; cancellationKey: string; text: string }>
      ).detail;
      sent.push(detail);
      window.dispatchEvent(
        new CustomEvent('jarvis:run-state', {
          detail: {
            chatId: detail.chatId,
            cancellationKey: detail.cancellationKey,
            status: sent.length === 1 ? 'error' : 'running',
          },
        }),
      );
    };
    window.addEventListener('jarvis:send', onSend);
    const payload = JSON.stringify({
      version: 1,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Untrusted display title',
    });
    const dataTransfer = {
      types: [VIBESPACE_CHAT_MIME],
      files: [],
      getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? payload : ''),
    };

    const { container } = render(
      <TooltipProvider>
        <Composer chatId="chat-target" />
      </TooltipProvider>,
    );
    const dropZone = container.querySelector('[data-composer-drop-zone="true"]');
    fireEvent.drop(dropZone!, { dataTransfer });
    fireEvent.click(await screen.findByRole('button', { name: 'Reference Canonical source title' }));
    await screen.findByText(/Rendered persistence snapshot/);
    fireEvent.change(screen.getByLabelText('Instruction for Canonical source title'), {
      target: { value: 'Continue with the rendered editable instruction.' },
    });
    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(sendButton);
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText('Pending handoff from Canonical source title')).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    const firstParts = create.mock.calls[0]?.[0].parts ?? [];
    expect(firstParts.filter((part) => part.kind === 'chat_handoff')).toHaveLength(1);
    expect(firstParts[0]).toMatchObject({ kind: 'text' });
    expect(JSON.stringify(firstParts)).toContain('Rendered persistence snapshot');
    expect(JSON.stringify(firstParts)).toContain(
      'Continue with the rendered editable instruction.',
    );

    fireEvent.click(sendButton);
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByLabelText('Pending handoff from Canonical source title')).toBeNull(),
    );
    expect(create).toHaveBeenCalledTimes(1);
    window.removeEventListener('jarvis:send', onSend);
  });

  it('clears a successful rendered handoff after inline draft normalization', async () => {
    enableTestModel();
    useUIStore.setState({ activeChatId: 'chat-target' });
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) =>
      String(id) === 'chat-source' ? sourceChat : targetChat,
    );
    vi.spyOn(messageRepo, 'listByChat').mockResolvedValue([message('Normalized draft snapshot')]);
    const create = vi.spyOn(messageRepo, 'create').mockImplementation(async (input) => ({
      id: 'persisted-normalized' as Message['id'],
      chat_id: targetChat.id,
      role: 'user',
      parts: input.parts,
      created_at: 201,
      updated_at: 201,
    }));
    const sent: Array<{ chatId: string; cancellationKey: string; text: string }> = [];
    const onSend = (event: Event) => {
      const detail = (
        event as CustomEvent<{ chatId: string; cancellationKey: string; text: string }>
      ).detail;
      sent.push(detail);
      window.dispatchEvent(
        new CustomEvent('jarvis:run-state', {
          detail: { ...detail, status: 'running' },
        }),
      );
    };
    window.addEventListener('jarvis:send', onSend);
    const payload = JSON.stringify({
      version: 1,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Untrusted display title',
    });
    const dataTransfer = {
      types: [VIBESPACE_CHAT_MIME],
      files: [],
      getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? payload : ''),
    };

    const { container } = render(
      <TooltipProvider>
        <Composer chatId="chat-target" />
      </TooltipProvider>,
    );
    const dropZone = container.querySelector('[data-composer-drop-zone="true"]');
    fireEvent.drop(dropZone!, { dataTransfer });
    fireEvent.click(await screen.findByRole('button', { name: 'Reference Canonical source title' }));
    await screen.findByText(/Normalized draft snapshot/);
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Continue safely after normalization /clearfiles' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0]?.[0].parts)).toContain(
      'Continue safely after normalization',
    );
    expect(JSON.stringify(create.mock.calls[0]?.[0].parts)).not.toContain('/clearfiles');
    await waitFor(() =>
      expect(screen.queryByLabelText('Pending handoff from Canonical source title')).toBeNull(),
    );
    window.removeEventListener('jarvis:send', onSend);
  });

  it('clears only the exact submitted rendered card after acceptance', async () => {
    enableTestModel();
    useUIStore.setState({ activeChatId: 'chat-target' });
    vi.spyOn(chatRepo, 'getById').mockImplementation(async (id) =>
      String(id) === 'chat-source' ? sourceChat : targetChat,
    );
    let sourceRead = 0;
    vi.spyOn(messageRepo, 'listByChat').mockImplementation(async (id) => {
      if (String(id) !== 'chat-source') return [];
      sourceRead += 1;
      return sourceRead === 1
        ? [message('Original submitted card')]
        : [message('Newer replacement card', 100)];
    });
    let persistedId = 0;
    const create = vi.spyOn(messageRepo, 'create').mockImplementation(async (input) => {
      persistedId += 1;
      return {
        id: `persisted-${persistedId}` as Message['id'],
        chat_id: targetChat.id,
        role: 'user',
        parts: input.parts,
        created_at: 200 + persistedId,
        updated_at: 200 + persistedId,
      };
    });
    const sent: Array<{ chatId: string; cancellationKey: string }> = [];
    const onSend = (event: Event) => {
      sent.push((event as CustomEvent<{ chatId: string; cancellationKey: string }>).detail);
    };
    window.addEventListener('jarvis:send', onSend);
    const payload = JSON.stringify({
      version: 1,
      chatId: 'chat-source',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      title: 'Untrusted display title',
    });
    const dataTransfer = {
      types: [VIBESPACE_CHAT_MIME],
      files: [],
      getData: (type: string) => (type === VIBESPACE_CHAT_MIME ? payload : ''),
    };

    const { container } = render(
      <TooltipProvider>
        <Composer chatId="chat-target" />
      </TooltipProvider>,
    );
    const dropZone = container.querySelector('[data-composer-drop-zone="true"]');
    fireEvent.drop(dropZone!, { dataTransfer });
    fireEvent.click(await screen.findByRole('button', { name: 'Reference Canonical source title' }));
    await screen.findByText(/Original submitted card/);
    const sendButton = screen.getByRole('button', { name: 'Send message' });
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton);
    await waitFor(() => expect(sent).toHaveLength(1));

    fireEvent.drop(dropZone!, { dataTransfer });
    await screen.findByText(/Newer replacement card/);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('jarvis:run-state', {
          detail: { ...sent[0], status: 'running' },
        }),
      );
    });
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/Newer replacement card/)).not.toBeNull();
    expect(screen.queryByLabelText('Pending handoff from Canonical source title')).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    window.removeEventListener('jarvis:send', onSend);
  });
});

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JarvisCommandCenterProvider,
  type JarvisCommandCenterBinding,
} from '@/features/jarvis-command-center/JarvisCommandCenter';
import {
  acknowledgeJarvisApprovalNavigation,
  readPendingJarvisApprovalNavigation,
  requestJarvisApprovalNavigation,
  resetJarvisApprovalNavigationForTests,
} from '@/features/jarvis-command-center/approvalNavigation';
import type { JarvisRun } from '@/features/jarvis-command-center/types';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import type { Message } from '@/types';
import { ChatThread } from './ChatThread';

const hookState = vi.hoisted(() => ({ messages: [] as Message[] }));

vi.mock('./hooks', () => ({ useChatMessages: () => hookState.messages }));
vi.mock('./MessageBubble', () => ({ MessageBubble: () => <div>message</div> }));
vi.mock('./activity', () => ({
  ChatActivityTimeline: () => <div data-testid="legacy-timeline">Legacy timeline</div>,
  useUnifiedChatActivity: () => [],
}));
vi.mock('@/features/jarvis-interaction/AgentActivityCard', () => ({
  ChatAgentActivityPanel: () => <div data-testid="agent-panel">Agent panel</div>,
}));
vi.mock('@/features/jarvis-runs/JarvisTaskProgressCard', () => ({
  JarvisTaskProgressCard: () => <div data-testid="legacy-progress">Legacy progress</div>,
}));
vi.mock('@/features/jarvis-memory/JarvisMemoryStatus', () => ({
  JarvisMemoryStatus: () => <div data-testid="memory-status">Memory</div>,
}));
vi.mock('@/lib/jarvis/smoke/config', () => ({ isKernelSmokeEnabled: () => true }));

function canonicalRun({
  id = 'jrun-direct-1',
  accountId = 'account-1',
  chatId = 'chat-1',
  status = 'running',
}: {
  id?: string;
  accountId?: string;
  chatId?: string;
  status?: JarvisRun['status'];
} = {}): JarvisRun {
  return {
    id,
    accountId,
    chatId,
    source: 'typed_chat',
    status,
    agentId: 'jarvis',
    identityVersion: 1,
    profileRevisionId: 'profile-1',
    model: {
      providerId: 'provider-1',
      modelId: 'model-1',
      connectionMode: 'native-api',
      capabilities: {},
      capturedAt: 90,
    },
    createdAt: 100,
    updatedAt: 100,
  };
}

function binding(
  runs: readonly JarvisRun[] = [],
  accountId = 'account-1',
): JarvisCommandCenterBinding {
  const liveEvidence = {
    accountId,
    snapshot: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  } as JarvisCommandCenterBinding['hostPort']['liveEvidence'];
  return {
    hostPort: {
      accountId,
      liveEvidence,
      requestCancellation: vi.fn(async () => ({
        kind: 'authority_revoked_before_intent' as const,
      })),
      retryScheduledTransport: vi.fn(async () => ({
        kind: 'account_authority_revoked' as const,
      })),
      retryLogicalRun: vi.fn(async () => ({ kind: 'account_authority_revoked' as const })),
    },
    dataPort: {
      getRunsForChat: vi.fn(async () => runs),
      getEventsForRun: vi.fn(async ({ runId }) => {
        const selected = runs.find((run) => run.id === runId);
        return selected?.status === 'awaiting_approval'
          ? [
              {
                runId,
                seq: 1,
                idempotencyKey: 'approval-1',
                type: 'approval' as const,
                status: 'pending',
                title: 'Approval pending',
                sourceRefs: [],
                artifactIds: [],
                createdAt: 105,
              },
            ]
          : [];
      }),
      getArtifactsForRun: vi.fn(async () => []),
      getLiveEvidenceSnapshot: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    },
  };
}

function setReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('ChatThread Command Center routing', () => {
  beforeEach(() => {
    setReducedMotion(false);
    hookState.messages = [];
    useJarvisTaskRunStore.getState().clearForTests();
    useJarvisTaskRunStore.getState().setAccountScope('scope-1');
    resetJarvisApprovalNavigationForTests();
  });
  afterEach(() => useJarvisTaskRunStore.getState().clearForTests());

  it('keeps canonical execution without mounting Command Center or working media in chat', async () => {
    useJarvisTaskRunStore.getState().replaceCanonicalForAccount(
      'scope-1',
      [
        {
          canonical: true,
          runId: 'run-1',
          chatId: 'chat-1',
          status: 'running',
          goal: 'Do the work',
          userVisibleSummary: 'Working',
          progress: 50,
          activeAgents: [],
          activeTerminals: [],
          updatedAt: new Date(100).toISOString(),
          cancellable: true,
          transportRetryAvailable: false,
        },
      ],
      {},
    );

    const currentBinding = binding();
    render(
      <JarvisCommandCenterProvider value={currentBinding}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    await vi.waitFor(() => expect(currentBinding.dataPort.getRunsForChat).toHaveBeenCalled());
    expect(screen.queryByText('Command Center')).toBeNull();
    expect(document.querySelector('[data-chat-working]')).toBeNull();
    expect(screen.queryByTestId('legacy-timeline')).toBeNull();
    expect(screen.queryByTestId('legacy-progress')).toBeNull();
    expect(screen.getByTestId('agent-panel')).not.toBeNull();
    expect(screen.getByTestId('memory-status')).not.toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBe('chat.run-shell');
    expect(screen.getByRole('log').getAttribute('data-sik-assistant-count')).toBe('0');
    expect(document.querySelectorAll('[data-sik-evidence="chat.runtime-ready"]')).toHaveLength(1);
  });

  it('exposes only the assistant message count on the isolated canonical chat shell', async () => {
    hookState.messages = [
      {
        id: 'message-user' as Message['id'],
        chat_id: 'chat-1' as Message['chat_id'],
        role: 'user',
        parts: [],
        created_at: 90,
        updated_at: 90,
      },
      {
        id: 'message-assistant' as Message['id'],
        chat_id: 'chat-1' as Message['chat_id'],
        role: 'assistant',
        parts: [],
        created_at: 100,
        updated_at: 100,
      },
    ];

    render(
      <JarvisCommandCenterProvider value={binding([canonicalRun()])}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByRole('log').getAttribute('data-sik-assistant-count')).toBe('1');
    });
    expect(screen.queryByText('Command Center')).toBeNull();
    expect(document.querySelector('[data-chat-working]')).toBeNull();
    const shell = screen.getByRole('log');
    expect(shell.getAttribute('data-sik-assistant-count')).toBe('1');
    expect(shell.outerHTML).not.toContain('message-user');
    expect(shell.outerHTML).not.toContain('message-assistant');
  });

  it('keeps timeline and progress for legacy history and does not render the canonical shell', () => {
    useJarvisTaskRunStore.getState().replaceLegacyForAccount('scope-1', [
      {
        id: 'legacy-1',
        chatId: 'chat-1',
        goal: 'Legacy work',
        status: 'running',
        steps: [],
        progress: 10,
        activeAgents: [],
        activeTerminals: [],
        userVisibleSummary: 'Legacy working',
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(100).toISOString(),
      },
    ]);

    render(
      <JarvisCommandCenterProvider value={undefined}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    expect(screen.queryByTestId('legacy-timeline')).toBeNull();
    expect(screen.getByTestId('legacy-progress')).not.toBeNull();
    expect(screen.queryByText('Command Center')).toBeNull();
    expect(document.querySelector('[data-chat-working]')).toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-assistant-count')).toBeNull();
    expect(document.querySelector('[data-sik-evidence="chat.runtime-ready"]')).toBeNull();
  });

  it('agentic chatting with messages does not stack a second classic mini command center', async () => {
    hookState.messages = [
      {
        id: 'message-user' as Message['id'],
        chat_id: 'chat-1' as Message['chat_id'],
        role: 'user',
        parts: [{ kind: 'text', text: 'Hello Jarvis' }],
        created_at: 90,
        updated_at: 90,
      },
      {
        id: 'message-assistant' as Message['id'],
        chat_id: 'chat-1' as Message['chat_id'],
        role: 'assistant',
        parts: [{ kind: 'text', text: 'Hello — staying on this chat.' }],
        created_at: 100,
        updated_at: 100,
      },
    ];

    render(
      <JarvisCommandCenterProvider value={undefined}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    // Agentic success path: AgenticConsole owns the single mini command center.
    // Classic ChatActivityTimeline must not also mount (would double jarvis-session-panel).
    expect(screen.queryByTestId('legacy-timeline')).toBeNull();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="jarvis-session-panel"]').length).toBe(1);
    });
    expect(document.querySelector('[data-agentic-console]')).not.toBeNull();
  });

  it('discovers a canonical run from the account-bound data port without a legacy projection', async () => {
    render(
      <JarvisCommandCenterProvider value={binding([canonicalRun()])}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBe('chat.run-shell');
    });
    expect(screen.queryByText('Command Center')).toBeNull();
    expect(screen.queryByTestId('legacy-timeline')).toBeNull();
    expect(screen.queryByTestId('legacy-progress')).toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBe('chat.run-shell');
  });

  it('rejects data-port rows that do not match the bound account and chat scope', async () => {
    const crossScopeBinding = binding([
      canonicalRun({ accountId: 'account-other', chatId: 'chat-other' }),
    ]);
    render(
      <JarvisCommandCenterProvider value={crossScopeBinding}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    await vi.waitFor(() => {
      expect(crossScopeBinding.dataPort.getRunsForChat).toHaveBeenCalledOnce();
    });
    await act(async () => undefined);
    expect(screen.queryByText('Command Center')).toBeNull();
    expect(screen.getByTestId('legacy-progress')).not.toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBeNull();
  });

  it('quarantines direct-run presence when the account-bound data port is replaced', async () => {
    const firstBinding = binding([canonicalRun()]);
    const replacementBinding = binding([], 'account-2');
    const view = render(
      <JarvisCommandCenterProvider value={firstBinding}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );
    await vi.waitFor(() => expect(firstBinding.dataPort.getRunsForChat).toHaveBeenCalled());
    expect(screen.queryByText('Command Center')).toBeNull();

    view.rerender(
      <JarvisCommandCenterProvider value={replacementBinding}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );

    expect(screen.queryByText('Command Center')).toBeNull();
    expect(screen.getByTestId('legacy-progress')).not.toBeNull();
    expect(screen.getByRole('log').getAttribute('data-sik-evidence')).toBeNull();
  });

  it('reveals and focuses only the pending canonical approval in its bound account and chat', async () => {
    render(
      <JarvisCommandCenterProvider
        value={binding([canonicalRun({ id: 'run-1', status: 'awaiting_approval' })])}
      >
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );
    const log = screen.getByRole('log');
    const oldCard = document.createElement('div');
    oldCard.dataset.approvalKind = 'canonical';
    oldCard.dataset.approvalId = 'approval-old';
    oldCard.dataset.status = 'pending';
    oldCard.tabIndex = -1;
    oldCard.scrollIntoView = vi.fn();
    log.append(oldCard);

    act(() => {
      expect(
        requestJarvisApprovalNavigation({
          accountId: 'account-other',
          chatId: 'chat-1',
          runId: 'run-1',
          approvalId: 'approval-1',
        }),
      ).toBe(true);
    });
    expect(oldCard.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(oldCard);
    act(() => {
      expect(
        acknowledgeJarvisApprovalNavigation({
          accountId: 'account-other',
          chatId: 'chat-1',
          runId: 'run-1',
          approvalId: 'approval-1',
        }),
      ).toBe(true);
    });

    act(() => {
      requestJarvisApprovalNavigation({
        accountId: 'account-1',
        chatId: 'chat-1',
        runId: 'run-1',
        approvalId: 'approval-1',
      });
    });
    const exactCard = document.createElement('div');
    exactCard.dataset.approvalKind = 'canonical';
    exactCard.dataset.approvalId = 'approval-1';
    exactCard.dataset.status = 'pending';
    exactCard.tabIndex = -1;
    exactCard.scrollIntoView = vi.fn();
    act(() => log.append(exactCard));

    await vi.waitFor(() => expect(document.activeElement).toBe(exactCard), { timeout: 5_000 });
    expect(exactCard.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
    expect(oldCard.scrollIntoView).not.toHaveBeenCalled();
    expect(readPendingJarvisApprovalNavigation()).toBeUndefined();
  });

  it('uses non-animated approval navigation when reduced motion is preferred', async () => {
    setReducedMotion(true);
    render(
      <JarvisCommandCenterProvider
        value={binding([canonicalRun({ id: 'run-1', status: 'awaiting_approval' })])}
      >
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );
    const card = document.createElement('div');
    card.dataset.approvalKind = 'canonical';
    card.dataset.approvalId = 'approval-1';
    card.dataset.status = 'pending';
    card.tabIndex = -1;
    card.scrollIntoView = vi.fn();
    act(() => screen.getByRole('log').append(card));

    act(() => {
      requestJarvisApprovalNavigation({
        accountId: 'account-1',
        chatId: 'chat-1',
        runId: 'run-1',
        approvalId: 'approval-1',
      });
    });

    await vi.waitFor(() => expect(document.activeElement).toBe(card), { timeout: 5_000 });
    expect(card.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
    });
  });

  it('rejects a same-account and same-chat target when its run does not own the approval', async () => {
    render(
      <JarvisCommandCenterProvider
        value={binding([canonicalRun({ id: 'run-1', status: 'awaiting_approval' })])}
      >
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );
    const card = document.createElement('div');
    card.dataset.approvalKind = 'canonical';
    card.dataset.approvalId = 'approval-1';
    card.dataset.status = 'pending';
    card.tabIndex = -1;
    card.scrollIntoView = vi.fn();
    act(() => screen.getByRole('log').append(card));

    act(() => {
      requestJarvisApprovalNavigation({
        accountId: 'account-1',
        chatId: 'chat-1',
        runId: 'run-other',
        approvalId: 'approval-1',
      });
    });

    await vi.waitFor(
      () =>
        expect(readPendingJarvisApprovalNavigation()).toEqual({
          accountId: 'account-1',
          chatId: 'chat-1',
          runId: 'run-other',
          approvalId: 'approval-1',
        }),
      { timeout: 5_000 },
    );
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(card);
  });

  it('rejects a stale approval card from the current run when a newer approval is pending', async () => {
    const commandCenterBinding = binding([
      canonicalRun({ id: 'run-1', status: 'awaiting_approval' }),
    ]);
    vi.mocked(commandCenterBinding.dataPort.getEventsForRun).mockResolvedValue([
      {
        runId: 'run-1',
        seq: 1,
        idempotencyKey: 'approval-1',
        type: 'approval',
        status: 'pending',
        title: 'Earlier approval',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 105,
      },
      {
        runId: 'run-1',
        seq: 2,
        idempotencyKey: 'approval-2',
        type: 'approval',
        status: 'pending',
        title: 'Current approval',
        sourceRefs: [],
        artifactIds: [],
        createdAt: 110,
      },
    ]);
    render(
      <JarvisCommandCenterProvider value={commandCenterBinding}>
        <ChatThread chatId="chat-1" />
      </JarvisCommandCenterProvider>,
    );
    const card = document.createElement('div');
    card.dataset.approvalKind = 'canonical';
    card.dataset.approvalId = 'approval-1';
    card.dataset.status = 'pending';
    card.tabIndex = -1;
    card.scrollIntoView = vi.fn();
    act(() => screen.getByRole('log').append(card));

    act(() => {
      requestJarvisApprovalNavigation({
        accountId: 'account-1',
        chatId: 'chat-1',
        runId: 'run-1',
        approvalId: 'approval-1',
      });
    });

    await vi.waitFor(() =>
      expect(commandCenterBinding.dataPort.getEventsForRun).toHaveBeenCalledWith({
        accountId: 'account-1',
        runId: 'run-1',
        limit: 500,
      }),
    );
    expect(card.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(card);
    expect(readPendingJarvisApprovalNavigation()).toEqual({
      accountId: 'account-1',
      chatId: 'chat-1',
      runId: 'run-1',
      approvalId: 'approval-1',
    });
  });

  it('allows only one matching mounted thread to claim a navigation target', async () => {
    const commandCenterBinding = binding([
      canonicalRun({ id: 'run-1', status: 'awaiting_approval' }),
    ]);
    render(
      <>
        <JarvisCommandCenterProvider value={commandCenterBinding}>
          <ChatThread chatId="chat-1" />
        </JarvisCommandCenterProvider>
        <JarvisCommandCenterProvider value={commandCenterBinding}>
          <ChatThread chatId="chat-1" />
        </JarvisCommandCenterProvider>
      </>,
    );
    const cards = screen.getAllByRole('log').map((log) => {
      const card = document.createElement('div');
      card.dataset.approvalKind = 'canonical';
      card.dataset.approvalId = 'approval-1';
      card.dataset.status = 'pending';
      card.tabIndex = -1;
      card.scrollIntoView = vi.fn();
      act(() => log.append(card));
      return card;
    });

    act(() => {
      requestJarvisApprovalNavigation({
        accountId: 'account-1',
        chatId: 'chat-1',
        runId: 'run-1',
        approvalId: 'approval-1',
      });
    });

    await vi.waitFor(
      () =>
        expect(
          cards.reduce(
            (count, card) =>
              count + (card.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length,
            0,
          ),
        ).toBe(1),
      { timeout: 5_000 },
    );
    expect(cards.filter((card) => document.activeElement === card)).toHaveLength(1);
    expect(readPendingJarvisApprovalNavigation()).toBeUndefined();
  });
});

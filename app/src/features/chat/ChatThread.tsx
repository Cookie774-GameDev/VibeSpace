import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChatMessages } from './hooks';
import { MessageBubble } from './MessageBubble';
import { ChatActivityTimeline, useUnifiedChatActivity } from './activity';
import { ChatAgentActivityPanel } from '@/features/jarvis-interaction/AgentActivityCard';
import { JarvisTaskProgressCard } from '@/features/jarvis-runs/JarvisTaskProgressCard';
import { JarvisMemoryStatus } from '@/features/jarvis-memory/JarvisMemoryStatus';
import { useJarvisCommandCenterBinding } from '@/features/jarvis-command-center/JarvisCommandCenter';
import {
  acknowledgeJarvisApprovalNavigation,
  isCurrentJarvisApprovalNavigationTarget,
  isPendingJarvisApprovalNavigation,
  readPendingJarvisApprovalNavigation,
  subscribeJarvisApprovalNavigation,
  type JarvisApprovalNavigationIntent,
} from '@/features/jarvis-command-center/approvalNavigation';
import type {
  JarvisCommandCenterHandlers,
  JarvisRun,
} from '@/features/jarvis-command-center/types';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import type { ChatId, Message, Part } from '@/types';
import type { JarvisCreatorKind } from '@/features/jarvis-creator/contracts';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_EVIDENCE } from '@/lib/jarvis/smoke/evidenceIds';
import { AgenticConsole, AgenticConsoleErrorBoundary } from './agentic-console';
import { CONSOLE_PREFERENCE_EVENT, loadConsolePreferences } from './agentic-console/preferences';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

const MAX_STREAM_SIZE_PART = 8000;

export interface ChatThreadProps {
  chatId: ChatId | string;
  compact?: boolean;
  fixtureMessages?: readonly Message[];
}

function useCurrentCanonicalRun(
  binding: ReturnType<typeof useJarvisCommandCenterBinding>,
  chatId: string,
): JarvisRun | undefined {
  type BoundDataPort = NonNullable<typeof binding>['dataPort'];
  type Presence = Readonly<{
    accountId: string;
    chatId: string;
    dataPort: BoundDataPort;
    run?: JarvisRun;
  }>;
  const [presence, setPresence] = useState<Presence>();
  const accountId = binding?.hostPort.accountId;
  const dataPort = binding?.dataPort;

  useEffect(() => {
    if (!accountId || !dataPort) {
      setPresence(undefined);
      return;
    }
    const scope = { accountId, chatId, dataPort } as const;
    setPresence(scope);
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const requestGeneration = ++generation;
      try {
        const runs = await dataPort.getRunsForChat({
          accountId,
          chatId,
          limit: 1,
        });
        if (!disposed && requestGeneration === generation) {
          setPresence({
            ...scope,
            run: runs.find((run) => run.accountId === accountId && run.chatId === chatId),
          });
        }
      } catch {
        if (!disposed && requestGeneration === generation) {
          setPresence(scope);
        }
      }
    };
    const unsubscribe = dataPort.subscribe(accountId, chatId, () => void refresh());
    void refresh();
    return () => {
      disposed = true;
      generation += 1;
      unsubscribe();
    };
  }, [accountId, chatId, dataPort]);

  return presence &&
    presence.accountId === accountId &&
    presence.chatId === chatId &&
    presence.dataPort === dataPort
    ? presence.run
    : undefined;
}

/**
 * Sum of streaming-text size across the message - used as a dependency
 * to keep the auto-scroll glued to bottom while tokens land.
 */
function streamingSize(message: Message | undefined): number {
  if (!message) return 0;
  let n = 0;
  for (const p of message.parts as Part[]) {
    if (p.kind === 'text' || p.kind === 'reasoning')
      n += Math.min(p.text.length, MAX_STREAM_SIZE_PART);
    else if (p.kind === 'tool_call') n += Math.min(roughPayloadSize(p.args), MAX_STREAM_SIZE_PART);
    else if (p.kind === 'tool_result')
      n += Math.min(roughPayloadSize(p.result ?? p.error ?? ''), MAX_STREAM_SIZE_PART);
  }
  return n;
}

function roughPayloadSize(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) return Math.min(value.length, 100) * 64;
  if (typeof value === 'object')
    return Math.min(Object.keys(value as Record<string, unknown>).length, 100) * 96;
  return 32;
}

/**
 * The scroll container. Auto-scrolls to bottom on new messages and during
 * streaming - but only if the user is already near the bottom. If the user
 * has scrolled up to read history, we do not yank them.
 */
export function ChatThread({ chatId, compact = false, fixtureMessages }: ChatThreadProps) {
  const persistedMessages = useChatMessages(fixtureMessages ? null : chatId);
  const messages = fixtureMessages ?? persistedMessages;
  const commandCenterBinding = useJarvisCommandCenterBinding();
  const hasProjectedCanonicalRun = useJarvisTaskRunStore((state) =>
    Object.values(state.runs).some((run) => run.canonical && run.chatId === String(chatId)),
  );
  const currentCanonicalRun = useCurrentCanonicalRun(commandCenterBinding, String(chatId));
  const hasCanonicalRun = hasProjectedCanonicalRun || Boolean(currentCanonicalRun);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [consoleView, setConsoleView] = useState(() => loadConsolePreferences().view);
  const [hasNewActivityBelow, setHasNewActivityBelow] = useState(false);
  const fallbackAgents = useMemo(() => extractAgentCards(messages), [messages]);
  const creatorDraftKind = useMemo(() => detectCreatorDraftKind(messages), [messages]);
  const commandCenterHandlers = useMemo<JarvisCommandCenterHandlers>(() => {
    const hostPort = commandCenterBinding?.hostPort;
    if (!hostPort) return {};
    const requireBoundAccount = (accountId: string) => {
      if (accountId !== hostPort.accountId) {
        throw new Error('jarvis_command_center_account_mismatch');
      }
    };
    return {
      cancelRun(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.requestCancellation(runId);
      },
      retryScheduledTransport(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.retryScheduledTransport(runId);
      },
      retryLogicalRun(accountId, runId) {
        requireBoundAccount(accountId);
        return hostPort.retryLogicalRun(runId);
      },
    };
  }, [commandCenterBinding]);
  const agenticSessionEvidence = useMemo(() => {
    if (!currentCanonicalRun) return undefined;
    const status = String(currentCanonicalRun.status);
    return {
      status,
      currentOperation: status.replaceAll('_', ' '),
      model: currentCanonicalRun.model?.modelId,
      startedAt: currentCanonicalRun.createdAt,
      endedAt: /done|complete|success|failed|error|cancelled/i.test(status)
        ? currentCanonicalRun.updatedAt
        : undefined,
    };
  }, [currentCanonicalRun]);
  const agenticActions = useMemo(() => {
    const run = currentCanonicalRun;
    const binding = commandCenterBinding;
    if (!run || !binding) return undefined;
    const status = String(run.status);
    const actions: {
      cancel?: () => Promise<void>;
      retry?: () => Promise<void>;
      continue?: () => void;
    } = {};
    if (/running|queued|pending|streaming|active/i.test(status)) {
      actions.cancel = async () => {
        await commandCenterHandlers.cancelRun?.(binding.hostPort.accountId, run.id);
      };
    }
    if (/failed|error|cancelled/i.test(status)) {
      actions.retry = async () => {
        await commandCenterHandlers.retryLogicalRun?.(binding.hostPort.accountId, run.id);
      };
    }
    if (/awaiting_approval|blocked/i.test(status)) {
      actions.continue = () => {
        const approval = scrollRef.current?.querySelector<HTMLElement>(
          '[data-approval-kind="canonical"][data-status="pending"]',
        );
        approval?.scrollIntoView({ block: 'center' });
        approval?.focus({ preventScroll: true });
      };
    }
    return Object.keys(actions).length ? actions : undefined;
  }, [commandCenterBinding, commandCenterHandlers, currentCanonicalRun]);

  useEffect(() => {
    let disposed = false;
    const openPendingApproval = (
      requested: JarvisApprovalNavigationIntent | undefined = readPendingJarvisApprovalNavigation(),
    ) => {
      const accountId = commandCenterBinding?.hostPort.accountId;
      const dataPort = commandCenterBinding?.dataPort;
      if (
        !requested ||
        !accountId ||
        !dataPort ||
        requested.accountId !== accountId ||
        requested.chatId !== String(chatId) ||
        !currentCanonicalRun ||
        requested.runId !== currentCanonicalRun.id ||
        currentCanonicalRun.status !== 'awaiting_approval' ||
        !isPendingJarvisApprovalNavigation(requested)
      ) {
        return;
      }
      const cards = scrollRef.current?.querySelectorAll<HTMLElement>(
        '[data-approval-kind="canonical"][data-status="pending"]',
      );
      const matches = cards
        ? Array.from(cards).filter((card) => card.dataset.approvalId === requested.approvalId)
        : [];
      const card = matches.length === 1 ? matches[0] : undefined;
      if (!card) return;
      void isCurrentJarvisApprovalNavigationTarget(dataPort, requested)
        .then((isCurrent) => {
          if (disposed || !isCurrent || !isPendingJarvisApprovalNavigation(requested)) {
            return;
          }
          const currentCards = scrollRef.current?.querySelectorAll<HTMLElement>(
            '[data-approval-kind="canonical"][data-status="pending"]',
          );
          const currentMatches = currentCards
            ? Array.from(currentCards).filter(
                (candidate) => candidate.dataset.approvalId === requested.approvalId,
              )
            : [];
          const currentCard = currentMatches.length === 1 ? currentMatches[0] : undefined;
          if (!currentCard || !acknowledgeJarvisApprovalNavigation(requested)) return;
          stickyRef.current = false;
          currentCard.scrollIntoView({
            behavior:
              window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
                ? 'auto'
                : 'smooth',
            block: 'center',
          });
          currentCard.focus({ preventScroll: true });
        })
        .catch(() => undefined);
    };
    const unsubscribe = subscribeJarvisApprovalNavigation(openPendingApproval);
    const observer =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => openPendingApproval());
    if (scrollRef.current && observer) {
      observer.observe(scrollRef.current, {
        attributes: true,
        attributeFilter: ['data-approval-id', 'data-approval-kind', 'data-status'],
        childList: true,
        subtree: true,
      });
    }
    openPendingApproval();
    return () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
    };
  }, [chatId, commandCenterBinding, currentCanonicalRun]);

  const tailSize = streamingSize(messages[messages.length - 1]);
  const activityEvents = useUnifiedChatActivity(String(chatId));
  useEffect(() => {
    const refreshConsoleView = () => setConsoleView(loadConsolePreferences().view);
    window.addEventListener(CONSOLE_PREFERENCE_EVENT, refreshConsoleView);
    return () => window.removeEventListener(CONSOLE_PREFERENCE_EVENT, refreshConsoleView);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = distFromBottom < 80;
    if (stickyRef.current) setHasNewActivityBelow(false);
  };

  const activityTail = activityEvents[activityEvents.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasNewActivityBelow(false);
    } else if (consoleView === 'agentic') {
      setHasNewActivityBelow(true);
    }
  }, [activityTail?.id, activityTail?.status, consoleView, messages.length, tailSize]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickyRef.current = true;
    el.scrollTop = el.scrollHeight;
    setHasNewActivityBelow(false);
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      data-tour="chat-thread"
      data-pet-chat-message-list={compact ? 'true' : undefined}
      data-sakura-surface="message-scroll"
      data-sik-evidence={
        KERNEL_SMOKE_ENABLED && hasCanonicalRun ? SIK_EVIDENCE.chatRunShell : undefined
      }
      data-sik-assistant-count={
        KERNEL_SMOKE_ENABLED && hasCanonicalRun
          ? messages.filter((message) => message.role === 'assistant').length
          : undefined
      }
    >
      <div
        data-sik-evidence={
          KERNEL_SMOKE_ENABLED && commandCenterBinding ? SIK_EVIDENCE.chatRuntimeReady : undefined
        }
        data-sakura-surface="message-stack"
        className={
          compact
            ? 'flex w-full flex-col gap-3 px-2 py-3'
            : consoleView === 'agentic'
              ? 'mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-3 py-3'
              : 'mx-auto flex w-full max-w-[860px] flex-col gap-4 px-4 py-6'
        }
      >
        {consoleView === 'agentic' ? (
          <AgenticConsoleErrorBoundary
            fallback={
              <>
                {/* Fallback only: single classic mini command center if agentic projection fails. */}
                <ChatActivityTimeline chatId={chatId} compact={compact} />
                {messages.length === 0 ? (
                  <ThreadHint />
                ) : (
                  <AnimatePresence initial={false}>
                    {messages.map((message) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        compact={compact}
                        creatorDraftKind={creatorDraftKind}
                      />
                    ))}
                  </AnimatePresence>
                )}
              </>
            }
          >
            {/* Single top mini command center lives inside AgenticConsole SessionHeader. */}
            <AgenticConsole
              chatId={String(chatId)}
              messages={messages}
              activity={activityEvents}
              compact={compact}
              creatorDraftKind={creatorDraftKind}
              sessionEvidence={agenticSessionEvidence}
              actions={agenticActions}
            />
          </AgenticConsoleErrorBoundary>
        ) : (
          <>
            {/* Classic path: one Jarvis session mini command center. */}
            <ChatActivityTimeline chatId={chatId} compact={compact} />
            {messages.length === 0 ? (
              <ThreadHint />
            ) : (
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    compact={compact}
                    creatorDraftKind={creatorDraftKind}
                  />
                ))}
              </AnimatePresence>
            )}
          </>
        )}
        <ChatAgentActivityPanel
          chatId={chatId}
          fallbackAgents={fallbackAgents}
          compact={compact}
          className={compact ? 'mx-1 mb-6' : 'sticky bottom-0 z-10 mb-8'}
        />
        {!hasCanonicalRun ? (
          <JarvisTaskProgressCard chatId={String(chatId)} compact={compact} />
        ) : null}
        <JarvisMemoryStatus chatId={String(chatId)} />
        {consoleView === 'agentic' && hasNewActivityBelow ? (
          <Button
            type="button"
            size="sm"
            className="sticky bottom-4 z-20 mx-auto shadow-soft"
            aria-label="Jump to latest activity"
            onClick={jumpToLatest}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            New activity below
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const EMPTY_ACTIVITY: readonly never[] = [];

function extractAgentCards(messages: readonly Message[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.kind === 'agent_card' ? [part.agent] : [])),
  );
}

function detectCreatorDraftKind(messages: readonly Message[]): JarvisCreatorKind | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== 'question_block') continue;
      if (part.block.id === 'jarvis_creator_agent') return 'agent';
      if (part.block.id === 'jarvis_creator_skill') return 'skill';
    }
  }
  return undefined;
}

function ThreadHint() {
  return (
    <div
      data-sakura-surface="thread-empty"
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <div className="rounded-full border border-border bg-elevated p-3">
        <Sparkles className="h-5 w-5 text-accent-cyan" />
      </div>
      <div className="text-ui-strong text-foreground">No messages yet</div>
      <div className="text-secondary text-muted-foreground max-w-[44ch]">
        Type below to start the conversation. Use <span className="kbd">@</span> to mention an agent
        or <span className="kbd">{'\u2318'}</span>+<span className="kbd">Enter</span> to send.
      </div>
    </div>
  );
}

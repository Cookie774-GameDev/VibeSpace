import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePagedChatMessages } from './hooks';
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
import type { JarvisEvent } from '@/lib/jarvis/contracts/execution';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import type { ChatId, Message, Part } from '@/types';
import type { JarvisCreatorKind } from '@/features/jarvis-creator/contracts';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import { SIK_EVIDENCE } from '@/lib/jarvis/smoke/evidenceIds';
import { AgenticConsole, AgenticConsoleErrorBoundary } from './agentic-console';
import { CONSOLE_PREFERENCE_EVENT, loadConsolePreferences } from './agentic-console/preferences';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import {
  INITIAL_CHAT_MESSAGE_WINDOW,
  anchoredChatScrollTop,
  nextChatMessageWindowCount,
  windowChatMessages,
} from './chatMessageWindow';
import { AgentChecklistBar, readBoundedAgentChecklistEvidence } from './AgentChecklistBar';

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

const MAX_STREAM_SIZE_PART = 8000;

export function selectedModelPreview(
  selection: ChatModelSelection,
  previousRunModel?: string,
): string | undefined {
  if (selection.mode === 'single') return selection.modelId;
  if (selection.mode === 'hive') return 'Hive Balanced';
  return previousRunModel;
}

export interface ChatThreadProps {
  chatId: ChatId | string;
  compact?: boolean;
  fixtureMessages?: readonly Message[];
}

function useCurrentCanonicalRunState(
  binding: ReturnType<typeof useJarvisCommandCenterBinding>,
  chatId: string,
): Readonly<{
  run?: JarvisRun;
  events: readonly JarvisEvent[];
  eventCoverageComplete: boolean;
  eventCoverageTruncated: boolean;
}> {
  type BoundDataPort = NonNullable<typeof binding>['dataPort'];
  type Presence = Readonly<{
    accountId: string;
    chatId: string;
    dataPort: BoundDataPort;
    run?: JarvisRun;
    events: readonly JarvisEvent[];
    eventCoverageComplete: boolean;
    eventCoverageTruncated: boolean;
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
    setPresence({
      ...scope,
      events: [],
      eventCoverageComplete: false,
      eventCoverageTruncated: false,
    });
    let disposed = false;
    let generation = 0;
    let refreshTimer: number | undefined;
    let refreshing = false;
    let refreshQueued = false;
    let backfillCompletedRunId: string | undefined;
    const refresh = async () => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      const requestGeneration = ++generation;
      try {
        const runs = await dataPort.getRunsForChat({
          accountId,
          chatId,
          limit: 1,
        });
        const run = runs.find(
          (candidate) => candidate.accountId === accountId && candidate.chatId === chatId,
        );
        const events = run
          ? await dataPort.getEventsForRun({ accountId, runId: run.id, limit: 500 })
          : [];
        const mergedPages = new Map<string, JarvisEvent>();
        let fetchedCoverageComplete =
          !run || events.length < 500 || Math.min(...events.map((event) => event.seq)) <= 1;
        let fetchedCoverageTruncated = false;
        if (run && !fetchedCoverageComplete && backfillCompletedRunId !== run.id) {
          const backfill = await readBoundedAgentChecklistEvidence((afterSeq, limit) =>
            dataPort.getEventsForRun({ accountId, runId: run.id, afterSeq, limit }),
          );
          for (const event of backfill.events) {
            mergedPages.set(`${event.runId}:${event.seq}`, event);
          }
          fetchedCoverageComplete = backfill.coverageComplete;
          fetchedCoverageTruncated = backfill.coverageTruncated;
          backfillCompletedRunId = run.id;
        }
        for (const event of events) mergedPages.set(`${event.runId}:${event.seq}`, event);
        if (!disposed && requestGeneration === generation) {
          const relevantEvents = [...mergedPages.values()].filter(
            (event) =>
              event.runId === run?.id &&
              (Boolean(event.canonicalResultEvidence?.stepId) ||
                (event.producerSourceEvidence?.producerKind === 'hive' &&
                  Boolean(event.producerSourceEvidence.producerIdentity.stepId))),
          );
          setPresence((current) => {
            const sameRun = current?.run?.id === run?.id;
            const merged = new Map<string, JarvisEvent>();
            if (sameRun && current) {
              for (const event of current.events) merged.set(`${event.runId}:${event.seq}`, event);
            }
            for (const event of relevantEvents) merged.set(`${event.runId}:${event.seq}`, event);
            return {
              ...scope,
              run,
              events: [...merged.values()].sort((left, right) => left.seq - right.seq),
              eventCoverageComplete:
                fetchedCoverageComplete || Boolean(sameRun && current?.eventCoverageComplete),
              eventCoverageTruncated:
                fetchedCoverageTruncated || Boolean(sameRun && current?.eventCoverageTruncated),
            };
          });
        }
      } catch {
        if (!disposed && requestGeneration === generation) {
          setPresence((current) => ({
            ...scope,
            run: current?.dataPort === dataPort ? current.run : undefined,
            events: current?.dataPort === dataPort ? current.events : [],
            eventCoverageComplete:
              current?.dataPort === dataPort ? current.eventCoverageComplete : false,
            eventCoverageTruncated:
              current?.dataPort === dataPort ? current.eventCoverageTruncated : false,
          }));
        }
      } finally {
        refreshing = false;
        if (!disposed && refreshQueued) {
          refreshQueued = false;
          refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined;
            void refresh();
          }, 120);
        }
      }
    };
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 120);
    };
    const unsubscribe = dataPort.subscribe(accountId, chatId, scheduleRefresh);
    void refresh();
    return () => {
      disposed = true;
      generation += 1;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [accountId, chatId, dataPort]);

  return presence &&
    presence.accountId === accountId &&
    presence.chatId === chatId &&
    presence.dataPort === dataPort
    ? {
        run: presence.run,
        events: presence.events,
        eventCoverageComplete: presence.eventCoverageComplete,
        eventCoverageTruncated: presence.eventCoverageTruncated,
      }
    : { events: [], eventCoverageComplete: false, eventCoverageTruncated: false };
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
  const persistedPage = usePagedChatMessages(fixtureMessages ? null : chatId);
  const messages = fixtureMessages ?? persistedPage.messages;
  const chatKey = String(chatId);
  const commandCenterBinding = useJarvisCommandCenterBinding();
  const hasProjectedCanonicalRun = useJarvisTaskRunStore((state) =>
    Object.values(state.runs).some((run) => run.canonical && run.chatId === String(chatId)),
  );
  const currentCanonicalState = useCurrentCanonicalRunState(commandCenterBinding, String(chatId));
  const currentCanonicalRun = currentCanonicalState.run;
  const recoveredAccountId = useJarvisTaskRunStore((state) =>
    currentCanonicalRun ? state.manualRecoveryByRun[currentCanonicalRun.id]?.accountId : undefined,
  );
  const requiresManualRecovery = Boolean(
    currentCanonicalRun && recoveredAccountId === commandCenterBinding?.hostPort.accountId &&
    !/completed|failed|cancelled/.test(currentCanonicalRun.status),
  );
  const hasEarlierRecovery = useJarvisTaskRunStore((state) =>
    Object.values(state.manualRecoveryByRun).some((entry) =>
      entry.accountId === commandCenterBinding?.hostPort.accountId &&
      state.runs[entry.runId]?.chatId === chatKey &&
      !/completed|failed|cancelled/.test(state.runs[entry.runId]?.status ?? ''),
    ),
  );

  const chatModelSelection = useAuthStore((state) => state.chatModelSelection);
  const hasCanonicalRun = hasProjectedCanonicalRun || Boolean(currentCanonicalRun);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const pendingHistoryAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | undefined>(
    undefined,
  );
  const [consoleView, setConsoleView] = useState(() => loadConsolePreferences().view);
  const [hasNewActivityBelow, setHasNewActivityBelow] = useState(false);
  const [classicWindow, setClassicWindow] = useState({
    chatId: chatKey,
    mountedCount: INITIAL_CHAT_MESSAGE_WINDOW,
  });
  const classicMountedCount =
    classicWindow.chatId === chatKey ? classicWindow.mountedCount : INITIAL_CHAT_MESSAGE_WINDOW;
  const classicMessages = useMemo(
    () =>
      consoleView === 'classic' ? windowChatMessages(messages, classicMountedCount) : messages,
    [classicMountedCount, consoleView, messages],
  );
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
      status: requiresManualRecovery ? 'blocked' : status,
      currentOperation: requiresManualRecovery ? 'Interrupted · outcome unknown' : status.replaceAll('_', ' '),
      model: selectedModelPreview(chatModelSelection, currentCanonicalRun.model?.modelId),
      startedAt: currentCanonicalRun.createdAt,
      endedAt: /done|complete|success|failed|error|cancelled/i.test(status)
        ? currentCanonicalRun.updatedAt
        : undefined,
    };
  }, [chatModelSelection, currentCanonicalRun, requiresManualRecovery]);
  const agenticActions = useMemo(() => {
    const run = currentCanonicalRun;
    const binding = commandCenterBinding;
    if (!run || !binding) return undefined;
    const status = String(run.status);
    const actions: {
      cancel?: () => Promise<void>;
      retry?: () => Promise<void>;
      retryLabel?: string;
      continue?: () => void;
    } = {};
    if (!requiresManualRecovery && /running|queued|pending|streaming|active/i.test(status)) {
      actions.cancel = async () => {
        await commandCenterHandlers.cancelRun?.(binding.hostPort.accountId, run.id);
      };
    }
    if (requiresManualRecovery || /failed|error|cancelled/i.test(status)) {
      if (run.source === 'schedule' && !requiresManualRecovery) {
        actions.retry = async () => {
          await commandCenterHandlers.retryLogicalRun?.(binding.hostPort.accountId, run.id);
        };
      } else if (run.source === 'typed_chat') {
        const latestUser = messages.filter((message) => message.role === 'user').at(-1);
        // A text-only draft can be reviewed through the normal Composer send path.
        // Never replay a newer request or silently discard attachments/context parts.
        if (
          latestUser &&
          String(latestUser.chat_id) === String(chatId) &&
          latestUser.created_at <= run.createdAt &&
          latestUser.parts.length > 0 &&
          latestUser.parts.every((part) => part.kind === 'text')
        ) {
          const text = latestUser.parts
            .map((part) => (part.kind === 'text' ? part.text : ''))
            .join('\n');
          if (text.trim()) {
            actions.retryLabel = 'Retry in composer';
            actions.retry = async () => {
              if (resolveAccountIdentity(useAuthStore.getState())?.accountId !== binding.hostPort.accountId) {
                throw new Error('The account changed. Reopen the current chat before retrying.');
              }
              window.dispatchEvent(
                new CustomEvent('jarvis:composer:insert-text', {
                  detail: { chatId: String(chatId), text },
                }),
              );
            };
          }
        }
      }
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
  }, [chatId, commandCenterBinding, commandCenterHandlers, currentCanonicalRun, messages, requiresManualRecovery]);

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
    pendingHistoryAnchorRef.current = undefined;
    setClassicWindow((current) =>
      current.chatId === chatKey
        ? current
        : { chatId: chatKey, mountedCount: INITIAL_CHAT_MESSAGE_WINDOW },
    );
  }, [chatKey]);
  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    pendingHistoryAnchorRef.current = undefined;
    el.scrollTop = anchoredChatScrollTop(anchor.scrollHeight, anchor.scrollTop, el.scrollHeight);
  }, [classicMessages.length]);
  useEffect(() => {
    const refreshConsoleView = () => setConsoleView(loadConsolePreferences().view);
    window.addEventListener(CONSOLE_PREFERENCE_EVENT, refreshConsoleView);
    return () => window.removeEventListener(CONSOLE_PREFERENCE_EVENT, refreshConsoleView);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const hasLoadedClassicHistory =
      consoleView === 'classic' && classicMessages.length < messages.length;
    const shouldLoadOlderPage =
      !fixtureMessages && !hasLoadedClassicHistory && persistedPage.hasOlder;
    if (
      el.scrollTop <= 48 &&
      (hasLoadedClassicHistory || shouldLoadOlderPage) &&
      !pendingHistoryAnchorRef.current
    ) {
      pendingHistoryAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      if (consoleView === 'classic') {
        setClassicWindow((current) => ({
          chatId: chatKey,
          mountedCount: nextChatMessageWindowCount(
            messages.length,
            current.chatId === chatKey ? current.mountedCount : INITIAL_CHAT_MESSAGE_WINDOW,
            shouldLoadOlderPage,
          ),
        }));
      }
      if (shouldLoadOlderPage) persistedPage.loadOlder();
    }
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
      {consoleView === 'classic' ? (
        <AgentChecklistBar
          run={currentCanonicalRun}
          events={currentCanonicalState.events}
          messages={messages}
          coverageComplete={currentCanonicalState.eventCoverageComplete}
          coverageTruncated={currentCanonicalState.eventCoverageTruncated}
          compact={compact}
        />
      ) : null}
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
        {requiresManualRecovery || hasEarlierRecovery ? (
          <div role="status" className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
            Interrupted request · outcome unknown. Review the existing result before retrying.
          </div>
        ) : null}
        {consoleView === 'agentic' ? (
          <AgenticConsoleErrorBoundary
            fallback={
              <>
                {/* Fallback only: single classic mini command center if agentic projection fails. */}
                <AgentChecklistBar
                  run={currentCanonicalRun}
                  events={currentCanonicalState.events}
                  messages={messages}
                  coverageComplete={currentCanonicalState.eventCoverageComplete}
                  coverageTruncated={currentCanonicalState.eventCoverageTruncated}
                  compact={compact}
                />
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
              headerProgress={
                <AgentChecklistBar
                  run={currentCanonicalRun}
                  events={currentCanonicalState.events}
                  messages={messages}
                  coverageComplete={currentCanonicalState.eventCoverageComplete}
                  coverageTruncated={currentCanonicalState.eventCoverageTruncated}
                  compact={compact}
                  embedded
                />
              }
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
                {classicMessages.map((message) => (
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

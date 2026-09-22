import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AssistantActivityLedger } from './activity-ledger/AssistantActivityLedger';
import { ThinkingDisclosure } from './ThinkingDisclosure';
import { AssistantRichText } from './AssistantRichText';
import type { Message } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import {
  getChatPreview,
  subscribeChatPreviews,
  subscribeFastChatPreviews,
  type JarvisStreamingPreview,
  type StreamingPreviewSegment,
} from './streamingPreviewStore';

type ToolSegment = Extract<StreamingPreviewSegment, { kind: 'tool' }>;
type ReasoningSegment = Extract<StreamingPreviewSegment, { kind: 'reasoning' }>;
type PreviewCommit = (preview: Readonly<JarvisStreamingPreview>) => void;

interface StructuralPreviewCache {
  source: Readonly<JarvisStreamingPreview> | null;
  snapshot: Readonly<JarvisStreamingPreview> | null;
}

function fastTailSegmentIndex(
  preview: Pick<JarvisStreamingPreview, 'segments'> | null | undefined,
) {
  const segments = preview?.segments ?? [];
  return segments[segments.length - 1]?.kind === 'text' ? segments.length - 1 : -1;
}

function sameStructuralPreview(
  before: Readonly<JarvisStreamingPreview>,
  after: Readonly<JarvisStreamingPreview>,
) {
  if (
    before.accountId !== after.accountId ||
    before.chatId !== after.chatId ||
    before.requestId !== after.requestId ||
    before.runId !== after.runId ||
    before.projectRoot !== after.projectRoot
  )
    return false;

  const beforeSegments = before.segments ?? [];
  const afterSegments = after.segments ?? [];
  if (beforeSegments.length !== afterSegments.length) return false;

  const beforeTailIndex = fastTailSegmentIndex(before);
  const afterTailIndex = fastTailSegmentIndex(after);
  if (beforeTailIndex !== afterTailIndex) return false;
  if (beforeTailIndex < 0 && beforeSegments.length > 0 && before.text !== after.text)
    return false;

  for (let index = 0; index < beforeSegments.length; index += 1) {
    const previous = beforeSegments[index];
    const next = afterSegments[index];
    if (previous.kind !== next.kind || previous.id !== next.id) return false;
    if (index === afterTailIndex || previous.kind === 'reasoning') continue;
    if (previous.kind === 'text' && next.kind === 'text' && previous.text !== next.text)
      return false;
    if (previous.kind === 'tool' && next.kind === 'tool') {
      if (
        previous.name !== next.name ||
        previous.status !== next.status ||
        previous.fileLabel !== next.fileLabel ||
        previous.details !== next.details
      )
        return false;
    }
  }
  return true;
}

function selectStructuralPreview(
  preview: Readonly<JarvisStreamingPreview> | null,
  cache: StructuralPreviewCache,
) {
  if (!preview) {
    cache.source = null;
    cache.snapshot = null;
    return null;
  }
  if (cache.source && cache.snapshot && sameStructuralPreview(cache.source, preview))
    return cache.snapshot;
  const snapshot = Object.freeze({
    ...preview,
    segments: preview.segments ? Object.freeze([...preview.segments]) : preview.segments,
  });
  cache.source = preview;
  cache.snapshot = snapshot;
  return snapshot;
}

interface ToolPreviewProps {
  segment: ToolSegment;
  chatId: string;
  updatedAt: number;
  projectRoot?: string;
}
// Text deltas must not rebuild every completed tool's ledger, receipt and diff UI.
// Boundary details are immutable; only a changed tool or trusted root invalidates this row.
const StreamingToolPreview = memo(
  function StreamingToolPreview({ segment, chatId, updatedAt, projectRoot }: ToolPreviewProps) {
    const message: Message = {
      id: `preview_${segment.id}`,
      chat_id: chatId,
      role: 'assistant',
      created_at: updatedAt,
      updated_at: updatedAt,
      parts: [
        {
          kind: 'tool_call',
          tool: segment.name,
          call_id: segment.id,
          details: segment.details,
          args: segment.fileLabel ? { path: segment.fileLabel } : {},
        },
        ...(segment.status === 'started'
          ? []
          : [
              {
                kind: 'tool_result' as const,
                call_id: segment.id,
                ...(segment.status === 'failed'
                  ? { error: 'Tool failed' }
                  : { result: { status: 'completed' } }),
              },
            ]),
      ],
    } as Message;
    return (
      <AssistantActivityLedger
        active={segment.status === 'started'}
        presentation="opencode-chronology"
        projectRoot={projectRoot}
        message={message}
      />
    );
  },
  (before, after) =>
    before.chatId === after.chatId &&
    before.projectRoot === after.projectRoot &&
    before.segment.id === after.segment.id &&
    before.segment.name === after.segment.name &&
    before.segment.status === after.segment.status &&
    before.segment.fileLabel === after.segment.fileLabel &&
    before.segment.details === after.segment.details,
);

const StreamingReasoningPreview = memo(
  function StreamingReasoningPreview({
    accountId,
    chatId,
    runId,
    segmentId,
    initialText,
    onCommitted,
  }: {
    accountId: string;
    chatId: string;
    runId: string;
    segmentId: string;
    initialText: string;
    onCommitted: PreviewCommit;
  }) {
    const subscribe = useCallback(
      (listener: () => void) => subscribeChatPreviews(accountId, chatId, listener),
      [accountId, chatId],
    );
    const readText = useCallback(() => {
      const preview = getChatPreview(accountId, chatId);
      if (!preview || preview.runId !== runId) return '';
      const segment = preview.segments?.find(
        (candidate): candidate is ReasoningSegment =>
          candidate.kind === 'reasoning' && candidate.id === segmentId,
      );
      return segment?.text ?? '';
    }, [accountId, chatId, runId, segmentId]);
    const text = useSyncExternalStore(subscribe, readText, () => initialText);
    useLayoutEffect(() => {
      const preview = getChatPreview(accountId, chatId);
      if (preview?.runId === runId) onCommitted(preview);
    }, [accountId, chatId, onCommitted, runId, segmentId, text]);
    return <ThinkingDisclosure text={text} />;
  },
  (before, after) =>
    before.accountId === after.accountId &&
    before.chatId === after.chatId &&
    before.runId === after.runId &&
    before.segmentId === after.segmentId &&
    before.onCommitted === after.onCommitted,
);

const StreamingPreviewStructure = memo(
  function StreamingPreviewStructure({
    accountId,
    chatId,
    preview,
    onCommitted,
  }: {
    accountId: string;
    chatId: string;
    preview: Readonly<JarvisStreamingPreview>;
    onCommitted: PreviewCommit;
  }) {
    useLayoutEffect(() => onCommitted(preview), [onCommitted, preview]);
    const segments = preview.segments ?? [];
    const fastTailIndex = fastTailSegmentIndex(preview);
    return (
      <>
        {preview.text &&
        segments.length > 0 &&
        !segments.some((segment) => segment.kind === 'text' && segment.text) ? (
          <div className="agentic-native-checkpoint">
            <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
            <AssistantRichText
              className="agentic-native-checkpoint__text"
              text={preview.text}
              live
            />
          </div>
        ) : null}
        {segments.map((segment, index) =>
          index === fastTailIndex ? null : segment.kind === 'text' ? (
            <div key={`text:${segment.id}`} className="agentic-native-checkpoint">
              <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
              <AssistantRichText
                className="agentic-native-checkpoint__text"
                text={segment.text}
                live
              />
            </div>
          ) : segment.kind === 'reasoning' ? (
            <StreamingReasoningPreview
              key={`reasoning:${segment.id}`}
              accountId={accountId}
              chatId={chatId}
              runId={preview.runId}
              segmentId={segment.id}
              initialText={segment.text}
              onCommitted={onCommitted}
            />
          ) : (
            <StreamingToolPreview
              key={`tool:${segment.id}`}
              segment={segment}
              chatId={chatId}
              projectRoot={preview.projectRoot}
              updatedAt={preview.updatedAt}
            />
          ),
        )}
      </>
    );
  },
  (before, after) =>
    before.accountId === after.accountId &&
    before.chatId === after.chatId &&
    before.preview === after.preview &&
    before.onCommitted === after.onCommitted,
);

/** Only already-filtered public prose from this account and chat is displayed. */
export function classifyPreviewCommitTiming(
  publicationMonotonicMs: number,
  commitMonotonicMs: number,
) {
  const delta = commitMonotonicMs - publicationMonotonicMs;
  return Number.isFinite(delta) && delta >= 0
    ? Object.freeze({ uiCommitMs: delta })
    : Object.freeze({ resultCode: 'clock_order_invalid' as const });
}

export function fastPreviewTailText(
  preview: Pick<JarvisStreamingPreview, 'text' | 'segments'> | null | undefined,
): string {
  if (!preview) return '';
  const segments = preview.segments ?? [];
  const last = segments[segments.length - 1];
  if (last?.kind === 'text') return last.text;
  return segments.length === 0 ? preview.text : '';
}

export function StreamingChatPreview({
  chatId,
  fallback,
}: {
  chatId: string;
  fallback?: ReactNode;
}) {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const subscribe = useCallback(
    (listener: () => void) => subscribeChatPreviews(accountId, chatId, listener),
    [accountId, chatId],
  );
  const structuralCache = useRef<StructuralPreviewCache>({ source: null, snapshot: null });
  const readStructuralPreview = useCallback(
    () => selectStructuralPreview(getChatPreview(accountId, chatId), structuralCache.current),
    [accountId, chatId],
  );
  const preview = useSyncExternalStore(
    subscribe,
    readStructuralPreview,
    () => null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const fastHostRef = useRef<HTMLDivElement>(null);
  const fastTextRef = useRef<HTMLDivElement>(null);
  const applyFastPreview = useCallback(
    (next: Readonly<JarvisStreamingPreview> | null, mode: 'fast' | 'reconcile') => {
      const container = containerRef.current;
      const fastHost = fastHostRef.current;
      const fastText = fastTextRef.current;
      if (!container || !fastHost || !fastText) return;
      if (!next) {
        fastText.textContent = '';
        fastHost.hidden = true;
        container.hidden = true;
        container.removeAttribute('data-streaming-chat-preview');
        return;
      }
      container.hidden = false;
      container.dataset.streamingChatPreview = 'true';
      container.dataset.previewChatId = next.chatId;
      container.dataset.previewRequestId = next.requestId;
      container.dataset.previewRunId = next.runId;
      if (next.publicationRevision !== undefined) {
        container.dataset.previewRevision = String(next.publicationRevision);
      }
      const tail = fastPreviewTailText(next);
      if (!tail) {
        // When text has just moved earlier in the chronology (for example a
        // tool was appended), keep the already-visible tail until React has
        // committed the new ordered nodes. Reconciliation then hides it.
        if (
          mode === 'fast' &&
          (Boolean(next.text) ||
            next.segments?.some((segment) => segment.kind === 'text' && segment.text))
        ) {
          return;
        }
        fastText.textContent = '';
        fastHost.hidden = true;
        return;
      }
      fastText.textContent = tail;
      fastHost.hidden = false;
      if (mode === 'fast' && next.publicationMonotonicMs !== undefined) {
        const elapsed = performance.now() - next.publicationMonotonicMs;
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          fastHost.dataset.previewFastCommitMs = elapsed.toFixed(3);
          // Visibility is already committed above. Defer each publication's
          // diagnostic so the logger can never lengthen the critical path.
          window.setTimeout(() => {
            appActivityLog.recordMetadata('ui.preview.fast', 'committed', {
              requestId: next.requestId,
              chatId: next.chatId,
              runId: next.runId,
              publicationRevision: next.publicationRevision,
              runPublicationSequence: next.runPublicationSequence,
              uiCommitMs: elapsed,
            });
          }, 0);
        }
      }
    },
    [],
  );
  useLayoutEffect(() => {
    applyFastPreview(getChatPreview(accountId, chatId), 'reconcile');
    return subscribeFastChatPreviews(accountId, chatId, (next) => applyFastPreview(next, 'fast'));
  }, [accountId, applyFastPreview, chatId]);

  const lastCommitted = useRef<{ runId: string; sequence: number } | undefined>(undefined);
  const recordPreviewCommit = useCallback((candidate: Readonly<JarvisStreamingPreview>) => {
    if (
      (!candidate.text && !candidate.segments?.length) ||
      candidate.publicationMonotonicMs === undefined ||
      candidate.runPublicationSequence === undefined ||
      (lastCommitted.current?.runId === candidate.runId &&
        lastCommitted.current?.sequence === candidate.runPublicationSequence)
    )
      return;
    const coalescedRevisions =
      lastCommitted.current === undefined || lastCommitted.current.runId !== candidate.runId
        ? Math.max(0, candidate.runPublicationSequence - 1)
        : Math.max(0, candidate.runPublicationSequence - lastCommitted.current.sequence - 1);
    lastCommitted.current = {
      runId: candidate.runId,
      sequence: candidate.runPublicationSequence,
    };
    const commitTiming = classifyPreviewCommitTiming(
      candidate.publicationMonotonicMs,
      performance.now(),
    );
    appActivityLog.record(
      'ui.preview',
      'committed',
      {
        requestId: candidate.requestId,
        chatId: candidate.chatId,
        runId: candidate.runId,
        publicationRevision: candidate.publicationRevision,
        coalescedRevisions,
        ...commitTiming,
      },
      undefined,
      'uiCommitMs' in commitTiming ? commitTiming.uiCommitMs : undefined,
    );
  }, []);
  useLayoutEffect(() => applyFastPreview(preview, 'reconcile'), [applyFastPreview, preview]);

  const fastTail = fastPreviewTailText(preview);
  const traceAttributes = preview
    ? {
        'data-preview-chat-id': preview.chatId,
        'data-preview-request-id': preview.requestId,
        'data-preview-run-id': preview.runId,
        'data-preview-revision': preview.publicationRevision,
      }
    : {};

  return (
    <>
      {!preview ? (fallback ?? null) : null}
      <div
        ref={containerRef}
        data-streaming-chat-preview={preview ? 'true' : undefined}
        {...traceAttributes}
        hidden={!preview}
      >
        {preview ? (
          <StreamingPreviewStructure
            accountId={accountId}
            chatId={chatId}
            preview={preview}
            onCommitted={recordPreviewCommit}
          />
        ) : null}
        <div
          ref={fastHostRef}
          className="agentic-native-checkpoint"
          data-streaming-fast-preview-tail="true"
          hidden={!fastTail}
        >
          <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
          <div
            ref={fastTextRef}
            className="agentic-native-checkpoint__text"
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {fastTail}
          </div>
        </div>
      </div>
    </>
  );
}

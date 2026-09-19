import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AssistantActivityLedger } from './activity-ledger/AssistantActivityLedger';
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
  const preview = useSyncExternalStore(
    subscribe,
    () => getChatPreview(accountId, chatId),
    () => null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const fastHostRef = useRef<HTMLDivElement>(null);
  const fastTextRef = useRef<HTMLDivElement>(null);
  const lastFastDiagnosticRunId = useRef<string | null>(null);
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
      container.hidden = false;
      container.dataset.streamingChatPreview = 'true';
      container.dataset.previewChatId = next.chatId;
      container.dataset.previewRequestId = next.requestId;
      container.dataset.previewRunId = next.runId;
      if (next.publicationRevision !== undefined) {
        container.dataset.previewRevision = String(next.publicationRevision);
      }
      if (mode === 'fast' && next.publicationMonotonicMs !== undefined) {
        const elapsed = performance.now() - next.publicationMonotonicMs;
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          fastHost.dataset.previewFastCommitMs = elapsed.toFixed(3);
          // Visibility is already committed above. Persist only the first fast
          // paint per run, deferred to a later task so diagnostics can never
          // lengthen the publication -> visible-DOM critical path.
          if (lastFastDiagnosticRunId.current !== next.runId) {
            lastFastDiagnosticRunId.current = next.runId;
            window.setTimeout(() => {
              appActivityLog.recordMetadata('ui.preview.fast', 'committed', {
                requestId: next.requestId,
                chatId: next.chatId,
                runId: next.runId,
                publicationRevision: next.publicationRevision,
                uiCommitMs: elapsed,
              });
            }, 0);
          }
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
  useLayoutEffect(() => {
    applyFastPreview(preview, 'reconcile');
    if (
      !preview ||
      (!preview.text && !preview.segments?.length) ||
      preview.publicationMonotonicMs === undefined ||
      preview.runPublicationSequence === undefined ||
      (lastCommitted.current?.runId === preview.runId &&
        lastCommitted.current?.sequence === preview.runPublicationSequence)
    )
      return;
    const coalescedRevisions =
      lastCommitted.current === undefined || lastCommitted.current.runId !== preview.runId
        ? Math.max(0, preview.runPublicationSequence - 1)
        : Math.max(0, preview.runPublicationSequence - lastCommitted.current.sequence - 1);
    lastCommitted.current = { runId: preview.runId, sequence: preview.runPublicationSequence };
    const commitTiming = classifyPreviewCommitTiming(
      preview.publicationMonotonicMs,
      performance.now(),
    );
    appActivityLog.record(
      'ui.preview',
      'committed',
      {
        requestId: preview.requestId,
        chatId: preview.chatId,
        runId: preview.runId,
        publicationRevision: preview.publicationRevision,
        // Publications skipped by React coalescing are reported, never
        // silently dropped or assigned zero latency.
        coalescedRevisions,
        ...commitTiming,
      },
      undefined,
      'uiCommitMs' in commitTiming ? commitTiming.uiCommitMs : undefined,
    );
  }, [applyFastPreview, preview]);

  const segments = preview?.segments ?? [];
  const fastTail = fastPreviewTailText(preview);
  const fastTailIndex =
    fastTail && segments[segments.length - 1]?.kind === 'text' ? segments.length - 1 : -1;
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
        {preview?.text &&
        segments.length > 0 &&
        !segments.some((segment) => segment.kind === 'text' && segment.text) ? (
          <div className="agentic-native-checkpoint">
            <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
            <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
              {preview.text}
            </div>
          </div>
        ) : null}
        {preview
          ? segments.map((segment, index) =>
              index === fastTailIndex ? null : segment.kind === 'text' ? (
                <div key={`text:${segment.id}`} className="agentic-native-checkpoint">
                  <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
                  <div
                    className="agentic-native-checkpoint__text"
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {segment.text}
                  </div>
                </div>
              ) : (
                <StreamingToolPreview
                  key={`tool:${segment.id}`}
                  segment={segment}
                  chatId={chatId}
                  projectRoot={preview.projectRoot}
                  updatedAt={preview.updatedAt}
                />
              ),
            )
          : null}
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

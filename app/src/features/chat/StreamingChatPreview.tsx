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
export function classifyPreviewCommitTiming(publicationMonotonicMs: number, commitMonotonicMs: number) {
  const delta = commitMonotonicMs - publicationMonotonicMs;
  return Number.isFinite(delta) && delta >= 0
    ? Object.freeze({ uiCommitMs: delta })
    : Object.freeze({ resultCode: 'clock_order_invalid' as const });
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
  const lastCommitted = useRef<{ runId: string; sequence: number } | undefined>(undefined);
  useLayoutEffect(() => {
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
  }, [preview]);
  if (!preview) return fallback ?? null;
  const traceAttributes = {
    'data-preview-chat-id': preview.chatId,
    'data-preview-request-id': preview.requestId,
    'data-preview-run-id': preview.runId,
    'data-preview-revision': preview.publicationRevision,
  };
  if (preview.segments?.length)
    return (
      <div data-streaming-chat-preview="true" {...traceAttributes}>
        {preview.text && !preview.segments.some((segment) => segment.kind === 'text' && segment.text) ? (
          <div className="agentic-native-checkpoint">
            <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
            <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
              {preview.text}
            </div>
          </div>
        ) : null}
        {preview.segments.map((segment) =>
          segment.kind === 'text' ? (
            <div key={`text:${segment.id}`} className="agentic-native-checkpoint">
              <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
              <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
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
        )}
      </div>
    );
  if (!preview.text) return fallback ?? null;
  return (
    <div
      className="agentic-native-checkpoint"
      data-streaming-chat-preview="true"
      {...traceAttributes}
    >
      <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
      <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
        {preview.text}
      </div>
    </div>
  );
}

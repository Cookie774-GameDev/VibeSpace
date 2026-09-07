import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { AssistantActivityLedger } from './activity-ledger/AssistantActivityLedger';
import type { Message } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { getChatPreview, subscribeChatPreviews } from './streamingPreviewStore';

/** Only already-filtered public prose from this account and chat is displayed. */
export function StreamingChatPreview({ chatId, fallback }: { chatId: string; fallback?: ReactNode }) {
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
  if (!preview) return fallback ?? null;
  if (preview.segments?.length) return <div data-streaming-chat-preview="true">
    {preview.segments.map(segment => segment.kind === 'text' ? (
      <div key={`text:${segment.id}`} className="agentic-native-checkpoint">
        <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
        <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>{segment.text}</div>
      </div>
    ) : (
      <AssistantActivityLedger key={`tool:${segment.id}`} active={segment.status === 'started'}
        presentation="opencode-chronology" message={{
          id: `preview_${segment.id}`, chat_id: chatId, role: 'assistant',
          created_at: preview.updatedAt, updated_at: preview.updatedAt,
          parts: [{ kind: 'tool_call', tool: segment.name, call_id: segment.id,
            args: segment.fileLabel ? { path: segment.fileLabel } : {} },
            ...(segment.status === 'started' ? [] : [{ kind: 'tool_result' as const,
              call_id: segment.id, ...(segment.status === 'failed' ? { error: 'Tool failed' } :
                { result: { status: 'completed' } }) }])],
        } as Message} />
    ))}
  </div>;
  if (!preview.text) return fallback ?? null;
  return (
    <div className="agentic-native-checkpoint" data-streaming-chat-preview="true">
      <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
      <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
        {preview.text}
      </div>
    </div>
  );
}

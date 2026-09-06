import { useSyncExternalStore } from 'react';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { getChatPreview, subscribePreviews } from './streamingPreviewStore';

/** Only already-filtered public prose from this account and chat is displayed. */
export function StreamingChatPreview({ chatId }: { chatId: string }) {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const preview = useSyncExternalStore(
    subscribePreviews,
    () => getChatPreview(accountId, chatId),
    () => null,
  );
  if (!preview?.text) return null;
  return (
    <div className="agentic-native-checkpoint" data-streaming-chat-preview="true">
      <span className="agentic-native-checkpoint__dot" aria-hidden="true" />
      <div className="agentic-native-checkpoint__text" style={{ whiteSpace: 'pre-wrap' }}>
        {preview.text}
      </div>
    </div>
  );
}

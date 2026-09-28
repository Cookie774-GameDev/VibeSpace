import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, vi, expect } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { messageRepo } from '@/lib/db';
import { GROQ_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';

vi.mock('./HarnessReadinessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready' as const, source: 'managed' as const }),
}));

const originalAuth = useAuthStore.getState();
const originalActiveChatId = useUIStore.getState().activeChatId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDiscoveredConnectionModelsForTests();
  useAuthStore.setState({
    workspaceId: originalAuth.workspaceId,
    projectId: originalAuth.projectId,
    apiKeys: originalAuth.apiKeys,
    chatModelSelection: originalAuth.chatModelSelection,
    offlineMode: originalAuth.offlineMode,
  });
  useUIStore.setState({ activeChatId: originalActiveChatId });
});

it('keeps an unsupported image request in the draft without persisting or dispatching it', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  setDiscoveredConnectionModels(GROQ_API_CONNECTION.id, [
    {
      id: 'llama-3.3-70b-versatile',
      label: 'Llama 3.3 70B Versatile',
      source: 'provider_list',
      lastVerifiedAt: 1,
    },
  ]);
  useAuthStore.setState({
    workspaceId: 'workspace-image-test' as never,
    projectId: 'project-image-test' as never,
    apiKeys: { groq: 'test-provider-key' },
    offlineMode: false,
    chatModelSelection: selectionFromOption('groq', 'llama-3.3-70b-versatile', GROQ_API_CONNECTION),
  });
  useUIStore.setState({ activeChatId: 'chat-image-test' as never });
  const send = vi.fn();
  window.addEventListener('jarvis:send', send);
  const error = vi.spyOn(toast, 'error');
  try {
    render(
      <TooltipProvider>
        <Composer chatId={'chat-image-test' as never} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/image Draw a blue square.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'Cannot generate image',
        'Select a supported OpenRouter image model first.',
      ),
    );
    expect(input.value).toBe('/image Draw a blue square.');
    expect(send).not.toHaveBeenCalled();
    expect(await messageRepo.list({ chat_id: 'chat-image-test' as never })).toHaveLength(0);
  } finally {
    window.removeEventListener('jarvis:send', send);
    vi.unstubAllGlobals();
  }
});

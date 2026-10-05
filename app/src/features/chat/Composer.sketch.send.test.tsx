import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { GEMINI_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import {
  resetDiscoveredConnectionModelsForTests,
  setDiscoveredConnectionModels,
} from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { db, messageRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';

vi.mock('./HarnessReadinessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready' as const, source: 'managed' as const }),
}));

// Browser acceptance covers the real drawing/export UI. This fixture starts at
// its File handoff to exercise Composer's production attachment/send path.
vi.mock('./SketchPanel', () => ({
  SketchPanel: ({
    onSave,
    onClose,
  }: {
    onSave: (file: File) => Promise<void>;
    onClose: () => void;
  }) => (
    <button
      type="button"
      aria-label="Complete sketch"
      onClick={() => {
        const png = Uint8Array.from(
          atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+JwAAAAASUVORK5CYII=',
          ),
          (char) => char.charCodeAt(0),
        );
        void onSave(
          new File([png.buffer as ArrayBuffer], 'sketch-test.png', { type: 'image/png' }),
        ).then(onClose);
      }}
    >
      Complete sketch
    </button>
  ),
}));

const originalAuth = useAuthStore.getState();
const originalActiveChatId = useUIStore.getState().activeChatId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it('sends a saved sketch as a persisted image part and re-renders it from history', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  setDiscoveredConnectionModels(GEMINI_API_CONNECTION.id, [
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      source: 'provider_list',
      lastVerifiedAt: 1,
    },
  ]);
  useAuthStore.setState({
    workspaceId: 'workspace-sketch-send-test' as never,
    projectId: 'project-sketch-send-test' as never,
    apiKeys: { google: 'synthetic-test-key' },
    offlineMode: false,
    chatModelSelection: selectionFromOption('google', 'gemini-2.5-flash', GEMINI_API_CONNECTION),
  });
  const chatId = 'chat-sketch-send-test' as never;
  useUIStore.setState({ activeChatId: chatId });
  const dispatched = vi.fn();
  window.addEventListener('jarvis:send', dispatched);

  try {
    render(
      <TooltipProvider>
        <Composer chatId={chatId} />
      </TooltipProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '/sketch' } });
    fireEvent.keyUp(input, { key: 'h' });
    fireEvent.click(await screen.findByRole('option', { name: /sketch/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Complete sketch' }));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-composer-media-preview="image"]')).toHaveLength(1),
    );

    fireEvent.change(input, { target: { value: 'Please describe this sketch.' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(dispatched).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-composer-media-preview="image"]')).toHaveLength(0),
    );

    const saved = (await messageRepo.listByChat(chatId)).find((message) => message.role === 'user');
    expect(saved).toBeTruthy();
    const image = saved!.parts.find((part) => part.kind === 'image');
    expect(image).toMatchObject({ kind: 'image', alt: 'sketch-test.png' });
    expect(image?.kind === 'image' && image.url.startsWith('data:image/png;base64,')).toBe(true);
    const event = dispatched.mock.calls[0]![0] as CustomEvent<{
      imageAttachments: Array<{ data: string }>;
    }>;
    expect(event.detail.imageAttachments[0]?.data).toBe(
      image?.kind === 'image' ? image.url.split(',')[1] : '',
    );

    cleanup();
    db.close();
    await db.open();
    const fromHistory = await messageRepo.getById(saved!.id);
    expect(fromHistory).toBeTruthy();
    render(
      <TooltipProvider>
        <MessageBubble message={fromHistory!} />
      </TooltipProvider>,
    );
    const renderedImage = screen.getByRole('img', { name: 'sketch-test.png' }) as HTMLImageElement;
    expect(renderedImage.src).toBe(image?.kind === 'image' ? image.url : '');
  } finally {
    window.removeEventListener('jarvis:send', dispatched);
  }
});

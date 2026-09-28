import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
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
import { CHAT_ANNOTATION_ATTACH_EVENT } from './chatAnnotations';

const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/features/composer-stt/selectedSttSession', () => ({
  createSelectedSttSession: engine.create,
}));
vi.mock('./HarnessReadinessGate', async (original) => ({
  ...(await original<typeof import('./HarnessReadinessGate')>()),
  useHarnessRuntimeState: () => ({ kind: 'ready' as const, source: 'managed' as const }),
}));

const originalStt = useUIStore.getState().composerStt;
const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  useUIStore.setState({ composerStt: originalStt });
  useAuthStore.setState({
    workspaceId: originalAuth.workspaceId,
    projectId: originalAuth.projectId,
    apiKeys: originalAuth.apiKeys,
    chatModelSelection: originalAuth.chatModelSelection,
    offlineMode: originalAuth.offlineMode,
  });
  resetDiscoveredConnectionModelsForTests();
  vi.restoreAllMocks();
  engine.create.mockReset();
});

describe('chat annotations in Composer', () => {
  it('saves a comment, reveals the quote only on double-click, and supports edit and remove', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    useUIStore.setState({ composerStt: true });
    render(
      <TooltipProvider>
        <Composer chatId="annotation-chat" />
      </TooltipProvider>,
    );
    act(() =>
      window.dispatchEvent(
        new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
          detail: { chatId: 'other-chat', text: 'wrong chat' },
        }),
      ),
    );
    expect(screen.queryByLabelText('Attached chat annotations')).toBeNull();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
          detail: { chatId: 'annotation-chat', text: 'A selected reply' },
        }),
      ),
    );
    expect(screen.getByRole('dialog', { name: 'Comment on selected text' })).toBeTruthy();
    expect(screen.queryByLabelText('Attached chat annotations')).toBeNull();
    const comment = screen.getByRole('textbox', {
      name: 'Comment on annotation 1',
    }) as HTMLTextAreaElement;
    fireEvent.change(comment, { target: { value: 'Please explain this.' } });
    expect(comment.value).toBe('Please explain this.');
    expect(screen.getByRole('button', { name: 'Dictate comment on annotation 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const chip = screen.getByRole('button', { name: /1 attached annotation.*Double-click/ });
    expect(screen.queryByText('A selected reply')).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByRole('dialog', { name: 'Attached annotation details' })).toBeNull();
    fireEvent.dblClick(chip);
    expect(screen.getByRole('dialog', { name: 'Attached annotation details' })).toBeTruthy();
    expect(screen.getByText('A selected reply')).toBeTruthy();
    expect(screen.getByText('Comment: Please explain this.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
    expect(
      (screen.getByRole('textbox', { name: 'Comment on annotation 1' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Please explain this.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment on annotation 1' }), {
      target: { value: 'Unsaved change' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.dblClick(chip);
    expect(screen.getByText('Comment: Please explain this.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove annotation 1' }));
    expect(screen.queryByLabelText('Attached chat annotations')).toBeNull();
  }, 20_000);

  it('cancels an attachment without changing the current message or saving a quote', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    render(
      <TooltipProvider>
        <Composer chatId="annotation-ask" />
      </TooltipProvider>,
    );
    const message = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: 'My own question' } });
    act(() =>
      window.dispatchEvent(
        new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
          detail: { chatId: 'annotation-ask', text: 'Quote' },
        }),
      ),
    );
    expect(message.value).toBe('My own question');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Attached chat annotations')).toBeNull();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
          detail: { chatId: 'annotation-ask', text: 'Second quote' },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(message.value).toBe('My own question');
    expect(
      screen.getByRole('button', { name: /1 attached annotation.*Double-click/ }),
    ).toBeTruthy();
  });

  it('dictates into the annotation comment without sending the chat', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    useUIStore.setState({ composerStt: true });
    engine.create.mockImplementation(
      async (events: {
        onOpen?: () => void;
        onFinal?: (text: string) => void;
        onClose?: () => void;
      }) => {
        events.onOpen?.();
        return {
          engine: 'web-speech',
          engineLabel: 'Built-in speech recognition',
          streaming: true,
          stop: async () => {
            events.onFinal?.('Spoken comment');
            events.onClose?.();
          },
          cancel: () => events.onClose?.(),
          getFinalText: () => 'Spoken comment',
        };
      },
    );
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      render(
        <TooltipProvider>
          <Composer chatId="annotation-dictation" />
        </TooltipProvider>,
      );
      act(() =>
        window.dispatchEvent(
          new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
            detail: { chatId: 'annotation-dictation', text: 'Selected phrase' },
          }),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Dictate comment on annotation 1' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Stop dictation for annotation 1' }),
      );
      await waitFor(() =>
        expect(
          (screen.getByRole('textbox', { name: 'Comment on annotation 1' }) as HTMLTextAreaElement)
            .value,
        ).toBe('Spoken comment'),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.dblClick(
        screen.getByRole('button', { name: /1 attached annotation.*Double-click/ }),
      );
      expect(screen.getByText('Comment: Spoken comment')).toBeTruthy();
      expect(send).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('jarvis:send', send);
    }
  }, 20_000);

  it('persists the selected quote and comment once with the ordinary user message', async () => {
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
      workspaceId: 'workspace-annotation-test' as never,
      projectId: 'project-annotation-test' as never,
      apiKeys: { groq: 'test-provider-key' },
      offlineMode: false,
      chatModelSelection: selectionFromOption(
        'groq',
        'llama-3.3-70b-versatile',
        GROQ_API_CONNECTION,
      ),
    });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      render(
        <TooltipProvider>
          <Composer chatId={'annotation-send' as never} />
        </TooltipProvider>,
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
        target: { value: 'Explain this' },
      });
      act(() =>
        window.dispatchEvent(
          new CustomEvent(CHAT_ANNOTATION_ATTACH_EVENT, {
            detail: { chatId: 'annotation-send', text: 'Selected phrase' },
          }),
        ),
      );
      fireEvent.change(screen.getByRole('textbox', { name: 'Comment on annotation 1' }), {
        target: { value: 'Why?' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const sendButton = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
      await waitFor(() => expect(sendButton.disabled).toBe(false), { timeout: 10_000 });
      fireEvent.click(sendButton);
      await waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 10_000 });
      const messages = await messageRepo.list({ chat_id: 'annotation-send' as never });
      const sent = messages.filter((message) => message.role === 'user');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.parts).toContainEqual({
        kind: 'text',
        text: 'Explain this\n\nAnnotation 1:\n> Selected phrase\nComment: Why?',
      });
      expect(screen.queryByLabelText('Attached chat annotations')).toBeNull();
    } finally {
      window.removeEventListener('jarvis:send', send);
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

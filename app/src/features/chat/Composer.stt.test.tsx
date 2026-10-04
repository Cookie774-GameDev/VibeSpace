import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { GEMINI_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import { resetDiscoveredConnectionModelsForTests, setDiscoveredConnectionModels } from '@/lib/ai/connectionCatalog';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { messageRepo } from '@/lib/db';
import type { DictationEvents } from '@/features/global-dictation/deepgramDictation';
const engine = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/features/composer-stt/selectedSttSession', () => ({
  createSelectedSttSession: engine.create,
}));
import { Composer } from './Composer';
const originalEnabled = useUIStore.getState().composerStt;
const originalActiveChatId = useUIStore.getState().activeChatId;
const originalAuth = useAuthStore.getState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  engine.create.mockReset();
  resetDiscoveredConnectionModelsForTests();
  useUIStore.setState({ composerStt: originalEnabled, activeChatId: originalActiveChatId });
  useAuthStore.setState({
    workspaceId: originalAuth.workspaceId,
    projectId: originalAuth.projectId,
    apiKeys: originalAuth.apiKeys,
    chatModelSelection: originalAuth.chatModelSelection,
    offlineMode: originalAuth.offlineMode,
  });
});

function configureSendModel(chatId: string) {
  setDiscoveredConnectionModels(GEMINI_API_CONNECTION.id, [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', source: 'provider_list', lastVerifiedAt: 1 },
  ]);
  useAuthStore.setState({
    workspaceId: 'workspace-dictation-send-test' as never,
    projectId: 'project-dictation-send-test' as never,
    apiKeys: { google: 'synthetic-test-key' },
    offlineMode: false,
    chatModelSelection: selectionFromOption('google', 'gemini-2.5-flash', GEMINI_API_CONNECTION),
  });
  useUIStore.setState({ composerStt: true, activeChatId: chatId as never });
}

describe('Composer selected speech engine contract', () => {
  it('routes only to the saved engine and has no silent system, Groq, or OS-dictation fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/features/chat/Composer.tsx'), 'utf8');

    const selected = readFileSync(
      resolve(process.cwd(), 'src/features/global-dictation/dictationSession.ts'),
      'utf8',
    );
    const controller = readFileSync(
      resolve(process.cwd(), 'src/features/composer-stt/composerDictationController.ts'),
      'utf8',
    );
    expect(source).toContain('createComposerDictationController');
    expect(source).not.toContain('Accept dictation');
    expect(source).not.toContain('Cancel dictation');
    expect(controller).toContain('await createSelectedSttSession(');
    expect(selected).toContain("if (provider === 'faster-whisper') {");
    expect(selected).toContain("if (provider === 'deepgram') {");
    const syntax = ts.createSourceFile(
      'dictationSession.ts',
      selected,
      ts.ScriptTarget.Latest,
      true,
    );
    const webSpeechCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createWebSpeechSession'
      )
        webSpeechCalls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    expect(webSpeechCalls).toHaveLength(1);
    const args = webSpeechCalls[0]!.arguments;
    expect(args).toHaveLength(3);
    const scopedEvents = args[0]!;
    const assertCurrent = args[1]!;
    expect(ts.isIdentifier(scopedEvents) && scopedEvents.text).toBe('scopedEvents');
    expect(ts.isIdentifier(assertCurrent) && assertCurrent.text).toBe('assertCurrent');
    const requester = args[2]!;
    if (!ts.isBinaryExpression(requester) || !ts.isPropertyAccessExpression(requester.left)) {
      throw new Error('Web Speech auto-finish must be explicitly gated by the voice requester');
    }
    expect(requester.operatorToken.kind).toBe(ts.SyntaxKind.EqualsEqualsEqualsToken);
    expect(ts.isIdentifier(requester.left.expression) && requester.left.expression.text).toBe(
      'options',
    );
    expect(requester.left.name.text).toBe('requester');
    expect(ts.isStringLiteral(requester.right) && requester.right.text).toBe('jarvis-voice');
    expect(source).not.toContain('trySystemSttFallbacks');
    expect(source).not.toContain('triggerWindowsNativeDictation');
    expect(source).not.toContain('startGroqStt');
    expect(source).not.toContain('transcribeGroq');
  });
});

describe('composer dictation without a confirmation panel', () => {
  it.each(['microphone stop', 'toolbar stop', 'engine finish'])(
    'inserts once on %s and never sends a chat',
    async (finish) => {
      let events: DictationEvents = {};
      engine.create.mockImplementation(async (next: DictationEvents) => {
        events = next;
        events.onOpen?.();
        return {
          engine: 'web-speech',
          engineLabel: 'Built-in speech recognition',
          streaming: true,
          stop: async () => {
            events.onFinal?.('Spoken draft');
            events.onClose?.();
          },
          cancel: () => events.onClose?.(),
          getFinalText: () => 'Spoken draft',
        };
      });
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      useUIStore.setState({ composerStt: true });
      const send = vi.fn();
      window.addEventListener('jarvis:send', send);
      try {
        render(
          <TooltipProvider>
            <Composer chatId="dictation-ui-check" />
          </TooltipProvider>,
        );
        const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
        fireEvent.change(field, { target: { value: 'Before after' } });
        field.focus();
        field.setSelectionRange(7, 7);
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
        await screen.findByRole('button', { name: 'Stop dictation' });
        act(() => events.onPartial?.('Spoken'));
        expect(field.value).toBe('Before after');
        expect(screen.queryByLabelText('Composer dictation')).toBeNull();
        if (finish === 'microphone stop')
          fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
        else if (finish === 'toolbar stop')
          act(() => window.dispatchEvent(new CustomEvent('jarvis:stt:stop')));
        else
          act(() => {
            events.onFinal?.('Spoken draft');
            events.onClose?.();
          });
        await waitFor(() => expect(field.value).toBe('Before Spoken draft after'));
        expect(screen.queryByText('Accept dictation')).toBeNull();
        expect(screen.queryByText('Cancel dictation')).toBeNull();
        expect(send).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('jarvis:send', send);
      }
    },
  );
});

describe('send during composer dictation', () => {
  it.each(['listening', 'transcribing'])('waits for %s dictation and sends the final text once', async (phase) => {
    const chatId = `dictation-send-${phase}`;
    configureSendModel(chatId);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    let events: DictationEvents = {};
    let releaseStop!: () => void;
    const stop = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseStop = resolve; });
      events.onFinal?.('Final spoken message');
      events.onClose?.();
    });
    engine.create.mockImplementation(async (next: DictationEvents) => {
      events = next;
      events.onOpen?.();
      return {
        engine: 'web-speech', engineLabel: 'Built-in speech recognition', streaming: true,
        stop, cancel: vi.fn(), getFinalText: () => 'Final spoken message',
      };
    });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
      const field = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
      fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
      await screen.findByRole('button', { name: 'Stop dictation' });
      if (phase === 'transcribing') fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
      const button = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
      expect(send).not.toHaveBeenCalled();
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      releaseStop();
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const saved = (await messageRepo.listByChat(chatId as never)).filter((message) => message.role === 'user');
      expect(saved).toHaveLength(1);
      expect(saved[0]?.parts).toContainEqual({ kind: 'text', text: 'Final spoken message' });
      await waitFor(() => expect(field.value).toBe(''));
    } finally {
      window.removeEventListener('jarvis:send', send);
    }
  });

  it('honors explicit cancel while Send waits for transcription', async () => {
    const chatId = 'dictation-send-cancel';
    configureSendModel(chatId);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    let events: DictationEvents = {};
    let releaseStop!: () => void;
    const cancel = vi.fn();
    engine.create.mockImplementation(async (next: DictationEvents) => {
      events = next;
      events.onOpen?.();
      return {
        engine: 'web-speech', engineLabel: 'Built-in speech recognition', streaming: true,
        stop: () => new Promise<void>((resolve) => { releaseStop = resolve; }),
        cancel, getFinalText: () => 'Do not send this',
      };
    });
    const send = vi.fn();
    window.addEventListener('jarvis:send', send);
    try {
      render(<TooltipProvider><Composer chatId={chatId as never} /></TooltipProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
      await screen.findByRole('button', { name: 'Stop dictation' });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel transcription' }));
      releaseStop();
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect(send).not.toHaveBeenCalled();
      expect((await messageRepo.listByChat(chatId as never)).filter((message) => message.role === 'user')).toHaveLength(0);
    } finally {
      window.removeEventListener('jarvis:send', send);
    }
  });
});

import { __resetHotkeyBindingsForTests, setHotkeyBinding } from '@/lib/hotkeys';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSttHost } from './GlobalSttHost';
import { COMPOSER_STT_TOGGLE_EVENT, requestComposerSttToggle } from './composerSttService';
import { rememberSttEditableFromFocus, resetSttFocusMemoryForTests } from './insertText';

const nativeInvoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
vi.mock('@/lib/utils', async (original) => ({
  ...(await original<typeof import('@/lib/utils')>()),
  isTauri: true,
}));

const selectedSessionMocks = vi.hoisted(() => ({
  create: vi.fn(),
  events: new Map<string, (payload: unknown) => void>(),
  stop: vi.fn(async () => undefined),
  cancel: vi.fn(),
}));

vi.mock('./selectedSttSession', () => ({
  createSelectedSttSession: selectedSessionMocks.create,
}));

const setComposerSttListening = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (
    selector: (state: {
      composerStt: boolean;
      globalDictationEnabled: boolean;
      setComposerSttListening: typeof setComposerSttListening;
    }) => unknown,
  ) =>
    selector({
      composerStt: true,
      globalDictationEnabled: true,
      setComposerSttListening,
    }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: toastMocks,
}));

describe('GlobalSttHost', () => {
  it('registers the new native default and sends an edited Settings binding to native registration', async () => {
    render(<GlobalSttHost />);
    await waitFor(() =>
      expect(nativeInvoke).toHaveBeenCalledWith('set_global_dictation_enabled', {
        enabled: true,
        shortcut: 'Ctrl+Shift+Space',
      }),
    );
    act(() => {
      setHotkeyBinding('GLOBAL_DICTATION', 'Alt+Shift+D');
    });
    await waitFor(() =>
      expect(nativeInvoke).toHaveBeenLastCalledWith('set_global_dictation_enabled', {
        enabled: true,
        shortcut: 'Alt+Shift+D',
      }),
    );
  });

  beforeEach(() => {
    __resetHotkeyBindingsForTests();
    nativeInvoke.mockClear();
    resetSttFocusMemoryForTests();
    selectedSessionMocks.events.clear();
    selectedSessionMocks.stop.mockClear();
    selectedSessionMocks.cancel.mockClear();
    setComposerSttListening.mockClear();
    toastMocks.info.mockClear();
    toastMocks.warning.mockClear();
    toastMocks.error.mockClear();
    selectedSessionMocks.create.mockReset().mockImplementation(async (events) => {
      selectedSessionMocks.events.set('partial', events.onPartial);
      selectedSessionMocks.events.set('final', events.onFinal);
      selectedSessionMocks.events.set('error', events.onError);
      selectedSessionMocks.events.set('close', events.onClose);
      return {
        engine: 'web-speech',
        engineLabel: 'Built-in speech recognition',
        streaming: true,
        stop: selectedSessionMocks.stop,
        cancel: selectedSessionMocks.cancel,
        getFinalText: () => '',
      };
    });
  });

  it('starts the shared selected session for the last focused global field after toolbar mic steals focus', async () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'agent-prompt';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    const micButton = document.createElement('button');
    document.body.appendChild(micButton);
    micButton.focus();

    act(() => requestComposerSttToggle('toolbar'));

    await waitFor(() => expect(selectedSessionMocks.create).toHaveBeenCalledOnce());
    expect(setComposerSttListening).toHaveBeenCalledWith(true);

    field.remove();
    micButton.remove();
  });

  it('uses the shared selected session for a system selection instead of direct VoiceService access', async () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'hands-free-field';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    act(() => requestComposerSttToggle('toolbar'));

    await waitFor(() => expect(selectedSessionMocks.create).toHaveBeenCalledOnce());
    expect(setComposerSttListening).toHaveBeenCalledWith(true);

    field.remove();
  });

  it('does not route the native Ctrl+Space overlay event into an in-app field', () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'in-app-field';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    window.dispatchEvent(new CustomEvent('jarvis:global-dictation-toggle'));

    expect(selectedSessionMocks.create).not.toHaveBeenCalled();
    field.remove();
  });

  it('uses the selected Deepgram session for a generic field without starting Web Speech', async () => {
    let events: { onFinal?: (text: string) => void } | undefined;
    const stop = vi.fn(async () => undefined);
    selectedSessionMocks.create.mockImplementation(async (nextEvents) => {
      events = nextEvents;
      return {
        engine: 'deepgram',
        engineLabel: 'Deepgram · Nova-3 Monolingual (nova-3, v1/listen)',
        streaming: true,
        stop,
        cancel: vi.fn(),
        getFinalText: () => '',
      };
    });
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    act(() => requestComposerSttToggle('toolbar'));
    await waitFor(() => expect(selectedSessionMocks.create).toHaveBeenCalledOnce());

    act(() => events?.onFinal?.('Deepgram text'));
    expect(field.value).toContain('Deepgram text');
    field.remove();
  });

  it('does not start when no text field was recently focused', () => {
    render(<GlobalSttHost />);

    const micButton = document.createElement('button');
    document.body.appendChild(micButton);
    micButton.focus();

    window.dispatchEvent(
      new CustomEvent(COMPOSER_STT_TOGGLE_EVENT, { detail: { source: 'toolbar' } }),
    );

    expect(selectedSessionMocks.create).not.toHaveBeenCalled();

    micButton.remove();
  });

  it('does not open a selected session when toolbar dictation has no target field', () => {
    render(<GlobalSttHost />);

    const micButton = document.createElement('button');
    document.body.appendChild(micButton);
    micButton.focus();
    window.dispatchEvent(
      new CustomEvent(COMPOSER_STT_TOGGLE_EVENT, { detail: { source: 'toolbar' } }),
    );

    expect(selectedSessionMocks.create).not.toHaveBeenCalled();

    micButton.remove();
  });

  it('does not expose a selected-engine startup failure detail', async () => {
    selectedSessionMocks.create.mockRejectedValueOnce(
      new Error('synthetic selected-engine implementation detail'),
    );
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));
      await waitFor(() =>
        expect(toastMocks.error).toHaveBeenCalledWith('Dictation error', expect.any(String)),
      );
      expect(toastMocks.error.mock.calls[0]?.[1]).not.toContain(
        'synthetic selected-engine implementation detail',
      );
    } finally {
      field.remove();
    }
  });

  it('uses precise shared narration when a dictation target detaches before final text', async () => {
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    act(() => requestComposerSttToggle('toolbar'));
    await waitFor(() => expect(selectedSessionMocks.events.has('final')).toBe(true));
    field.remove();

    act(() => selectedSessionMocks.events.get('final')?.('detached target text'));

    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Dictation',
      'The action failed, sir. Action: Dictation insertion. Cause: The spoken text could not be inserted because the target field is no longer available.',
    );
  });

  it('keeps the free continuous STT target after the first final so later speech still inserts', async () => {
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    field.value = '';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));
      await waitFor(() => expect(selectedSessionMocks.events.has('final')).toBe(true));

      act(() => selectedSessionMocks.events.get('final')?.('hello'));
      expect(field.value).toContain('hello');
      expect(toastMocks.warning).not.toHaveBeenCalled();

      act(() => selectedSessionMocks.events.get('final')?.('world'));
      expect(field.value).toMatch(/hello/i);
      expect(field.value).toMatch(/world/i);
      expect(toastMocks.warning).not.toHaveBeenCalledWith(
        'Dictation',
        'The action failed, sir. Action: Dictation insertion. Cause: The spoken text could not be inserted because the target field is no longer available.',
      );
    } finally {
      field.remove();
    }
  });

  it('distinguishes an available field that rejects dictation insertion', async () => {
    const insertSpy = vi
      .spyOn(await import('./insertText'), 'insertTextIntoEditable')
      .mockReturnValueOnce(false);
    render(<GlobalSttHost />);
    const field = document.createElement('div');
    field.contentEditable = 'true';
    Object.defineProperty(field, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));
      await waitFor(() => expect(selectedSessionMocks.events.has('final')).toBe(true));

      act(() => selectedSessionMocks.events.get('final')?.('rejected target text'));

      expect(toastMocks.warning).toHaveBeenCalledWith(
        'Dictation',
        'The action failed, sir. Action: Dictation insertion. Cause: The spoken text could not be inserted because the focused field did not accept input.',
      );
    } finally {
      insertSpy.mockRestore();
      field.remove();
    }
  });
});

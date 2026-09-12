import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalSttHost } from './GlobalSttHost';
import {
  COMPOSER_STT_TOGGLE_EVENT,
  GLOBAL_DICTATION_IN_APP_EVENT,
  requestComposerSttToggle,
} from './composerSttService';
import { rememberSttEditableFromFocus, resetSttFocusMemoryForTests } from './insertText';

const voiceMocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    startListening: vi.fn(() => true),
    stopListening: vi.fn(),
    isSupported: vi.fn(() => true),
    isListening: vi.fn(() => false),
    wantsListening: vi.fn(() => false),
    setInactivityTimeoutMs: vi.fn(),
    interruptListening: vi.fn(),
    onVoice: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
  };
});

const setComposerSttListening = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/features/voice/VoiceService', () => ({
  VoiceService: {
    startListening: voiceMocks.startListening,
    stopListening: voiceMocks.stopListening,
    isSupported: voiceMocks.isSupported,
    isListening: voiceMocks.isListening,
    wantsListening: voiceMocks.wantsListening,
    setInactivityTimeoutMs: voiceMocks.setInactivityTimeoutMs,
    interruptListening: voiceMocks.interruptListening,
    on: voiceMocks.onVoice,
  },
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (
    selector: (state: {
      composerStt: boolean;
      setComposerSttListening: typeof setComposerSttListening;
    }) => unknown,
  ) =>
    selector({
      composerStt: true,
      setComposerSttListening,
    }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: toastMocks,
}));

describe('GlobalSttHost', () => {
  beforeEach(() => {
    resetSttFocusMemoryForTests();
    voiceMocks.handlers.clear();
    voiceMocks.startListening.mockReset().mockReturnValue(true);
    voiceMocks.stopListening.mockClear();
    voiceMocks.isSupported.mockReset().mockReturnValue(true);
    voiceMocks.isListening.mockReset().mockReturnValue(false);
    voiceMocks.wantsListening.mockReset().mockReturnValue(false);
    voiceMocks.interruptListening.mockClear();
    voiceMocks.onVoice.mockClear();
    setComposerSttListening.mockClear();
    toastMocks.info.mockClear();
    toastMocks.warning.mockClear();
    toastMocks.error.mockClear();
  });

  it('starts dictation for the last focused global field after toolbar mic steals focus', () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'agent-prompt';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    const micButton = document.createElement('button');
    document.body.appendChild(micButton);
    micButton.focus();

    requestComposerSttToggle('toolbar');

    expect(voiceMocks.startListening).toHaveBeenCalledTimes(1);
    expect(setComposerSttListening).toHaveBeenCalledWith(true);

    field.remove();
    micButton.remove();
  });

  it('preempts an active Jarvis voice listener when toolbar dictation starts', () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'hands-free-field';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    voiceMocks.isListening.mockReturnValue(true);

    requestComposerSttToggle('toolbar');

    expect(voiceMocks.interruptListening).toHaveBeenCalledTimes(1);
    expect(voiceMocks.startListening).toHaveBeenCalledTimes(1);
    expect(setComposerSttListening).toHaveBeenCalledWith(true);

    field.remove();
  });

  it('routes the in-app Ctrl+Space event to composer STT instead of any overlay', () => {
    render(<GlobalSttHost />);

    const field = document.createElement('textarea');
    field.id = 'in-app-field';
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    // Observe the relayed composer toggle event with its source.
    const toggles: string[] = [];
    const onToggle = (event: Event) =>
      toggles.push(String((event as CustomEvent<{ source?: string }>).detail?.source));
    window.addEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);

    // The Rust global-shortcut handler emits this when VibeSpace is focused.
    window.dispatchEvent(new CustomEvent(GLOBAL_DICTATION_IN_APP_EVENT));

    expect(toggles).toEqual(['hotkey']);
    // The in-app path starts the SAME shared STT engine for the focused
    // field - no separate dictation window is involved.
    expect(voiceMocks.startListening).toHaveBeenCalledTimes(1);
    expect(setComposerSttListening).toHaveBeenCalledWith(true);

    window.removeEventListener(COMPOSER_STT_TOGGLE_EVENT, onToggle);
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

    expect(voiceMocks.startListening).not.toHaveBeenCalled();

    micButton.remove();
  });

  it('does not interrupt Jarvis voice when toolbar dictation has no target field', () => {
    render(<GlobalSttHost />);

    const micButton = document.createElement('button');
    document.body.appendChild(micButton);
    micButton.focus();
    voiceMocks.isListening.mockReturnValue(true);

    window.dispatchEvent(
      new CustomEvent(COMPOSER_STT_TOGGLE_EVENT, { detail: { source: 'toolbar' } }),
    );

    expect(voiceMocks.interruptListening).not.toHaveBeenCalled();
    expect(voiceMocks.startListening).not.toHaveBeenCalled();

    micButton.remove();
  });

  it('uses precise shared narration when global speech recognition is unsupported', () => {
    voiceMocks.isSupported.mockReturnValueOnce(false);
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));

      expect(toastMocks.warning).toHaveBeenCalledWith(
        'Voice unsupported',
        'The action failed, sir. Action: Global speech recognition availability. Cause: Speech-to-text is not available in this runtime.',
      );
      expect(voiceMocks.startListening).not.toHaveBeenCalled();
    } finally {
      field.remove();
    }
  });

  it('uses precise shared narration when global speech recognition returns false', () => {
    voiceMocks.startListening.mockReturnValueOnce(false);
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));

      expect(toastMocks.warning).toHaveBeenCalledWith(
        'Voice unsupported',
        'The action failed, sir. Action: Global speech recognition startup. Cause: Voice-to-text could not start for the focused field. Check microphone access, then try again.',
      );
      expect(setComposerSttListening).not.toHaveBeenCalledWith(true);
    } finally {
      field.remove();
    }
  });

  it('does not expose a thrown global speech-recognition startup detail', () => {
    voiceMocks.startListening.mockImplementationOnce(() => {
      throw new Error('synthetic global startup implementation detail');
    });
    render(<GlobalSttHost />);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    rememberSttEditableFromFocus(field);

    try {
      act(() => requestComposerSttToggle('toolbar'));

      expect(toastMocks.error).toHaveBeenCalledWith(
        'Voice error',
        'The action failed, sir. Action: Global speech recognition startup. Cause: Voice-to-text could not start for the focused field. Check microphone access, then try again.',
      );
      expect(toastMocks.error.mock.calls[0]?.[1]).not.toContain(
        'synthetic global startup implementation detail',
      );
      expect(setComposerSttListening).not.toHaveBeenCalledWith(true);
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
    await waitFor(() => expect(voiceMocks.handlers.has('voice:final')).toBe(true));
    field.remove();

    act(() => voiceMocks.handlers.get('voice:final')?.({ text: 'detached target text' }));

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
      await waitFor(() => expect(voiceMocks.handlers.has('voice:final')).toBe(true));

      // Continuous free system STT stays armed after the first phrase.
      voiceMocks.isListening.mockReturnValue(true);
      voiceMocks.wantsListening.mockReturnValue(true);

      act(() => voiceMocks.handlers.get('voice:final')?.({ text: 'hello' }));
      expect(field.value).toContain('hello');
      expect(toastMocks.warning).not.toHaveBeenCalled();

      act(() => voiceMocks.handlers.get('voice:final')?.({ text: 'world' }));
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
      await waitFor(() => expect(voiceMocks.handlers.has('voice:final')).toBe(true));

      act(() => voiceMocks.handlers.get('voice:final')?.({ text: 'rejected target text' }));

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

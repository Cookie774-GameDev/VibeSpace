import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  windowApi: {
    show: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    setFocus: vi.fn(async () => undefined),
  },
  tauriListeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

const sessionMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    tauriMocks.tauriListeners.set(event, handler);
    return () => tauriMocks.tauriListeners.delete(event);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => tauriMocks.windowApi,
}));
vi.mock('./dictationSession', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createGlobalDictationSession: sessionMocks.createSession,
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  Toaster: () => null,
}));
vi.mock('@/features/voice/VoiceActivityWaveform', () => ({
  VoiceActivityWaveform: () => null,
}));

import { GlobalDictationOverlay } from './GlobalDictationOverlay';
import { useAuthStore } from '@/stores/auth';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type SessionCallbacks = {
  onOpen?: () => void;
  onStatus?: (message: string) => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

function fakeSession(finalText: string, engineLabel = 'Built-in speech recognition') {
  return {
    engine: 'web-speech' as const,
    engineLabel,
    streaming: true,
    stop: vi.fn(async (): Promise<void> => undefined),
    cancel: vi.fn(),
    getFinalText: () => finalText,
  };
}

async function openOverlay() {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('jarvis:global-dictation-toggle'));
    await Promise.resolve();
  });
}

describe('GlobalDictationOverlay (VibeSpace shared STT pipeline)', () => {
  it('grants the native dictation window the hide permission required for cancel and paste', () => {
    const config = JSON.parse(
      readFileSync(resolve(__dirname, '../../../src-tauri/tauri.conf.json'), 'utf8'),
    );
    expect(config.app.security.capabilities).toContain('global-dictation');
    const capability = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../src-tauri/capabilities/global-dictation.json'),
        'utf8',
      ),
    );
    expect(capability.windows).toEqual(['dictation']);
    expect(capability.permissions).toEqual([
      'core:window:allow-hide',
      'core:window:allow-show',
      'core:window:allow-start-dragging',
    ]);
    const panel = config.app.windows.find(
      (window: { label: string }) => window.label === 'dictation',
    );
    expect(panel.width).toBe(120);
    expect(panel.height).toBe(30);
    expect(panel.shadow).toBe(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.tauriListeners.clear();
    tauriMocks.invoke.mockResolvedValue(undefined);
    tauriMocks.windowApi.hide.mockResolvedValue(undefined);
  });

  it('renders contained visual evidence without native listeners or speech startup', async () => {
    render(<GlobalDictationOverlay runtimeEffectsEnabled={false} />);
    expect(screen.getByText('VibeSpace Dictation')).toBeTruthy();

    await openOverlay();

    expect(tauriMocks.tauriListeners.size).toBe(0);
    expect(tauriMocks.windowApi.show).not.toHaveBeenCalled();
    expect(sessionMocks.createSession).not.toHaveBeenCalled();
  });

  it('Ctrl+Space toggle starts a shared-pipeline session and shows the engine, never Win+H', async () => {
    let callbacks: SessionCallbacks | null = null;
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return fakeSession('');
    });

    render(<GlobalDictationOverlay />);
    expect(screen.getByText('VibeSpace Dictation')).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Shift\+Space · VibeSpace STT/)).toBeTruthy();

    await openOverlay();

    expect(sessionMocks.createSession).toHaveBeenCalledTimes(1);
    expect(tauriMocks.windowApi.setFocus).not.toHaveBeenCalled();
    act(() => {
      callbacks!.onOpen?.();
      callbacks!.onPartial?.('hello wor');
    });
    expect(screen.getByText('hello wor')).toBeTruthy();
    expect(screen.getByText('Built-in speech recognition')).toBeTruthy();
    // The OS dictation command is NEVER part of the overlay path.
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('trigger_os_dictation');
  });

  it('shows fallback status in the status text without sending it to paste', async () => {
    let callbacks: SessionCallbacks | null = null;
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return fakeSession('');
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();

    await act(async () => {
      callbacks?.onStatus?.('Recording locally with Whisper; press Space to finish.');
    });

    expect(screen.getByRole('status').textContent).toContain('Recording locally with Whisper');
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('reads speech settings changed in the main window before opening the hidden-window session', async () => {
    useAuthStore.setState({ composerSttProvider: 'system' });
    const saved = JSON.parse(localStorage.getItem('jarvis-auth')!);
    saved.state.composerSttProvider = 'faster-whisper';
    localStorage.setItem('jarvis-auth', JSON.stringify(saved));
    let providerAtStart: string | undefined;
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      providerAtStart = useAuthStore.getState().composerSttProvider;
      cb.onOpen?.();
      return fakeSession('', 'Local faster-whisper');
    });
    try {
      render(<GlobalDictationOverlay />);
      await openOverlay();
      expect(providerAtStart).toBe('faster-whisper');
    } finally {
      useAuthStore.setState({ composerSttProvider: 'system' });
    }
  });

  it('shows a visible error state with Retry and a settings fix path when no engine exists', async () => {
    sessionMocks.createSession.mockRejectedValue(
      new Error(
        'No speech-to-text engine is available. Download a local faster-whisper model or add a ' +
          'Deepgram/Groq key in Settings → Speech to Text. synthetic provider detail',
      ),
    );

    render(<GlobalDictationOverlay />);
    await openOverlay();

    expect(screen.getByText(/No speech-to-text engine is available/)).toBeTruthy();
    expect(screen.getByText(/Global dictation availability/)).toBeTruthy();
    expect(screen.queryByText(/synthetic provider detail/)).toBeNull();
    expect(screen.getByRole('button', { name: /Retry dictation/i })).toBeTruthy();
    // Fix path appears both in the error message and the footer hint.
    expect(screen.getAllByText(/Settings → Speech to Text/).length).toBeGreaterThanOrEqual(1);
  });

  it('Retry restarts the session after an error', async () => {
    sessionMocks.createSession
      .mockRejectedValueOnce(new Error('Microphone permission denied.'))
      .mockImplementation(async (cb: SessionCallbacks) => {
        cb.onOpen?.();
        return fakeSession('');
      });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    expect(
      screen.getByText(/Microphone capture is unavailable or permission was denied/),
    ).toBeTruthy();
    expect(screen.queryByText(/Microphone permission denied/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry dictation/i }));
      await Promise.resolve();
    });

    expect(sessionMocks.createSession).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Listening/)).toBeTruthy();
  });

  it('Enter finalizes through the session and pastes via dictation_paste_text', async () => {
    vi.useFakeTimers();
    let callbacks: SessionCallbacks | null = null;
    const session = fakeSession('ship the release notes');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return session;
    });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => {
      callbacks!.onOpen?.();
      callbacks!.onFinal?.('ship the release notes');
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(session.stop).toHaveBeenCalled();
    expect(tauriMocks.windowApi.hide).toHaveBeenCalled();
    // No arbitrary renderer delay before native focus/key-release validation.
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'ship the release notes',
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'ship the release notes',
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('trigger_os_dictation');
    vi.useRealTimers();
  });

  it('shows progress throughout final transcription and native delivery', async () => {
    let finishTranscription!: () => void;
    let finishHide!: () => void;
    const session = fakeSession('ready to paste');
    session.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTranscription = resolve;
        }),
    );
    tauriMocks.windowApi.hide.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishHide = resolve;
        }),
    );
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });

    const { container } = render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    expect(container.querySelector('[data-dictation-progress="transcribing"]')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Transcribing');

    await act(async () => {
      finishTranscription();
    });
    expect(container.querySelector('[data-dictation-progress="pasting"]')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Pasting');

    await act(async () => {
      finishHide();
    });
    expect(container.querySelector('[data-dictation-progress]')).toBeNull();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'ready to paste',
    });
  });

  it('preserves a batch-transcription diagnostic instead of overwriting it as empty speech', async () => {
    let callbacks: SessionCallbacks | null = null;
    const session = fakeSession('', 'Local faster-whisper');
    session.stop = vi.fn(async () => {
      callbacks?.onError?.(
        'The action failed, sir. Action: Local faster-whisper transcription. ' +
          'Cause: Captured audio could not be transcribed. ' +
          'Check the selected engine and connection, then retry.',
      );
    });
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return session;
    });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => callbacks!.onOpen?.());

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
      await Promise.resolve();
    });

    expect(screen.getByText(/Local faster-whisper transcription/)).toBeTruthy();
    expect(screen.queryByText(/No speech was transcribed/)).toBeNull();
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('paste failure re-shows the overlay with a visible error and fix path', async () => {
    vi.useFakeTimers();
    tauriMocks.invoke.mockRejectedValue(
      new Error('xdotool is required for dictation paste on Linux: synthetic path'),
    );
    let callbacks: SessionCallbacks | null = null;
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return fakeSession('lost words');
    });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => {
      callbacks!.onOpen?.();
      callbacks!.onFinal?.('lost words');
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/Linux dictation paste requires xdotool/)).toBeTruthy();
    expect(screen.queryByText(/synthetic path/)).toBeNull();
    expect(tauriMocks.windowApi.show).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps recording across focus changes and retries the same transcript after a failed paste', async () => {
    const session = { ...fakeSession('words across four pages'), markDeliveryFailed: vi.fn() };
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });
    tauriMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'dictation_paste_text') throw new Error('No editable field');
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();
    for (let page = 0; page < 4; page++) {
      fireEvent.blur(window);
      fireEvent(document, new Event('visibilitychange'));
      fireEvent.focus(window);
    }
    expect(session.cancel).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
    await openOverlay();
    expect(screen.getByText(/Your transcript is kept/)).toBeTruthy();
    expect(session.markDeliveryFailed).toHaveBeenCalledOnce();
    await openOverlay();
    expect(sessionMocks.createSession).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(
      tauriMocks.invoke.mock.calls.filter(([command]) => command === 'dictation_paste_text'),
    ).toEqual([
      ['dictation_paste_text', { text: 'words across four pages' }],
      ['dictation_paste_text', { text: 'words across four pages' }],
    ]);
    tauriMocks.invoke.mockResolvedValue(undefined);
    await openOverlay();
    expect(screen.queryByText(/Your transcript is kept/)).toBeNull();
    expect(session.cancel).not.toHaveBeenCalled();
    await openOverlay();
    expect(sessionMocks.createSession).toHaveBeenCalledTimes(2);
  });

  it('finishes the same take when the second shortcut arrives during startup', async () => {
    let resolveSession!: (session: ReturnType<typeof fakeSession>) => void;
    const session = fakeSession('a quick take');
    sessionMocks.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    await act(async () => {
      resolveSession(session);
    });
    expect(session.stop).toHaveBeenCalledOnce();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'a quick take',
    });
  });

  it('preserves finalized words when hiding fails and Escape discards only the pending delivery', async () => {
    const session = fakeSession('keep until cancelled');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });
    tauriMocks.windowApi.hide.mockRejectedValueOnce(new Error('Window busy'));
    render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    expect(screen.getByText(/Your transcript is kept/)).toBeTruthy();
    expect(session.stop).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: 'Escape' });
    await openOverlay();
    expect(sessionMocks.createSession).toHaveBeenCalledTimes(2);
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('keeps recognized words after a provider interruption and confirms without restarting capture', async () => {
    let callbacks!: SessionCallbacks;
    let text = 'the original take';
    const session = {
      ...fakeSession(''),
      getFinalText: () => text,
      cancel: vi.fn(() => {
        text = '';
      }),
    };
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      cb.onOpen?.();
      return session;
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => {
      callbacks.onPartial?.('continues here');
      callbacks.onError?.('Deepgram dictation connection failed.');
    });
    expect(screen.getByText(/Recognized words are kept/)).toBeTruthy();
    await openOverlay();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'the original take continues here',
    });
    expect(sessionMocks.createSession).toHaveBeenCalledOnce();
  });

  it('suppresses an unknown startup exception behind a precise retry path', async () => {
    sessionMocks.createSession.mockRejectedValue(
      new Error('synthetic dictation startup implementation detail'),
    );

    render(<GlobalDictationOverlay />);
    await openOverlay();

    expect(screen.getByText(/The dictation session could not start/)).toBeTruthy();
    expect(screen.getByText(/selected speech-to-text engine/)).toBeTruthy();
    expect(screen.queryByText(/synthetic dictation startup implementation detail/)).toBeNull();
  });

  it('Escape cancels without pasting', async () => {
    let callbacks: SessionCallbacks | null = null;
    const session = fakeSession('do not paste this');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return session;
    });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => callbacks!.onOpen?.());

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
      await Promise.resolve();
    });

    expect(session.cancel).toHaveBeenCalled();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_cancel');
    expect(tauriMocks.windowApi.hide).toHaveBeenCalled();
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('offers a visible theme-aware Close action on right-click and cancels the take', async () => {
    const session = fakeSession('discard this take');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();

    const panel = screen.getByLabelText('VibeSpace Dictation — drag to move');
    fireEvent.contextMenu(panel);
    const close = screen.getByRole('button', { name: 'Close dictation menu' });
    expect(close.getAttribute('class')).toContain('text-foreground');
    expect(close.closest('.sr-only')).toBeNull();
    await act(async () => {
      fireEvent.click(close);
      await Promise.resolve();
    });

    expect(session.cancel).toHaveBeenCalledOnce();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_cancel');
    expect(tauriMocks.windowApi.hide).toHaveBeenCalled();
  });

  it('retries a transient native hide failure when closing the panel', async () => {
    tauriMocks.windowApi.hide.mockRejectedValueOnce(new Error('Window busy'));
    render(<GlobalDictationOverlay />);
    fireEvent.contextMenu(screen.getByLabelText('VibeSpace Dictation — drag to move'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close dictation menu' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tauriMocks.windowApi.hide).toHaveBeenCalledTimes(2);
  });

  it('keeps Close available with an error when native hide fails twice', async () => {
    tauriMocks.windowApi.hide.mockRejectedValueOnce(new Error('busy'));
    tauriMocks.windowApi.hide.mockRejectedValueOnce(new Error('still busy'));
    render(<GlobalDictationOverlay />);
    fireEvent.contextMenu(screen.getByLabelText('VibeSpace Dictation — drag to move'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close dictation menu' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Could not close dictation/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close dictation menu' })).toBeTruthy();
  });

  it('Space confirms once, but does not double-handle the native Ctrl+Space shortcut', async () => {
    const session = fakeSession('confirmed with space');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();
    fireEvent.keyDown(window, { key: ' ', ctrlKey: true });
    expect(session.stop).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
      fireEvent.keyDown(window, { key: ' ', repeat: true });
    });
    expect(session.stop).toHaveBeenCalledOnce();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_paste_text', {
      text: 'confirmed with space',
    });
  });

  it('serializes rapid toggles while the microphone is starting', async () => {
    let resolveSession!: (session: ReturnType<typeof fakeSession>) => void;
    sessionMocks.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    expect(sessionMocks.createSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSession(fakeSession(''));
    });
  });

  it('cancels a microphone session that opens after Escape', async () => {
    let resolveSession!: (session: ReturnType<typeof fakeSession>) => void;
    const session = fakeSession('late words');
    sessionMocks.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    render(<GlobalDictationOverlay />);
    await openOverlay();
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {
      resolveSession(session);
    });
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('does not paste a transcription that completes after cancellation', async () => {
    let finish!: () => void;
    const session = fakeSession('cancelled words');
    session.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return session;
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    expect(session.stop).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    tauriMocks.windowApi.hide.mockClear();
    await act(async () => {
      finish();
    });
    expect(session.cancel).toHaveBeenCalledOnce();
    expect(tauriMocks.windowApi.hide).not.toHaveBeenCalled();
  });

  it('finishes an empty take quietly and releases its native destination', async () => {
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      cb.onOpen?.();
      return fakeSession('');
    });
    render(<GlobalDictationOverlay />);
    await openOverlay();
    await openOverlay();
    expect(screen.queryByText(/No speech was transcribed/)).toBeNull();
    expect(tauriMocks.windowApi.hide).toHaveBeenCalled();
    expect(tauriMocks.invoke).toHaveBeenCalledWith('dictation_cancel');
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith('dictation_paste_text', expect.anything());
  });

  it('Clear wipes the transcript while a streaming session keeps running', async () => {
    let callbacks: SessionCallbacks | null = null;
    const session = fakeSession('');
    sessionMocks.createSession.mockImplementation(async (cb: SessionCallbacks) => {
      callbacks = cb;
      return session;
    });

    render(<GlobalDictationOverlay />);
    await openOverlay();
    act(() => {
      callbacks!.onOpen?.();
      callbacks!.onPartial?.('some words');
    });
    expect(screen.getByText('some words')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Clear transcript/i }));

    expect(screen.queryByText('some words')).toBeNull();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(screen.getByText(/Listening/)).toBeTruthy();
  });
});

describe('GlobalDictationOverlay MonoChrome appearance', () => {
  function readComponentSource(): string {
    return readFileSync(resolve(__dirname, 'GlobalDictationOverlay.tsx'), 'utf8');
  }

  it('flattens shadow, blur, fill, border, and radius only beneath the canonical MonoChrome gate', () => {
    const source = readComponentSource();

    // Canonical repo-wide MonoChrome gate root: matches monochrome-theme.css
    // and the other shell-overlay appearance tests.
    expect(source).toContain('[html[data-theme=monochrome]_&]:bg-background');
    expect(source).toContain('border-0');
    expect(source).toContain('shadow-none outline-none');
    expect(source).toContain('[html[data-theme=monochrome]_&]:rounded-sm');

    // The loose, non-canonical gate root must be fully normalized away.
    expect(source).not.toContain('[[data-theme=monochrome]_&]:');
  });

  it('keeps the pill small and draggable without a blur layer or microphone icon', () => {
    const source = readComponentSource();

    expect(source).toContain('h-[30px] w-[120px]');
    expect(source).toContain('data-tauri-drag-region');
    expect(source).toContain('/vibespace-icon.png');
    expect(source).not.toContain('backdrop-blur');
    expect(source).not.toContain('<Mic');
  });
});

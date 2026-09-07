/**
 * Voice-panel input adapter.
 *
 * The panel historically talked to Web Speech directly. This adapter keeps
 * its small event API while opening the one STT engine selected in Settings.
 */
import {
  createSelectedSttSession,
  type SelectedSttSession,
} from '@/features/composer-stt/selectedSttSession';
import {
  formatVoiceFailure,
  VOICE_EXCLUSIVE_START_EVENT,
  VOICE_EXCLUSIVE_STOP_EVENT,
  type VoiceErrorKind,
  type VoiceEventMap,
} from './VoiceService';

type Listener<T> = (payload: T) => void;
type AnyListener = Listener<unknown>;

const SAFE_SELECTED_FAILURE_PREFIXES = Object.freeze([
  'The selected local faster-whisper model (',
  'The selected Deepgram model ',
  'The selected built-in system speech engine ',
  'Microphone capture is not available in this runtime.',
  'Another VibeSpace dictation session is already using the microphone.',
  'Built-in speech recognition could not start in this window.',
  'No speech detected for a while',
  'The action failed, sir.',
]);

function dispatchExclusiveEvent(eventName: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(eventName));
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error ?? '').trim();
  if (
    message.length <= 600 &&
    SAFE_SELECTED_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix))
  ) {
    return message;
  }
  return formatVoiceFailure('unknown', 'startup');
}

function classifyFailure(message: string): VoiceErrorKind {
  if (/permission|not allowed|denied/iu.test(message)) return 'permission_denied';
  if (/no speech/iu.test(message)) return 'no_speech';
  if (/microphone capture|audio capture/iu.test(message)) return 'audio_capture';
  if (/network|websocket|connection/iu.test(message)) return 'network';
  if (/unavailable|not available|unsupported/iu.test(message)) return 'unsupported';
  return 'unknown';
}

class JarvisVoiceInputServiceImpl {
  private readonly listeners = new Map<keyof VoiceEventMap, Set<AnyListener>>();
  private session: SelectedSttSession | null = null;
  private pending: Promise<SelectedSttSession> | null = null;
  private active = false;
  private wantsActive = false;
  private streaming = true;
  private finishing = false;
  private generation = 0;
  private inactivityTimeoutMs: number | null = 180_000;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  on<K extends keyof VoiceEventMap>(event: K, listener: Listener<VoiceEventMap[K]>): () => void {
    const listeners = this.listeners.get(event) ?? new Set<AnyListener>();
    listeners.add(listener as AnyListener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as AnyListener);
  }

  private emit<K extends keyof VoiceEventMap>(event: K, payload: VoiceEventMap[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as Listener<VoiceEventMap[K]>)(payload);
      } catch {
        // A presentation listener cannot own or break microphone cleanup.
      }
    }
  }

  isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
  }

  isListening(): boolean {
    return this.active;
  }

  wantsListening(): boolean {
    return this.wantsActive;
  }

  setInactivityTimeoutMs(timeoutMs: number | null): void {
    this.inactivityTimeoutMs = timeoutMs;
    this.armInactivityTimer();
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    if (!this.active || !this.streaming || this.inactivityTimeoutMs === null) return;
    const timeoutMs = this.inactivityTimeoutMs;
    this.inactivityTimer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      this.emit('voice:timeout', {
        reason: `Speech-to-text stopped after ${seconds} second${seconds === 1 ? '' : 's'} without speech activity.`,
      });
      this.cancelListening();
    }, timeoutMs);
  }

  startListening(): boolean {
    if (this.finishing) this.cancelListening();
    if (this.wantsActive || this.active || this.pending) return true;
    if (!this.isSupported()) {
      this.emit('voice:error', {
        kind: 'unsupported',
        message: formatVoiceFailure('unsupported'),
      });
      return false;
    }

    this.wantsActive = true;
    const generation = ++this.generation;
    dispatchExclusiveEvent(VOICE_EXCLUSIVE_START_EVENT);

    const pending = createSelectedSttSession(
      {
        onOpen: () => {
          if (generation !== this.generation || !this.wantsActive) return;
          this.active = true;
          this.emit('voice:start', undefined);
          this.armInactivityTimer();
        },
        onPartial: (text) => {
          if (generation !== this.generation || !this.wantsActive) return;
          this.armInactivityTimer();
          this.emit('voice:partial', { text });
        },
        onFinal: (text) => {
          if (generation !== this.generation || (!this.wantsActive && !this.finishing)) return;
          this.armInactivityTimer();
          this.emit('voice:final', { text });
        },
        onTurnEnd: () => {
          if (generation !== this.generation || !this.wantsActive) return;
          this.emit('voice:turn-end', undefined);
        },
        onError: (message) => {
          if (generation !== this.generation || (!this.wantsActive && !this.finishing)) return;
          const safeMessage = safeFailureMessage(new Error(message));
          this.emit('voice:error', {
            kind: classifyFailure(safeMessage),
            message: safeMessage,
          });
        },
        onClose: () => {
          if (generation !== this.generation) return;
          this.finishSession();
        },
      },
      { supersedeActive: true, requester: 'jarvis-voice' },
    );
    this.pending = pending;
    void pending.then(
      (session) => {
        if (this.pending === pending) this.pending = null;
        if (generation !== this.generation || !this.wantsActive) {
          session.cancel();
          return;
        }
        this.session = session;
        this.streaming = session.streaming;
        // Only the capture engine's onOpen event proves it is listening.
        this.armInactivityTimer();
      },
      (error) => {
        if (this.pending === pending) this.pending = null;
        if (generation !== this.generation || !this.wantsActive) return;
        this.wantsActive = false;
        const message = safeFailureMessage(error);
        this.emit('voice:error', { kind: classifyFailure(message), message });
        this.finishSession();
      },
    );
    return true;
  }

  stopListening(): void {
    this.wantsActive = false;
    this.clearInactivityTimer();
    const session = this.session;
    if (!session) { this.cancelListening(); return; }
    if (this.finishing) return;
    this.active = false;
    this.finishing = true;
    const generation = this.generation;
    void session.stop().then(() => {
      if (generation === this.generation && this.finishing) this.finishSession();
    }, (error) => {
      if (generation !== this.generation) return;
      const message = safeFailureMessage(error);
      this.emit('voice:error', { kind: classifyFailure(message), message });
      this.finishSession();
    });
  }

  cancelListening(): void {
    // Invalidate old startup and engine callbacks before cancelling capture.
    this.generation += 1;
    this.wantsActive = false;
    this.clearInactivityTimer();
    const session = this.session;
    this.session = null;
    if (session) session.cancel();
    this.finishSession();
  }

  private finishSession(): void {
    const wasOpen = this.active || this.finishing || this.pending !== null;
    this.finishing = false;
    this.active = false;
    this.wantsActive = false;
    this.streaming = true;
    this.session = null;
    this.pending = null;
    this.clearInactivityTimer();
    if (wasOpen) {
      this.emit('voice:end', undefined);
      dispatchExclusiveEvent(VOICE_EXCLUSIVE_STOP_EVENT);
    }
  }
}

export function createJarvisVoiceInputService(): JarvisVoiceInputServiceImpl {
  return new JarvisVoiceInputServiceImpl();
}

export const JarvisVoiceInputService = createJarvisVoiceInputService();

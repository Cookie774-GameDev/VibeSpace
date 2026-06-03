/**
 * Browser-side voice service. Wraps the Web Speech API
 * (`window.SpeechRecognition` / `window.webkitSpeechRecognition`) so the V1
 * voice modal has *some* working transcription path on Chromium-based hosts
 * (Tauri Windows uses WebView2 which supports it).
 *
 * Real ASR/TTS comes in Phase 3 via the Pipecat sidecar. Until then, this
 * service:
 *  - feature-detects the Web Speech API
 *  - emits typed events the modal can wire into the voice store
 *  - falls back to a "voice will work in Phase 3" toast if the API is missing
 *
 * The service is a *singleton*. Import the named export `VoiceService`.
 */

// ---------------------------------------------------------------------------
// Minimal ambient types for the Web Speech API (avoids relying on lib.dom
// versions that may or may not include them, and pins the shape we use).
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}
interface ISpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onstart: ((e: Event) => void) | null;
  onend: ((e: Event) => void) | null;
  onnomatch: ((e: Event) => void) | null;
}
type SpeechRecognitionCtor = new () => ISpeechRecognition;

// ---------------------------------------------------------------------------
// Typed event emitter (no external dep). Generic over the event map so
// callers get autocomplete on event names and payloads.
// ---------------------------------------------------------------------------

export type VoiceEventMap = {
  'voice:start': void;
  'voice:end': void;
  'voice:partial': { text: string };
  'voice:final': { text: string };
  'voice:timeout': { reason: string };
  'voice:error': { kind: VoiceErrorKind; message: string };
};

export type VoiceErrorKind =
  | 'unsupported'
  | 'permission_denied'
  | 'no_speech'
  | 'aborted'
  | 'audio_capture'
  | 'network'
  | 'service_not_allowed'
  | 'unknown';

type Listener<T> = (payload: T) => void;
type AnyListener = Listener<unknown>;

class VoiceEmitter {
  private readonly listeners = new Map<keyof VoiceEventMap, Set<AnyListener>>();

  on<K extends keyof VoiceEventMap>(event: K, fn: Listener<VoiceEventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<AnyListener>();
      this.listeners.set(event, set);
    }
    set.add(fn as AnyListener);
    return () => {
      this.listeners.get(event)?.delete(fn as AnyListener);
    };
  }

  off<K extends keyof VoiceEventMap>(event: K, fn: Listener<VoiceEventMap[K]>): void {
    this.listeners.get(event)?.delete(fn as AnyListener);
  }

  protected emit<K extends keyof VoiceEventMap>(event: K, payload: VoiceEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.forEach((fn) => {
      try {
        (fn as Listener<VoiceEventMap[K]>)(payload);
      } catch (err) {
        // Don't let one bad listener kill the rest of the chain.
        console.error('[VoiceService] listener threw', err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// VoiceService implementation
// ---------------------------------------------------------------------------

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function mapErrorKind(raw: string): VoiceErrorKind {
  switch (raw) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'service_not_allowed';
    case 'permission-denied':
      return 'permission_denied';
    case 'no-speech':
      return 'no_speech';
    case 'aborted':
      return 'aborted';
    case 'audio-capture':
      return 'audio_capture';
    case 'network':
      return 'network';
    default:
      return 'unknown';
  }
}

class VoiceServiceImpl extends VoiceEmitter {
  private recognition: ISpeechRecognition | null = null;
  private active = false;
  private wantsActive = false;
  private langPref = 'en-US';
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private armInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      this.wantsActive = false;
      this.emit('voice:timeout', {
        reason: 'Speech-to-text stopped after 30 seconds without speech activity.',
      });
      this.stopListening();
    }, 30_000);
  }

  /** True if the host browser supports the Web Speech API. */
  isSupported(): boolean {
    return getRecognitionCtor() !== null;
  }

  /** True if a recognition session is currently running. */
  isListening(): boolean {
    return this.active;
  }

  /** Set the BCP-47 language tag used for recognition. Default is en-US. */
  setLanguage(lang: string): void {
    this.langPref = lang;
    if (this.recognition) this.recognition.lang = lang;
  }

  /**
   * Begin a recognition session. Resolves immediately (the API is event-based);
   * actual transcripts arrive via 'voice:partial' / 'voice:final' events.
   *
   * No-op if already listening. Emits 'voice:error' with kind=unsupported
   * when the Web Speech API is missing.
   */
  startListening(): void {
    if (this.active) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.emit('voice:error', {
        kind: 'unsupported',
        message: 'Voice will work in Phase 3 (Pipecat sidecar).',
      });
      return;
    }

    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.lang = this.langPref;

    r.onstart = () => {
      this.active = true;
      this.armInactivityTimer();
      this.emit('voice:start', undefined);
    };

    r.onresult = (event) => {
      this.armInactivityTimer();
      let interim = '';
      const finals: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          const t = alt.transcript.trim();
          if (t) finals.push(t);
        } else {
          interim += alt.transcript;
        }
      }
      const interimTrimmed = interim.trim();
      if (interimTrimmed) {
        this.emit('voice:partial', { text: interimTrimmed });
      }
      for (const text of finals) {
        this.emit('voice:final', { text });
      }
    };

    r.onerror = (event) => {
      const kind = mapErrorKind(event.error);
      // Permission/hardware errors are terminal: don't auto-restart in
      // `onend` or we get a 16-times-per-second restart loop until the
      // user closes the modal (the audit's high-severity finding).
      // The user has to grant permission / fix the device and click
      // mic again. `no_speech` and `aborted` stay restartable because
      // the engine emits them routinely on idle / Chromium's ~60 s
      // session cap.
      if (
        kind === 'permission_denied' ||
        kind === 'service_not_allowed' ||
        kind === 'audio_capture' ||
        kind === 'unsupported'
      ) {
        this.wantsActive = false;
      }
      this.emit('voice:error', {
        kind,
        message: event.message || event.error || 'Voice recognition error',
      });
    };

    // Capture `r` in the onend closure so a stale onend from a prior
    // recognition (which may fire after a new one has already been
    // assigned to `this.recognition`) doesn't null out the live
    // pointer. The audit's medium-severity rapid-toggle race.
    r.onend = () => {
      this.active = false;
      this.clearInactivityTimer();
      if (this.recognition === r) {
        this.recognition = null;
      }
      // If the user wants to keep listening but the engine timed out (common
      // with Chromium's ~60 s cap), restart transparently.
      const shouldRestart = this.wantsActive;
      this.emit('voice:end', undefined);
      if (shouldRestart) {
        // Defer to the next tick so listeners observing 'voice:end' see
        // active=false before we flip it back on.
        setTimeout(() => {
          if (this.wantsActive) this.startListening();
        }, 60);
      }
    };

    this.recognition = r;
    this.wantsActive = true;
    try {
      r.start();
    } catch (err) {
      // Some browsers throw if start() is called too quickly after stop().
      this.emit('voice:error', {
        kind: 'unknown',
        message: err instanceof Error ? err.message : 'Failed to start recognition',
      });
      this.clearInactivityTimer();
      this.recognition = null;
      this.active = false;
      this.wantsActive = false;
    }
  }

  /** Stop the current recognition session. No-op if not listening. */
  stopListening(): void {
    this.wantsActive = false;
    this.clearInactivityTimer();
    const r = this.recognition;
    if (!r) {
      this.active = false;
      return;
    }
    try {
      r.stop();
    } catch {
      // ignore - some implementations throw if stop() called pre-start
    }
  }

  /** Hard cancel: abort the session and discard any pending result. */
  abort(): void {
    this.wantsActive = false;
    this.clearInactivityTimer();
    const r = this.recognition;
    if (!r) return;
    try {
      r.abort();
    } catch {
      // ignore
    }
  }
}

/**
 * Singleton instance. Importable as `VoiceService` from `@/features/voice`.
 */
export const VoiceService = new VoiceServiceImpl();

export type { VoiceServiceImpl };

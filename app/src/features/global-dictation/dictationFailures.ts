import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import { formatVoiceFailure, type VoiceErrorKind } from '@/features/voice/VoiceService';

type BatchDictationEngine = 'faster-whisper' | 'web-speech' | 'deepgram' | 'groq';

export const NO_DICTATION_ENGINE_REASON =
  'No speech-to-text engine is available. Download a local faster-whisper model or add a ' +
  'Deepgram/Groq key in Settings → Speech to Text. VibeSpace dictation never uses Windows Win+H.';

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
}

function failure(actionLabel: string, reason: string): string {
  return formatJarvisVerifiedNarration({
    kind: 'failure',
    actionLabel,
    reason,
  }).text;
}

export function formatGlobalDictationStartupFailure(cause: unknown): string {
  const message = errorText(cause);
  if (message.includes('No speech-to-text engine is available')) {
    return failure('Global dictation availability', NO_DICTATION_ENGINE_REASON);
  }
  if (/microphone.*(?:permission|capture)|permission.*microphone/iu.test(message)) {
    return failure(
      'Global dictation microphone',
      'Microphone capture is unavailable or permission was denied. ' +
        'Allow microphone access for VibeSpace, then retry',
    );
  }
  return failure(
    'Global dictation startup',
    'The dictation session could not start. Check microphone access and the selected ' +
      'speech-to-text engine, then retry',
  );
}

export function formatGlobalDictationSessionFailure(message: string): string {
  if (TRUSTED_SESSION_FAILURES.has(message)) {
    return message;
  }
  if (message === 'Deepgram dictation connection failed.') {
    return failure(
      'Deepgram dictation connection',
      'Deepgram could not connect for live dictation. ' +
        'Check the network and voice-key configuration, then retry',
    );
  }
  if (/no speech detected/iu.test(message)) {
    return failure(
      'Global dictation recognition',
      'No speech was detected. Press Retry and speak again',
    );
  }
  return failure(
    'Global dictation recognition',
    'The selected speech-to-text engine stopped before completing the transcript. ' +
      'Check its connection and configuration, then retry',
  );
}

export function formatGlobalDictationTranscriptionFailure(engine: BatchDictationEngine): string {
  const engineLabel: Record<BatchDictationEngine, string> = {
    'faster-whisper': 'Local faster-whisper',
    'web-speech': 'Built-in speech recognition',
    deepgram: 'Deepgram',
    groq: 'Groq Whisper',
  };
  return failure(
    `${engineLabel[engine]} transcription`,
    'Captured audio could not be transcribed. Check the selected engine and connection, then retry',
  );
}

const VOICE_ERROR_KINDS: readonly VoiceErrorKind[] = [
  'unsupported',
  'permission_denied',
  'service_not_allowed',
  'no_speech',
  'aborted',
  'audio_capture',
  'network',
  'unknown',
];

const TRUSTED_SESSION_FAILURES = new Set<string>([
  ...VOICE_ERROR_KINDS.map((kind) => formatVoiceFailure(kind)),
  formatVoiceFailure('unknown', 'startup'),
  formatGlobalDictationTranscriptionFailure('faster-whisper'),
  formatGlobalDictationTranscriptionFailure('groq'),
]);

export function formatGlobalDictationEmptyFailure(): string {
  return failure(
    'Global dictation transcription',
    'No speech was transcribed. Press Retry and speak again',
  );
}

export function formatGlobalDictationPasteFailure(cause: unknown): string {
  if (/xdotool/iu.test(errorText(cause))) {
    return failure(
      'Global dictation paste',
      'Linux dictation paste requires xdotool. ' +
        'Install xdotool, restore focus to the target app, then retry',
    );
  }
  return failure(
    'Global dictation paste',
    'The transcript could not be pasted into the selected text field. ' +
      'Restore focus and confirm input permission, then retry',
  );
}

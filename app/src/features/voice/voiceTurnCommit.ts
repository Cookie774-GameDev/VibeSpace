import type { VoiceEndTrigger } from './voiceConversation';

export const VOICE_COMMIT_PHRASE_DEFAULT = 'send it';
export const VOICE_CANCEL_PHRASE_DEFAULT = 'cancel';
export const VOICE_COMMIT_PHRASE_MIN_LEN = 2;
export const VOICE_COMMIT_PHRASE_MAX_LEN = 30;
export const VOICE_REPLY_COOLDOWN_MS = 400;

/** Normalize spoken text for phrase matching (same rules as wake-word). */
export function normalizeVoicePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function clampVoiceCommitPhrase(phrase: string): string {
  const trimmed = phrase.trim().replace(/\s+/g, ' ');
  if (!trimmed) return VOICE_COMMIT_PHRASE_DEFAULT;
  if (trimmed.length < VOICE_COMMIT_PHRASE_MIN_LEN) return VOICE_COMMIT_PHRASE_DEFAULT;
  if (trimmed.length > VOICE_COMMIT_PHRASE_MAX_LEN) {
    return trimmed.slice(0, VOICE_COMMIT_PHRASE_MAX_LEN).trimEnd();
  }
  return trimmed;
}

export function clampVoiceCancelPhrase(phrase: string): string {
  const trimmed = phrase.trim().replace(/\s+/g, ' ');
  if (!trimmed) return VOICE_CANCEL_PHRASE_DEFAULT;
  if (trimmed.length < VOICE_COMMIT_PHRASE_MIN_LEN) return VOICE_CANCEL_PHRASE_DEFAULT;
  if (trimmed.length > VOICE_COMMIT_PHRASE_MAX_LEN) {
    return trimmed.slice(0, VOICE_COMMIT_PHRASE_MAX_LEN).trimEnd();
  }
  return trimmed;
}

function transcriptEndsWithPhrase(transcript: string, phrase: string): boolean {
  const normalizedTranscript = normalizeVoicePhrase(transcript);
  const normalizedPhrase = normalizeVoicePhrase(phrase);
  if (!normalizedPhrase) return false;
  return (
    normalizedTranscript === normalizedPhrase ||
    normalizedTranscript.endsWith(` ${normalizedPhrase}`)
  );
}

/** Strip a trailing commit phrase and return the user message body. */
export function stripCommitPhrase(transcript: string, phrase: string): string {
  const normalizedTranscript = normalizeVoicePhrase(transcript);
  const normalizedPhrase = normalizeVoicePhrase(phrase);
  if (!normalizedPhrase || normalizedTranscript === normalizedPhrase) return '';
  if (!normalizedTranscript.endsWith(` ${normalizedPhrase}`)) return transcript.trim();
  return normalizedTranscript.slice(0, normalizedTranscript.length - normalizedPhrase.length).trim();
}

export function detectCommitPhrase(
  transcript: string,
  phrase: string,
): { committed: boolean; messageText: string } {
  if (!transcriptEndsWithPhrase(transcript, phrase)) {
    return { committed: false, messageText: transcript.trim() };
  }
  return { committed: true, messageText: stripCommitPhrase(transcript, phrase) };
}

export function detectCancelPhrase(transcript: string, phrase: string): boolean {
  return transcriptEndsWithPhrase(transcript, phrase);
}

/** Click-to-talk always uses silence; hands-free defaults to commit phrase. */
export function shouldAutoSendOnSilence(handsFree: boolean, endTrigger: VoiceEndTrigger): boolean {
  if (!handsFree) return true;
  return endTrigger === 'silence';
}

export type VoiceFinalAction =
  | { type: 'ignore' }
  | { type: 'cancel'; draft: '' }
  | { type: 'accumulate'; draft: string }
  | { type: 'commit'; draft: ''; messageText: string }
  | { type: 'schedule_flush'; draft: string };

/** Pure turn-taking decision for a finalized speech segment. */
export function processVoiceFinalEvent(options: {
  finalText: string;
  currentDraft: string;
  turnBusy: boolean;
  handsFree: boolean;
  endTrigger: VoiceEndTrigger;
  commitPhrase: string;
  cancelPhrase: string;
}): VoiceFinalAction {
  if (options.turnBusy) return { type: 'ignore' };

  const draft = `${options.currentDraft} ${options.finalText}`.trim();
  if (!draft) return { type: 'accumulate', draft: '' };

  if (detectCancelPhrase(draft, options.cancelPhrase)) {
    return { type: 'cancel', draft: '' };
  }

  const usePhraseGate = options.handsFree && options.endTrigger === 'phrase';
  if (usePhraseGate) {
    const { committed, messageText } = detectCommitPhrase(draft, options.commitPhrase);
    if (committed) {
      return { type: 'commit', draft: '', messageText };
    }
    return { type: 'accumulate', draft };
  }

  return { type: 'schedule_flush', draft };
}

export function voiceListeningHint(commitPhrase: string, handsFree: boolean, endTrigger: VoiceEndTrigger): string {
  if (handsFree && endTrigger === 'phrase') {
    return `Say "${commitPhrase}" when done`;
  }
  return 'Listening';
}

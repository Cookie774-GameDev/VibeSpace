import type { JarvisEventRepository, JarvisRunRepository } from '@/lib/db/jarvisRepositories';
import type {
  JarvisCanonicalLiveProducerEvidence,
  JarvisCanonicalLiveProducerVerifier,
  JarvisEvent,
  JarvisProducerSourceEvidenceV1,
} from '@/lib/jarvis/contracts/execution';
import { canonicalizeJarvisApprovalJson } from '@/lib/jarvis/contracts/execution';
import type { VoiceEndTrigger } from './voiceConversation';

type VoiceSourceEvidence = Extract<JarvisProducerSourceEvidenceV1, { producerKind: 'voice' }>;

export type JarvisVoiceLiveEvidenceVerifier = JarvisCanonicalLiveProducerVerifier<'voice'> &
  Readonly<{
    authorizeStart(source: Readonly<VoiceSourceEvidence>): () => void;
    dispose(): void;
  }>;

const VOICE_SOURCE_COMMON_KEYS = [
  'accountId',
  'attemptNumber',
  'observedAt',
  'producerIdentity',
  'producerKind',
  'requestId',
  'resultRef',
  'runId',
  'schemaVersion',
] as const;

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function stableVoiceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function sameVoiceValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJarvisApprovalJson(left) === canonicalizeJarvisApprovalJson(right);
  } catch {
    return false;
  }
}

function validVoiceSourceShape(source: VoiceSourceEvidence): boolean {
  const identity = source.producerIdentity;
  const phaseKeys = source.phase === 'start' ? ['phase', 'state'] : ['phase', 'state'];
  return (
    exactKeys(source, [...VOICE_SOURCE_COMMON_KEYS, ...phaseKeys]) &&
    exactKeys(identity, ['producerKind', 'sessionId', 'engineKind', 'executionId']) &&
    source.schemaVersion === 1 &&
    source.producerKind === 'voice' &&
    identity.producerKind === 'voice' &&
    stableVoiceIdentifier(source.accountId) &&
    stableVoiceIdentifier(source.runId) &&
    stableVoiceIdentifier(source.requestId) &&
    Number.isSafeInteger(source.attemptNumber) &&
    source.attemptNumber > 0 &&
    stableVoiceIdentifier(source.resultRef) &&
    Number.isFinite(source.observedAt) &&
    stableVoiceIdentifier(identity.sessionId) &&
    (identity.engineKind === 'tts' || identity.engineKind === 'playback') &&
    stableVoiceIdentifier(identity.executionId) &&
    (source.phase === 'start'
      ? source.state === 'started' || source.state === 'ready' || source.state === 'busy'
      : source.state === 'completed' || source.state === 'degraded')
  );
}

function voiceEventType(source: VoiceSourceEvidence): JarvisEvent['type'] {
  return source.producerIdentity.engineKind === 'tts' ? 'model' : 'terminal';
}

function sourceOwnsEvidence(
  source: VoiceSourceEvidence,
  evidence: JarvisCanonicalLiveProducerEvidence<'voice'>,
): boolean {
  return (
    source.accountId === evidence.accountId &&
    source.runId === evidence.runId &&
    source.requestId === evidence.requestId &&
    source.attemptNumber === evidence.attemptNumber &&
    sameVoiceValue(source.producerIdentity, evidence.producerIdentity)
  );
}

function eventVoiceSource(event: JarvisEvent | undefined): VoiceSourceEvidence | null {
  const source = event?.producerSourceEvidence;
  if (!source || source.producerKind !== 'voice' || !validVoiceSourceShape(source)) return null;
  return source;
}

function activeVoiceSourceKey(source: Readonly<VoiceSourceEvidence>): string {
  return canonicalizeJarvisApprovalJson({
    accountId: source.accountId,
    runId: source.runId,
    requestId: source.requestId,
    attemptNumber: source.attemptNumber,
    producerIdentity: source.producerIdentity,
  });
}

/** @internal Imported in production only by app/src/lib/ai/runtime.ts. */
export function createJarvisVoiceLiveEvidenceVerifier(input: {
  runs: JarvisRunRepository;
  events: JarvisEventRepository;
}): JarvisVoiceLiveEvidenceVerifier {
  const activeStarts = new Map<string, Readonly<VoiceSourceEvidence>>();
  let disposed = false;
  return Object.freeze({
    authorizeStart(source: Readonly<VoiceSourceEvidence>) {
      if (disposed) throw new Error('voice_live_evidence_verifier_disposed');
      if (!validVoiceSourceShape(source) || source.phase !== 'start') {
        throw new TypeError('voice_live_evidence_start_invalid');
      }
      const key = activeVoiceSourceKey(source);
      const snapshot = Object.freeze(structuredClone(source));
      activeStarts.set(key, snapshot);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (activeStarts.get(key) === snapshot) activeStarts.delete(key);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeStarts.clear();
    },
    async verify(evidence: JarvisCanonicalLiveProducerEvidence<'voice'>) {
      try {
        if (disposed) return null;
        if (
          evidence.schemaVersion !== 1 ||
          evidence.producerKind !== 'voice' ||
          evidence.producerIdentity.producerKind !== 'voice' ||
          !stableVoiceIdentifier(evidence.accountId) ||
          !stableVoiceIdentifier(evidence.runId) ||
          !stableVoiceIdentifier(evidence.requestId) ||
          !Number.isSafeInteger(evidence.attemptNumber) ||
          evidence.attemptNumber < 1 ||
          !Number.isSafeInteger(evidence.resultEventSeq) ||
          evidence.resultEventSeq < 1 ||
          !stableVoiceIdentifier(evidence.resultRef) ||
          !Number.isFinite(evidence.verifiedAt) ||
          !['started', 'ready', 'busy', 'completed', 'degraded'].includes(evidence.state)
        ) {
          return null;
        }
        if (
          !exactKeys(evidence.producerIdentity, [
            'producerKind',
            'sessionId',
            'engineKind',
            'executionId',
          ])
        ) {
          return null;
        }

        const run = await input.runs.getById(evidence.accountId, evidence.runId);
        if (
          !run ||
          run.id !== evidence.runId ||
          run.accountId !== evidence.accountId ||
          run.source !== 'voice'
        ) {
          return null;
        }
        const attempt = run.transportAttempts?.find(
          (candidate) =>
            candidate.requestId === evidence.requestId &&
            candidate.attemptNumber === evidence.attemptNumber,
        );
        if (!attempt || attempt.startedEventSeq >= evidence.resultEventSeq) return null;

        const target = await input.events.getBySeq(
          evidence.accountId,
          evidence.runId,
          evidence.resultEventSeq,
        );
        const targetSource = eventVoiceSource(target);
        if (
          !target ||
          !targetSource ||
          target.type !== voiceEventType(targetSource) ||
          !sourceOwnsEvidence(targetSource, evidence)
        ) {
          return null;
        }

        if (
          evidence.state === 'started' ||
          evidence.state === 'ready' ||
          evidence.state === 'busy'
        ) {
          if (
            target.status !== 'running' ||
            targetSource.phase !== 'start' ||
            targetSource.resultRef !== evidence.resultRef ||
            targetSource.observedAt !== evidence.verifiedAt
          ) {
            return null;
          }
          const active = activeStarts.get(activeVoiceSourceKey(targetSource));
          if (!active || !sameVoiceValue(active, targetSource)) return null;
          return Object.freeze(structuredClone(evidence));
        }

        const tail = await input.events.listByRun(evidence.accountId, evidence.runId, {
          afterSeq: attempt.startedEventSeq,
          limit: 1_024,
        });
        const ownerRows = tail.filter((row) => {
          const source = eventVoiceSource(row);
          return source !== null && sourceOwnsEvidence(source, evidence);
        });
        if (ownerRows.length !== 2) return null;
        const [startRow, resultRow] = ownerRows;
        const startSource = eventVoiceSource(startRow);
        const resultSource = eventVoiceSource(resultRow);
        if (
          !startRow ||
          !resultRow ||
          !startSource ||
          !resultSource ||
          startRow.seq >= resultRow.seq ||
          resultRow.seq !== evidence.resultEventSeq ||
          startRow.type !== voiceEventType(startSource) ||
          resultRow.type !== voiceEventType(resultSource) ||
          startRow.status !== 'running' ||
          resultRow.status !== evidence.state ||
          startSource.phase !== 'start' ||
          resultSource.phase !== 'result' ||
          resultSource.state !== evidence.state ||
          resultSource.resultRef !== evidence.resultRef ||
          resultSource.observedAt !== evidence.verifiedAt ||
          !sameVoiceValue(resultRow, target)
        ) {
          return null;
        }
        return Object.freeze(structuredClone(evidence));
      } catch {
        return null;
      }
    },
  });
}

export const VOICE_COMMIT_PHRASE_DEFAULT = 'send it';
export const VOICE_CANCEL_PHRASE_DEFAULT = 'cancel';
export const VOICE_COMMIT_PHRASE_MIN_LEN = 2;
export const VOICE_COMMIT_PHRASE_MAX_LEN = 30;
export const VOICE_REPLY_COOLDOWN_MS = 80;

/** Normalize spoken text for phrase matching (same rules as wake-word). */
export function normalizeVoicePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return normalizedTranscript
    .slice(0, normalizedTranscript.length - normalizedPhrase.length)
    .trim();
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

export function voiceListeningHint(
  commitPhrase: string,
  handsFree: boolean,
  endTrigger: VoiceEndTrigger,
): string {
  if (handsFree && endTrigger === 'phrase') {
    return `Say "${commitPhrase}" when done`;
  }
  return 'Listening';
}

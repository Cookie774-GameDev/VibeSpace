import { hashJarvisText } from '@/lib/jarvis/identity';

const VERSION = 1;
const MAX_PROMPT_CHARS = 16_000;
const MAX_PURPOSE_CHARS = 500;
const MAX_ATTACHMENTS = 16;
const MAX_TTL_MS = 15 * 60_000;
const MAX_RECORDS = 128;
const MAX_STORED_CHARS = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/u;
const EVIDENCE_REF = /^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/u;
const SECRET = /(?:bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+)/i;
const STORAGE_PREFIX = 'vibespace.browser-native-handoff.v1';

export type BrowserNativeHandoffTrust = 'user_approved' | 'external_untrusted';

export interface BrowserNativeAttachmentReference {
  readonly attachmentRef: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly trust: 'user_approved';
}

export interface BrowserNativeExpectedArtifact {
  readonly schemaId: string;
  readonly mediaType: string;
  readonly maximumBytes: number;
}

export interface BrowserNativeHandoffRequest {
  readonly accountId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly chatId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId?: string;
  readonly browserOrigin: string;
  readonly browserTabId: string;
  readonly approvalId: string;
  readonly reviewId: string;
  readonly visiblePrompt: string;
  readonly purpose: string;
  readonly attachments: readonly BrowserNativeAttachmentReference[];
  readonly expectedArtifact: BrowserNativeExpectedArtifact;
  readonly checkpointSequence: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly idempotencyKey: string;
}

export interface BrowserNativeHandoffEnvelope extends BrowserNativeHandoffRequest {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly promptHash: string;
  readonly bindingHash: string;
  readonly trust: 'user_approved';
}

export interface BrowserNativeHandoffReturn {
  readonly handoffId: string;
  readonly bindingHash: string;
  readonly checkpointSequence: number;
  readonly schemaId: string;
  readonly artifactRef: string;
  readonly evidenceRef: string;
  readonly artifactHash: string;
  readonly artifactBytes: number;
  readonly trust: 'external_untrusted';
}

export interface BrowserNativeHandoffReceipt {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly bindingHash: string;
  readonly resultHash: string;
  readonly artifactRef: string;
  readonly evidenceRef: string;
  readonly schemaId: string;
  readonly artifactHash: string;
  readonly artifactBytes: number;
  readonly checkpointSequence: number;
  readonly acceptedAt: number;
  readonly trust: 'external_untrusted';
  readonly completionAuthority: 'none';
}

export interface BrowserNativeHandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserNativeHandoffRuntime {
  issue(request: BrowserNativeHandoffRequest): Promise<BrowserNativeHandoffEnvelope>;
  accept(
    envelope: BrowserNativeHandoffEnvelope,
    returned: BrowserNativeHandoffReturn,
    observedAt: number,
  ): Promise<BrowserNativeHandoffReceipt>;
  recover(
    accountId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<BrowserNativeHandoffEnvelope | undefined>;
  getReceipt(
    accountId: string,
    projectId: string,
    handoffId: string,
  ): Promise<BrowserNativeHandoffReceipt | undefined>;
}

type StoredRecord = Readonly<{
  envelope: BrowserNativeHandoffEnvelope;
  receipt?: BrowserNativeHandoffReceipt;
}>;

const REQUEST_KEYS = new Set([
  'accountId', 'projectId', 'runId', 'chatId', 'providerId', 'modelId', 'connectionId',
  'browserOrigin', 'browserTabId', 'approvalId', 'reviewId', 'visiblePrompt', 'purpose',
  'attachments', 'expectedArtifact', 'checkpointSequence', 'issuedAt', 'expiresAt',
  'idempotencyKey',
]);
const ATTACHMENT_KEYS = new Set([
  'attachmentRef', 'name', 'mediaType', 'sizeBytes', 'sha256', 'trust',
]);
const ARTIFACT_KEYS = new Set(['schemaId', 'mediaType', 'maximumBytes']);
const ENVELOPE_KEYS = new Set([...REQUEST_KEYS, 'schemaVersion', 'handoffId', 'promptHash', 'bindingHash', 'trust']);
const RETURN_KEYS = new Set([
  'handoffId', 'bindingHash', 'checkpointSequence', 'schemaId', 'artifactRef',
  'evidenceRef', 'artifactHash', 'artifactBytes', 'trust',
]);
const RECEIPT_KEYS = new Set([
  'schemaVersion', 'handoffId', 'bindingHash', 'resultHash', 'artifactRef', 'evidenceRef',
  'schemaId', 'artifactHash', 'artifactBytes', 'checkpointSequence', 'acceptedAt', 'trust',
  'completionAuthority',
]);

function exactRecord(value: unknown, keys: ReadonlySet<string>, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  if (Reflect.ownKeys(record).some((key) => typeof key !== 'string' || !keys.has(key))) {
    throw new Error(message);
  }
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !('value' in descriptor)) throw new Error(message);
  }
  return record;
}

function safeText(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid browser-native ${name}.`);
  }
  return value;
}

function safeId(value: unknown, name: string): string {
  const id = safeText(value, 160, name);
  if (!SAFE_ID.test(id)) throw new Error(`Invalid browser-native ${name}.`);
  return id;
}

function safeOrigin(value: unknown): string {
  const text = safeText(value, 2_048, 'browser origin');
  try {
    const url = new URL(text);
    if (url.origin !== text || !['https:', 'http:'].includes(url.protocol)) throw new Error();
    return text;
  } catch {
    throw new Error('Invalid browser-native browser origin.');
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stable((value as Record<string, unknown>)[key]);
  }
  return output;
}

function scopeKey(accountId: string, projectId: string): string {
  return `${STORAGE_PREFIX}:${accountId.length}:${accountId}:${projectId}`;
}

function defaultStorage(): BrowserNativeHandoffStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function validateRequest(candidate: BrowserNativeHandoffRequest): BrowserNativeHandoffRequest {
  const value = exactRecord(candidate, REQUEST_KEYS, 'Invalid browser-native handoff request.');
  const visiblePrompt = safeText(value.visiblePrompt, MAX_PROMPT_CHARS, 'visible prompt');
  const purpose = safeText(value.purpose, MAX_PURPOSE_CHARS, 'purpose');
  if (SECRET.test(visiblePrompt) || SECRET.test(purpose)) {
    throw new Error('Raw credentials are forbidden in browser-native handoffs.');
  }
  if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS) {
    throw new Error('Invalid browser-native attachment references.');
  }
  const attachmentRefs = new Set<string>();
  const attachments = value.attachments.map((candidateAttachment) => {
    const attachment = exactRecord(
      candidateAttachment,
      ATTACHMENT_KEYS,
      'Invalid browser-native attachment reference.',
    );
    const attachmentRef = safeId(attachment.attachmentRef, 'attachment reference');
    if (!attachmentRef.startsWith('jattachment_') || attachmentRefs.has(attachmentRef)) {
      throw new Error('Invalid or duplicate browser-native attachment reference.');
    }
    attachmentRefs.add(attachmentRef);
    if (
      attachment.trust !== 'user_approved' ||
      typeof attachment.sizeBytes !== 'number' ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes < 0 ||
      typeof attachment.sha256 !== 'string' ||
      !SHA256.test(attachment.sha256)
    ) {
      throw new Error('Browser-native attachment is not approved metadata.');
    }
    return Object.freeze({
      attachmentRef,
      name: safeText(attachment.name, 255, 'attachment name'),
      mediaType: safeText(attachment.mediaType, 160, 'attachment media type'),
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      trust: 'user_approved' as const,
    });
  });
  const expected = exactRecord(
    value.expectedArtifact,
    ARTIFACT_KEYS,
    'Invalid browser-native expected artifact contract.',
  );
  if (
    typeof expected.maximumBytes !== 'number' ||
    !Number.isSafeInteger(expected.maximumBytes) ||
    expected.maximumBytes <= 0 ||
    expected.maximumBytes > MAX_STORED_CHARS
  ) {
    throw new Error('Invalid browser-native expected artifact size.');
  }
  if (
    typeof value.checkpointSequence !== 'number' ||
    !Number.isSafeInteger(value.checkpointSequence) ||
    value.checkpointSequence < 0 ||
    typeof value.issuedAt !== 'number' ||
    !Number.isSafeInteger(value.issuedAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= value.issuedAt ||
    value.expiresAt - value.issuedAt > MAX_TTL_MS
  ) {
    throw new Error('Invalid browser-native checkpoint or expiry.');
  }
  return Object.freeze({
    accountId: safeId(value.accountId, 'account id'),
    projectId: safeId(value.projectId, 'project id'),
    runId: safeId(value.runId, 'run id'),
    chatId: safeId(value.chatId, 'chat id'),
    providerId: safeId(value.providerId, 'provider id'),
    modelId: safeId(value.modelId, 'model id'),
    ...(value.connectionId === undefined
      ? {}
      : { connectionId: safeId(value.connectionId, 'connection id') }),
    browserOrigin: safeOrigin(value.browserOrigin),
    browserTabId: safeId(value.browserTabId, 'browser tab id'),
    approvalId: safeId(value.approvalId, 'approval id'),
    reviewId: safeId(value.reviewId, 'review id'),
    visiblePrompt,
    purpose,
    attachments: Object.freeze(attachments),
    expectedArtifact: Object.freeze({
      schemaId: safeId(expected.schemaId, 'artifact schema id'),
      mediaType: safeText(expected.mediaType, 160, 'artifact media type'),
      maximumBytes: expected.maximumBytes,
    }),
    checkpointSequence: value.checkpointSequence,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    idempotencyKey: safeId(value.idempotencyKey, 'idempotency key'),
  });
}

function load(storage: BrowserNativeHandoffStorage | undefined, key: string): StoredRecord[] {
  try {
    const serialized = storage?.getItem(key);
    if (!serialized || serialized.length > MAX_STORED_CHARS) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) return [];
    return parsed.flatMap((candidate) => {
      try {
        const stored = exactRecord(candidate, new Set(['envelope', 'receipt']), 'Invalid stored handoff.');
        const envelopeRecord = exactRecord(
          stored.envelope,
          ENVELOPE_KEYS,
          'Invalid stored handoff envelope.',
        );
        const requestCandidate = Object.fromEntries(
          [...REQUEST_KEYS]
            .filter((field) => field in envelopeRecord)
            .map((field) => [field, envelopeRecord[field]]),
        );
        const request = validateRequest(requestCandidate as unknown as BrowserNativeHandoffRequest);
        if (
          envelopeRecord.schemaVersion !== VERSION ||
          envelopeRecord.trust !== 'user_approved' ||
          typeof envelopeRecord.promptHash !== 'string' ||
          !SHA256.test(envelopeRecord.promptHash) ||
          typeof envelopeRecord.bindingHash !== 'string' ||
          !SHA256.test(envelopeRecord.bindingHash) ||
          typeof envelopeRecord.handoffId !== 'string' ||
          envelopeRecord.handoffId !== `handoff_${envelopeRecord.bindingHash.slice(0, 40)}`
        ) {
          return [];
        }
        const envelope = Object.freeze({
          schemaVersion: VERSION,
          ...request,
          handoffId: envelopeRecord.handoffId,
          promptHash: envelopeRecord.promptHash,
          bindingHash: envelopeRecord.bindingHash,
          trust: 'user_approved' as const,
        });
        if (stored.receipt === undefined) return [Object.freeze({ envelope })];
        const receipt = exactRecord(stored.receipt, RECEIPT_KEYS, 'Invalid stored handoff receipt.');
        if (
          receipt.schemaVersion !== VERSION ||
          receipt.handoffId !== envelope.handoffId ||
          receipt.bindingHash !== envelope.bindingHash ||
          typeof receipt.resultHash !== 'string' ||
          !SHA256.test(receipt.resultHash) ||
          typeof receipt.artifactRef !== 'string' ||
          !RESULT_REF.test(receipt.artifactRef) ||
          typeof receipt.evidenceRef !== 'string' ||
          !EVIDENCE_REF.test(receipt.evidenceRef) ||
          typeof receipt.schemaId !== 'string' ||
          receipt.schemaId !== envelope.expectedArtifact.schemaId ||
          typeof receipt.artifactHash !== 'string' ||
          !SHA256.test(receipt.artifactHash) ||
          typeof receipt.artifactBytes !== 'number' ||
          !Number.isSafeInteger(receipt.artifactBytes) ||
          receipt.artifactBytes < 0 ||
          receipt.artifactBytes > envelope.expectedArtifact.maximumBytes ||
          receipt.checkpointSequence !== envelope.checkpointSequence ||
          typeof receipt.acceptedAt !== 'number' ||
          !Number.isSafeInteger(receipt.acceptedAt) ||
          receipt.trust !== 'external_untrusted' ||
          receipt.completionAuthority !== 'none'
        ) {
          return [];
        }
        return [Object.freeze({
          envelope,
          receipt: Object.freeze(receipt as unknown as BrowserNativeHandoffReceipt),
        })];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function createBrowserNativeHandoffRuntime(input: {
  storage?: BrowserNativeHandoffStorage;
  hash?: (text: string) => Promise<string>;
  now?: () => number;
} = {}): BrowserNativeHandoffRuntime {
  const storage = input.storage ?? defaultStorage();
  const hash = input.hash ?? hashJarvisText;
  const now = input.now ?? Date.now;
  const memory = new Map<string, StoredRecord[]>();

  const records = (accountId: string, projectId: string): StoredRecord[] => {
    const key = scopeKey(accountId, projectId);
    let scoped = memory.get(key);
    if (!scoped) {
      scoped = load(storage, key);
      memory.set(key, scoped);
    }
    return scoped;
  };
  const persist = (
    accountId: string,
    projectId: string,
    values: readonly StoredRecord[],
  ): StoredRecord[] => {
    const bounded = [...values].slice(-MAX_RECORDS);
    const serialized = JSON.stringify(bounded);
    if (serialized.length > MAX_STORED_CHARS) {
      throw new Error('Browser-native handoff store is too large.');
    }
    storage?.setItem(scopeKey(accountId, projectId), serialized);
    memory.set(scopeKey(accountId, projectId), bounded);
    return bounded;
  };

  return Object.freeze<BrowserNativeHandoffRuntime>({
    async issue(candidate) {
      const request = validateRequest(candidate);
      if (now() >= request.expiresAt) throw new Error('Browser-native handoff expired.');
      const scoped = records(request.accountId, request.projectId);
      const existing = scoped.find(
        ({ envelope }) => envelope.idempotencyKey === request.idempotencyKey,
      );
      const promptHash = await hash(request.visiblePrompt);
      const bindingHash = await hash(JSON.stringify(stable({ ...request, promptHash })));
      if (!SHA256.test(promptHash) || !SHA256.test(bindingHash)) {
        throw new Error('Browser-native handoff hashing failed.');
      }
      if (existing) {
        if (existing.envelope.bindingHash !== bindingHash) {
          throw new Error('Browser-native idempotency key was replayed with changed authority.');
        }
        return existing.envelope;
      }
      const handoffId = `handoff_${bindingHash.slice(0, 40)}`;
      const envelope = Object.freeze({
        schemaVersion: VERSION,
        ...request,
        handoffId,
        promptHash,
        bindingHash,
        trust: 'user_approved' as const,
      });
      exactRecord(envelope, ENVELOPE_KEYS, 'Invalid browser-native handoff envelope.');
      persist(
        request.accountId,
        request.projectId,
        [...scoped, Object.freeze({ envelope })],
      );
      return envelope;
    },
    async accept(candidateEnvelope, candidateReturn, observedAt) {
      const envelope = exactRecord(
        candidateEnvelope,
        ENVELOPE_KEYS,
        'Invalid browser-native handoff envelope.',
      ) as unknown as BrowserNativeHandoffEnvelope;
      const returned = exactRecord(
        candidateReturn,
        RETURN_KEYS,
        'Invalid browser-native handoff return.',
      ) as unknown as BrowserNativeHandoffReturn;
      if (
        envelope.schemaVersion !== VERSION ||
        envelope.trust !== 'user_approved' ||
        returned.trust !== 'external_untrusted' ||
        returned.handoffId !== envelope.handoffId ||
        returned.bindingHash !== envelope.bindingHash ||
        returned.checkpointSequence !== envelope.checkpointSequence ||
        returned.schemaId !== envelope.expectedArtifact.schemaId ||
        !RESULT_REF.test(returned.artifactRef) ||
        !EVIDENCE_REF.test(returned.evidenceRef) ||
        !SHA256.test(returned.artifactHash) ||
        !Number.isSafeInteger(returned.artifactBytes) ||
        returned.artifactBytes < 0 ||
        returned.artifactBytes > envelope.expectedArtifact.maximumBytes ||
        !Number.isSafeInteger(observedAt) ||
        observedAt < envelope.issuedAt ||
        observedAt >= envelope.expiresAt ||
        now() >= envelope.expiresAt
      ) {
        throw new Error('Browser-native handoff result failed validation.');
      }
      const scoped = records(envelope.accountId, envelope.projectId);
      const stored = scoped.find(({ envelope: issued }) => issued.handoffId === envelope.handoffId);
      if (!stored || stored.envelope.bindingHash !== envelope.bindingHash) {
        throw new Error('Browser-native handoff authority is unavailable.');
      }
      if (JSON.stringify(stable(stored.envelope)) !== JSON.stringify(stable(envelope))) {
        throw new Error('Browser-native handoff envelope was altered.');
      }
      const resultHash = await hash(JSON.stringify(stable(returned)));
      if (!SHA256.test(resultHash)) throw new Error('Browser-native result hashing failed.');
      if (stored.receipt) {
        if (stored.receipt.resultHash !== resultHash) {
          throw new Error('Browser-native handoff result replay changed.');
        }
        return stored.receipt;
      }
      const receipt = Object.freeze({
        schemaVersion: VERSION,
        handoffId: envelope.handoffId,
        bindingHash: envelope.bindingHash,
        resultHash,
        artifactRef: returned.artifactRef,
        evidenceRef: returned.evidenceRef,
        schemaId: returned.schemaId,
        artifactHash: returned.artifactHash,
        artifactBytes: returned.artifactBytes,
        checkpointSequence: envelope.checkpointSequence,
        acceptedAt: observedAt,
        trust: 'external_untrusted' as const,
        completionAuthority: 'none' as const,
      });
      const next = scoped.map((record) =>
        record === stored
          ? Object.freeze({ envelope: stored.envelope, receipt })
          : record,
      );
      persist(envelope.accountId, envelope.projectId, next);
      return receipt;
    },
    async recover(accountId, projectId, idempotencyKey) {
      safeId(accountId, 'account id');
      safeId(projectId, 'project id');
      safeId(idempotencyKey, 'idempotency key');
      const envelope = records(accountId, projectId).find(
        ({ envelope }) => envelope.idempotencyKey === idempotencyKey,
      )?.envelope;
      if (!envelope || now() >= envelope.expiresAt) return undefined;
      const promptHash = await hash(envelope.visiblePrompt);
      const {
        schemaVersion: _schemaVersion,
        handoffId: _handoffId,
        promptHash: _storedPromptHash,
        bindingHash: _storedBindingHash,
        trust: _trust,
        ...request
      } = envelope;
      const bindingHash = await hash(JSON.stringify(stable({ ...request, promptHash })));
      return promptHash === envelope.promptHash && bindingHash === envelope.bindingHash
        ? envelope
        : undefined;
    },
    async getReceipt(accountId, projectId, handoffId) {
      safeId(accountId, 'account id');
      safeId(projectId, 'project id');
      safeId(handoffId, 'handoff id');
      const stored = records(accountId, projectId).find(
        ({ envelope }) => envelope.handoffId === handoffId,
      );
      if (!stored?.receipt) return undefined;
      const returned: BrowserNativeHandoffReturn = {
        handoffId: stored.envelope.handoffId,
        bindingHash: stored.envelope.bindingHash,
        checkpointSequence: stored.envelope.checkpointSequence,
        schemaId: stored.receipt.schemaId,
        artifactRef: stored.receipt.artifactRef,
        evidenceRef: stored.receipt.evidenceRef,
        artifactHash: stored.receipt.artifactHash,
        artifactBytes: stored.receipt.artifactBytes,
        trust: 'external_untrusted',
      };
      const resultHash = await hash(JSON.stringify(stable(returned)));
      return resultHash === stored.receipt.resultHash ? stored.receipt : undefined;
    },
  });
}

export const browserNativeHandoffRuntime = createBrowserNativeHandoffRuntime();

import { readChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import type { ChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import type { SendDetail } from '@/lib/ai/runtime';
import { selectionFromOption, type ChatModelSelection } from '@/lib/ai/modelSelection';
import type { ReasoningPreference } from '@/lib/ai/reasoningControls';
import {
  chatDispatchRepo,
  chatRepo,
  messageRepo,
  projectRepo,
  workspaceRepo,
  type ChatDispatchClaimInput,
  type ChatDispatchClaimResult,
  type ChatDispatchTransitionInput,
  type ChatDispatchTransitionResult,
} from '@/lib/db/repositories';
import type { Project, Workspace } from '@/lib/db/schema';
import { captureSyncQueueOwner, type SyncQueueOwnerSnapshot } from '@/lib/cloudSyncQueueOwner';
import { useAuthStore } from '@/stores/auth';
import type { Chat, Message, Part } from '@/types/chat';
import type { ChatId, MessageId, ProjectId, ProviderId, WorkspaceId } from '@/types/common';

import {
  renderChatHandoffPrompt,
  sanitizeChatHandoffText,
  type ChatHandoffMessagePartV1,
  type ChatHandoffProjectionV1,
} from './chatHandoffProjection';
import { readChatReasoningPreference } from './reasoningSlashStore';

const DISPATCH_VERSION = 1 as const;
const MAX_PROJECTION_BYTES = 256_000;
const ACCEPTANCE_TIMEOUT_MS = 10_000;
const UNSAFE_SCHEME_MAX_DECODE_PASSES = 32;
const UNSAFE_SCHEME_MAX_OUTPUT_UNITS = MAX_PROJECTION_BYTES;
const UNSAFE_SCHEME_MAX_WORK_UNITS = MAX_PROJECTION_BYTES * 2;

export type ChatToChatDispatchInput = Readonly<{
  sourceChatId: string;
  targetChatId: string;
  projection: ChatHandoffProjectionV1;
  instruction: string;
  dispatchKey: string;
  queueIfBusy?: boolean;
  onPrepared?: (messageId: string) => void;
}>;

type TerminalDispatchReceipt = Readonly<{
  dispatchKey: string;
  targetChatId: string;
  messageId: string;
}>;

export type ChatToChatDispatchReceipt =
  | (TerminalDispatchReceipt & Readonly<{ status: 'dispatched' }>)
  | (TerminalDispatchReceipt &
      Readonly<{
        status: 'pending' | 'failed';
        reason?: 'runtime_rejected' | 'runtime_timeout' | 'runtime_cancelled' | 'authority_revoked';
      }>)
  | Readonly<{
      status: 'rejected';
      reason:
        | 'invalid_input'
        | 'same_chat'
        | 'chat_unavailable'
        | 'access_denied'
        | 'projection_mismatch'
        | 'projection_unsafe'
        | 'dispatch_key_conflict';
      dispatchKey: string;
      targetChatId: string;
    }>;

export type ActiveDispatchScope = Readonly<{
  accountId: string;
  identitySource: 'supabase' | 'local';
  workspaceId: string | null;
  projectId: string | null;
  epoch: number;
}>;

export type ChatToChatDispatchDeps = {
  getChat: (id: string) => Promise<Chat | undefined>;
  getWorkspace: (id: string) => Promise<Workspace | undefined>;
  getProject: (id: string) => Promise<Project | undefined>;
  getMessage: (id: string) => Promise<Message | undefined>;
  captureSyncOwner: () => SyncQueueOwnerSnapshot;
  claimChatDispatch: (
    input: ChatDispatchClaimInput,
    syncOwner: SyncQueueOwnerSnapshot,
    authorize: () => boolean,
  ) => Promise<ChatDispatchClaimResult>;
  transitionChatDispatch: (
    input: ChatDispatchTransitionInput,
    syncOwner: SyncQueueOwnerSnapshot,
    authorize: () => boolean,
  ) => Promise<ChatDispatchTransitionResult>;
  readActiveScope: () => ActiveDispatchScope | null;
  readModelSelection: (target: Chat) => ChatModelSelection | undefined;
  readReasoningPreference: (chatId: string) => ReasoningPreference;
  readRuntimePolicy: (chatId: string) => ChatRuntimePolicyState;
  dispatchKernel: (detail: SendDetail) => Promise<void>;
  now?: () => number;
  digest?: (value: string) => Promise<string>;
};

type AuthoritySnapshot = Readonly<{
  accountId: string;
  identitySource: ActiveDispatchScope['identitySource'];
  activeWorkspaceId: string | null;
  activeProjectId: string | null;
  epoch: number;
  sourceChatId: string;
  sourceWorkspaceId: string;
  sourceWorkspaceRevision: number;
  sourceProjectId: string | null;
  sourceProjectRevision: number | null;
  targetChatId: string;
  targetWorkspaceId: string;
  targetWorkspaceRevision: number;
  targetProjectId: string | null;
  targetProjectRevision: number | null;
}>;

type AuthorityResult =
  | Readonly<{ ok: true; source: Chat; target: Chat; snapshot: AuthoritySnapshot }>
  | Readonly<{ ok: false; reason: 'chat_unavailable' | 'access_denied' }>;

type DispatchState = 'pending' | 'accepted' | 'failed';
type DispatchFailure =
  | 'runtime_rejected'
  | 'runtime_timeout'
  | 'runtime_cancelled'
  | 'authority_revoked';

type DispatchMarkerV1 = Readonly<{
  version: 1;
  accountId: string;
  sourceChatId: string;
  targetChatId: string;
  dispatchKey: string;
  messageId: string;
  projectionDigest: string;
  promptDigest: string;
  state: DispatchState;
  failure?: DispatchFailure;
}>;

type DurableHandoffV1 = ChatHandoffMessagePartV1 & Readonly<{ dispatch: DispatchMarkerV1 }>;

type CanonicalEnvelope = Readonly<{
  text: string;
  handoffBase: ChatHandoffMessagePartV1;
  projectionDigest: string;
  promptDigest: string;
}>;

let activeScopeEpoch = 0;
useAuthStore.subscribe((current, previous) => {
  const currentIdentity = resolveAccountIdentity(current);
  const previousIdentity = resolveAccountIdentity(previous);
  if (
    currentIdentity?.accountId !== previousIdentity?.accountId ||
    currentIdentity?.source !== previousIdentity?.source ||
    String(current.workspaceId ?? '') !== String(previous.workspaceId ?? '') ||
    String(current.projectId ?? '') !== String(previous.projectId ?? '')
  ) {
    activeScopeEpoch += 1;
  }
});

function stableValue(value: unknown, maximumLength: number): value is string {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return (
    clean.length > 0 &&
    clean === value &&
    clean.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(clean)
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeUnsafeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d{1,7});?/gu, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    })
    .replace(/&#x([\da-f]{1,6});?/giu, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    })
    .replace(/&(colon|tab|newline);/giu, (_match, entity: string) =>
      entity.toLowerCase() === 'colon' ? ':' : entity.toLowerCase() === 'tab' ? '\t' : '\n',
    );
}

function decodeUnsafePercentRuns(value: string): string {
  return value.replace(/(?:%[\da-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([\da-f]{2})/giu, (token, digits: string) => {
        const byte = Number.parseInt(digits, 16);
        return byte <= 0x7f ? String.fromCharCode(byte) : token;
      });
    }
  });
}

function unsafeSchemeInProbe(value: string): boolean {
  const urlParserProbe = value.replace(/[\u0000-\u001f\u007f]/gu, '');
  return /(?:^|[=\s"'(<\[{,:])(?:data|blob)\s*:/iu.test(urlParserProbe);
}

function containsUnsafeEmbeddedScheme(value: string): boolean {
  let probe = value.normalize('NFKC');
  let work = 0;
  for (let pass = 0; pass < UNSAFE_SCHEME_MAX_DECODE_PASSES; pass += 1) {
    work += probe.length;
    if (
      probe.length > UNSAFE_SCHEME_MAX_OUTPUT_UNITS ||
      work > UNSAFE_SCHEME_MAX_WORK_UNITS ||
      unsafeSchemeInProbe(probe)
    ) {
      return true;
    }
    const decoded = decodeUnsafePercentRuns(decodeUnsafeHtmlEntities(probe)).normalize('NFKC');
    work += decoded.length;
    if (decoded.length > UNSAFE_SCHEME_MAX_OUTPUT_UNITS || work > UNSAFE_SCHEME_MAX_WORK_UNITS) {
      return true;
    }
    if (decoded === probe) return false;
    probe = decoded;
  }
  return true;
}

function safeText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string' || value.length > maximumLength) return null;
  if (containsUnsafeEmbeddedScheme(value) || /[\u0000\ufffd]/u.test(value)) return null;
  return sanitizeChatHandoffText(value);
}

function safeNullableText(value: unknown, maximumLength: number): string | null | undefined {
  return value === null ? null : (safeText(value, maximumLength) ?? undefined);
}

function safeStringArray(value: unknown, maximumItems: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const output: string[] = [];
  for (const item of value) {
    const safe = safeText(item, 2_000);
    if (safe === null) return null;
    output.push(safe);
  }
  return Object.freeze(output);
}

function validTimestamp(value: unknown, now: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= now + 300_000;
}

function canonicalProjection(value: unknown, now: number): ChatHandoffProjectionV1 | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'version',
      'policyVersion',
      'source',
      'snapshotAt',
      'boundaryAt',
      'boundaryMessageId',
      'goal',
      'status',
      'lastMeaningfulActivity',
      'recentSections',
      'olderDigest',
      'summaries',
    ]) ||
    value.version !== 1 ||
    value.policyVersion !== 1 ||
    !validTimestamp(value.snapshotAt, now) ||
    !validTimestamp(value.boundaryAt, now) ||
    Number(value.boundaryAt) > Number(value.snapshotAt)
  )
    return null;
  if (
    !plainRecord(value.source) ||
    !exactKeys(value.source, ['chatId', 'title', 'workspaceId', 'projectId'])
  )
    return null;
  const sourceChatId = safeText(value.source.chatId, 512);
  const title = safeText(value.source.title, 1_000);
  const workspaceId = safeText(value.source.workspaceId, 512);
  const projectId = safeNullableText(value.source.projectId, 512);
  const boundaryMessageId = safeNullableText(value.boundaryMessageId, 512);
  const goal = safeNullableText(value.goal, 4_000);
  const status = safeText(value.status, 1_000);
  const lastMeaningfulActivity = safeNullableText(value.lastMeaningfulActivity, 4_000);
  const olderDigest = safeText(value.olderDigest, 12_000);
  if (
    !sourceChatId ||
    title === null ||
    !workspaceId ||
    projectId === undefined ||
    boundaryMessageId === undefined ||
    goal === undefined ||
    status === null ||
    lastMeaningfulActivity === undefined ||
    olderDigest === null
  )
    return null;
  if (!Array.isArray(value.recentSections) || value.recentSections.length > 256) return null;
  const recentSections: ChatHandoffProjectionV1['recentSections'][number][] = [];
  for (const section of value.recentSections) {
    if (
      !plainRecord(section) ||
      !exactKeys(section, ['messageId', 'role', 'createdAt', 'visibleText', 'chunks']) ||
      !stableValue(section.messageId, 512) ||
      !['user', 'assistant', 'agent', 'system', 'tool'].includes(String(section.role)) ||
      !validTimestamp(section.createdAt, now) ||
      Number(section.createdAt) > Number(value.snapshotAt)
    )
      return null;
    const visibleText = safeText(section.visibleText, 64_000);
    const chunks = safeStringArray(section.chunks, 128);
    if (
      visibleText === null ||
      chunks === null ||
      chunks.some((chunk) => chunk.length > 8_000) ||
      chunks.join('') !== visibleText
    )
      return null;
    recentSections.push(
      Object.freeze({
        messageId: section.messageId,
        role: section.role as Message['role'],
        createdAt: Number(section.createdAt),
        visibleText,
        chunks,
      }),
    );
  }
  if (
    !plainRecord(value.summaries) ||
    !exactKeys(value.summaries, ['files', 'tools', 'actions', 'decisions', 'blockers', 'results'])
  )
    return null;
  const summaries = {
    files: safeStringArray(value.summaries.files, 256),
    tools: safeStringArray(value.summaries.tools, 256),
    actions: safeStringArray(value.summaries.actions, 256),
    decisions: safeStringArray(value.summaries.decisions, 256),
    blockers: safeStringArray(value.summaries.blockers, 256),
    results: safeStringArray(value.summaries.results, 256),
  };
  if (Object.values(summaries).some((entry) => entry === null)) return null;
  const projection: ChatHandoffProjectionV1 = Object.freeze({
    version: 1,
    policyVersion: 1,
    source: Object.freeze({ chatId: sourceChatId, title, workspaceId, projectId }),
    snapshotAt: Number(value.snapshotAt),
    boundaryAt: Number(value.boundaryAt),
    boundaryMessageId,
    goal,
    status,
    lastMeaningfulActivity,
    recentSections: Object.freeze(recentSections),
    olderDigest,
    summaries: Object.freeze(summaries as ChatHandoffProjectionV1['summaries']),
  });
  return JSON.stringify(projection).length <= MAX_PROJECTION_BYTES ? projection : null;
}

function rejected(
  input: ChatToChatDispatchInput,
  reason: Extract<ChatToChatDispatchReceipt, { status: 'rejected' }>['reason'],
): ChatToChatDispatchReceipt {
  return Object.freeze({
    status: 'rejected' as const,
    reason,
    dispatchKey: input.dispatchKey,
    targetChatId: input.targetChatId,
  });
}

function projectId(chat: Chat): string | null {
  return chat.project_id ? String(chat.project_id) : null;
}

async function resolveAuthority(
  input: ChatToChatDispatchInput,
  deps: ChatToChatDispatchDeps,
): Promise<AuthorityResult> {
  const activeBefore = deps.readActiveScope();
  if (!activeBefore || !stableValue(activeBefore.accountId, 512))
    return { ok: false, reason: 'access_denied' };
  let source: Chat | undefined;
  let target: Chat | undefined;
  try {
    [source, target] = await Promise.all([
      deps.getChat(input.sourceChatId),
      deps.getChat(input.targetChatId),
    ]);
  } catch {
    return { ok: false, reason: 'chat_unavailable' };
  }
  if (
    !source ||
    !target ||
    String(source.id) !== input.sourceChatId ||
    String(target.id) !== input.targetChatId
  )
    return { ok: false, reason: 'chat_unavailable' };
  if (source.archived || target.archived) return { ok: false, reason: 'access_denied' };
  const sourceWorkspaceId = String(source.workspace_id);
  const targetWorkspaceId = String(target.workspace_id);
  // No canonical cross-workspace handoff policy exists yet, so cross-workspace dispatch fails closed.
  if (sourceWorkspaceId !== targetWorkspaceId) return { ok: false, reason: 'access_denied' };
  let sourceWorkspace: Workspace | undefined;
  let targetWorkspace: Workspace | undefined;
  let sourceProject: Project | undefined;
  let targetProject: Project | undefined;
  try {
    [sourceWorkspace, targetWorkspace, sourceProject, targetProject] = await Promise.all([
      deps.getWorkspace(sourceWorkspaceId),
      deps.getWorkspace(targetWorkspaceId),
      source.project_id ? deps.getProject(String(source.project_id)) : Promise.resolve(undefined),
      target.project_id ? deps.getProject(String(target.project_id)) : Promise.resolve(undefined),
    ]);
  } catch {
    return { ok: false, reason: 'access_denied' };
  }
  if (
    !sourceWorkspace ||
    !targetWorkspace ||
    String(sourceWorkspace.id) !== sourceWorkspaceId ||
    String(targetWorkspace.id) !== targetWorkspaceId ||
    sourceWorkspace.owner_id !== activeBefore.accountId ||
    targetWorkspace.owner_id !== activeBefore.accountId
  )
    return { ok: false, reason: 'access_denied' };
  if (
    (source.project_id &&
      (!sourceProject ||
        String(sourceProject.id) !== String(source.project_id) ||
        String(sourceProject.workspace_id) !== sourceWorkspaceId)) ||
    (target.project_id &&
      (!targetProject ||
        String(targetProject.id) !== String(target.project_id) ||
        String(targetProject.workspace_id) !== targetWorkspaceId))
  )
    return { ok: false, reason: 'access_denied' };
  const activeAfter = deps.readActiveScope();
  if (!activeAfter || JSON.stringify(activeAfter) !== JSON.stringify(activeBefore))
    return { ok: false, reason: 'access_denied' };
  return {
    ok: true,
    source,
    target,
    snapshot: Object.freeze({
      accountId: activeBefore.accountId,
      identitySource: activeBefore.identitySource,
      activeWorkspaceId: activeBefore.workspaceId,
      activeProjectId: activeBefore.projectId,
      epoch: activeBefore.epoch,
      sourceChatId: input.sourceChatId,
      sourceWorkspaceId,
      sourceWorkspaceRevision: sourceWorkspace.updated_at,
      sourceProjectId: projectId(source),
      sourceProjectRevision: sourceProject?.updated_at ?? null,
      targetChatId: input.targetChatId,
      targetWorkspaceId,
      targetWorkspaceRevision: targetWorkspace.updated_at,
      targetProjectId: projectId(target),
      targetProjectRevision: targetProject?.updated_at ?? null,
    }),
  };
}

async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function canonicalEnvelope(
  input: ChatToChatDispatchInput,
  source: Chat,
  now: number,
  digest: (value: string) => Promise<string>,
): Promise<CanonicalEnvelope | null> {
  const projection = canonicalProjection(input.projection, now);
  if (
    !projection ||
    projection.source.chatId !== input.sourceChatId ||
    String(source.id) !== input.sourceChatId ||
    projection.source.workspaceId !== String(source.workspace_id) ||
    projection.source.projectId !== projectId(source)
  )
    return null;
  const instruction = safeText(input.instruction.trim(), 8_000);
  if (!instruction?.trim()) return null;
  const text = renderChatHandoffPrompt(projection, instruction);
  const handoffBase: ChatHandoffMessagePartV1 = Object.freeze({
    version: 1,
    sourceChatId: input.sourceChatId,
    sourceTitle: projection.source.title,
    snapshotAt: projection.snapshotAt,
    boundaryMessageId: projection.boundaryMessageId,
    instruction,
    projection,
    dispatchKey: input.dispatchKey,
  });
  return Object.freeze({
    text,
    handoffBase,
    projectionDigest: await digest(JSON.stringify(projection)),
    promptDigest: await digest(text),
  });
}

function markerFor(
  authority: AuthoritySnapshot,
  input: ChatToChatDispatchInput,
  messageId: string,
  envelope: CanonicalEnvelope,
  state: DispatchState,
  failure?: DispatchFailure,
): DispatchMarkerV1 {
  return Object.freeze({
    version: DISPATCH_VERSION,
    accountId: authority.accountId,
    sourceChatId: input.sourceChatId,
    targetChatId: input.targetChatId,
    dispatchKey: input.dispatchKey,
    messageId,
    projectionDigest: envelope.projectionDigest,
    promptDigest: envelope.promptDigest,
    state,
    ...(failure ? { failure } : {}),
  });
}

function partsFor(envelope: CanonicalEnvelope, marker: DispatchMarkerV1): Part[] {
  const handoff: DurableHandoffV1 = Object.freeze({ ...envelope.handoffBase, dispatch: marker });
  return [
    { kind: 'text', text: envelope.text },
    { kind: 'chat_handoff', handoff },
  ];
}

function parseExistingClaim(
  message: Message,
  expectedId: string,
  authority: AuthoritySnapshot,
  input: ChatToChatDispatchInput,
  envelope: CanonicalEnvelope,
): { kind: 'valid'; marker: DispatchMarkerV1 } | { kind: 'conflict' } {
  if (
    !stableValue(String(message.id), 512) ||
    String(message.id) !== expectedId ||
    String(message.chat_id) !== input.targetChatId ||
    message.role !== 'user' ||
    message.parts.length !== 2 ||
    message.parts[0]?.kind !== 'text' ||
    message.parts[1]?.kind !== 'chat_handoff' ||
    message.parts[0].text !== envelope.text
  )
    return { kind: 'conflict' };
  const handoff = message.parts[1].handoff as unknown;
  if (
    !plainRecord(handoff) ||
    !exactKeys(handoff, [...Object.keys(envelope.handoffBase), 'dispatch']) ||
    !plainRecord(handoff.dispatch)
  )
    return { kind: 'conflict' };
  const markerKeys = handoff.dispatch.failure
    ? [
        'version',
        'accountId',
        'sourceChatId',
        'targetChatId',
        'dispatchKey',
        'messageId',
        'projectionDigest',
        'promptDigest',
        'state',
        'failure',
      ]
    : [
        'version',
        'accountId',
        'sourceChatId',
        'targetChatId',
        'dispatchKey',
        'messageId',
        'projectionDigest',
        'promptDigest',
        'state',
      ];
  if (!exactKeys(handoff.dispatch, markerKeys)) return { kind: 'conflict' };
  const marker = handoff.dispatch as unknown as DispatchMarkerV1;
  const validFailure =
    marker.failure === undefined ||
    ['runtime_rejected', 'runtime_timeout', 'runtime_cancelled', 'authority_revoked'].includes(
      marker.failure,
    );
  const baseHandoff = { ...handoff };
  delete baseHandoff.dispatch;
  if (
    marker.version !== 1 ||
    marker.accountId !== authority.accountId ||
    marker.sourceChatId !== input.sourceChatId ||
    marker.targetChatId !== input.targetChatId ||
    marker.dispatchKey !== input.dispatchKey ||
    marker.messageId !== expectedId ||
    marker.projectionDigest !== envelope.projectionDigest ||
    marker.promptDigest !== envelope.promptDigest ||
    !['pending', 'accepted', 'failed'].includes(marker.state) ||
    (marker.state === 'failed') !== Boolean(marker.failure) ||
    !validFailure ||
    JSON.stringify(baseHandoff) !== JSON.stringify(envelope.handoffBase)
  )
    return { kind: 'conflict' };
  return { kind: 'valid', marker };
}

function receiptFromMarker(
  input: ChatToChatDispatchInput,
  marker: DispatchMarkerV1,
): ChatToChatDispatchReceipt {
  const base = {
    dispatchKey: input.dispatchKey,
    targetChatId: input.targetChatId,
    messageId: marker.messageId,
  };
  if (marker.state === 'accepted') return Object.freeze({ status: 'dispatched' as const, ...base });
  if (marker.state === 'failed')
    return Object.freeze({ status: 'failed' as const, ...base, reason: marker.failure });
  return Object.freeze({ status: 'pending' as const, ...base });
}

function syncOwnerBindsAuthority(
  owner: SyncQueueOwnerSnapshot,
  authority: AuthoritySnapshot,
): boolean {
  return authority.identitySource === 'supabase'
    ? owner.state === 'cloud' && owner.userId === authority.accountId
    : owner.state === 'unbound';
}

function currentAuthorityMatches(
  deps: ChatToChatDispatchDeps,
  authority: AuthoritySnapshot,
  originalOwner: SyncQueueOwnerSnapshot,
): boolean {
  const active = deps.readActiveScope();
  if (
    !active ||
    active.accountId !== authority.accountId ||
    active.identitySource !== authority.identitySource ||
    active.workspaceId !== authority.activeWorkspaceId ||
    active.projectId !== authority.activeProjectId ||
    active.epoch !== authority.epoch
  ) {
    return false;
  }
  const currentOwner = deps.captureSyncOwner();
  return (
    syncOwnerBindsAuthority(currentOwner, authority) &&
    currentOwner.state === originalOwner.state &&
    (currentOwner.state !== 'cloud' ||
      (originalOwner.state === 'cloud' && currentOwner.userId === originalOwner.userId))
  );
}

function dispatchTarget(authority: AuthoritySnapshot) {
  return Object.freeze({
    chatId: authority.targetChatId as ChatId,
    workspaceId: authority.targetWorkspaceId as WorkspaceId,
    projectId: authority.targetProjectId as ProjectId | null,
  });
}

async function transitionState(
  deps: ChatToChatDispatchDeps,
  authority: AuthoritySnapshot,
  originalOwner: SyncQueueOwnerSnapshot,
  input: ChatToChatDispatchInput,
  envelope: CanonicalEnvelope,
  messageId: string,
  expectedParts: Part[],
  state: DispatchState,
  failure?: DispatchFailure,
): Promise<boolean> {
  try {
    const result = await deps.transitionChatDispatch(
      {
        id: messageId as MessageId,
        target: dispatchTarget(authority),
        expectedParts,
        nextParts: partsFor(
          envelope,
          markerFor(authority, input, messageId, envelope, state, failure),
        ),
      },
      originalOwner,
      () => currentAuthorityMatches(deps, authority, originalOwner),
    );
    return (
      result.status === 'transitioned' &&
      parseExistingClaim(result.message, messageId, authority, input, envelope).kind === 'valid'
    );
  } catch {
    return false;
  }
}

function defaultModelSelection(target: Chat): ChatModelSelection | undefined {
  const current = useAuthStore.getState().chatModelSelection;
  const connection = target.connection;
  if (!connection) return current.mode === 'none' ? undefined : current;
  const modelId =
    connection.modelId ??
    (current.mode === 'single' && current.providerId === connection.providerId
      ? current.modelId
      : undefined);
  return modelId
    ? selectionFromOption(connection.providerId as ProviderId, modelId, connection)
    : undefined;
}

function readBrowserActiveScope(): ActiveDispatchScope | null {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  if (!identity) return null;
  return Object.freeze({
    accountId: identity.accountId,
    identitySource: identity.source,
    workspaceId: auth.workspaceId ? String(auth.workspaceId) : null,
    projectId: auth.projectId ? String(auth.projectId) : null,
    epoch: activeScopeEpoch,
  });
}

export function dispatchJarvisSendWithAcceptance(
  detail: SendDetail,
  timeoutMs = ACCEPTANCE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('jarvis:run-state', onRunState as EventListener);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const onRunState = (event: Event) => {
      const state = (
        event as CustomEvent<{ chatId?: string; cancellationKey?: string; status?: string }>
      ).detail;
      if (
        String(state?.chatId ?? '') !== String(detail.chatId) ||
        String(state?.cancellationKey ?? '') !== String(detail.cancellationKey ?? '')
      )
        return;
      if (state?.status === 'running') finish();
      else if (state?.status === 'cancelled') finish(new Error('CHAT_HANDOFF_RUNTIME_CANCELLED'));
      else if (state?.status === 'error') finish(new Error('CHAT_HANDOFF_RUNTIME_REJECTED'));
    };
    const timeout = setTimeout(
      () => finish(new Error('CHAT_HANDOFF_RUNTIME_TIMEOUT')),
      Math.max(1, timeoutMs),
    );
    window.addEventListener('jarvis:run-state', onRunState as EventListener);
    try {
      window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
    } catch (error) {
      finish(error instanceof Error ? error : new Error('CHAT_HANDOFF_RUNTIME_REJECTED'));
    }
  });
}

const browserChatToChatDispatchDeps: ChatToChatDispatchDeps = Object.freeze({
  getChat: (id) => chatRepo.getById(id as ChatId),
  getWorkspace: (id) => workspaceRepo.getById(id as WorkspaceId),
  getProject: (id) => projectRepo.getById(id as ProjectId),
  getMessage: (id) => messageRepo.getById(id as MessageId),
  captureSyncOwner: () => captureSyncQueueOwner(),
  claimChatDispatch: (input, syncOwner, authorize) =>
    chatDispatchRepo.claimChatDispatch(input, syncOwner, authorize),
  transitionChatDispatch: (input, syncOwner, authorize) =>
    chatDispatchRepo.transitionChatDispatch(input, syncOwner, authorize),
  readActiveScope: readBrowserActiveScope,
  readModelSelection: defaultModelSelection,
  readReasoningPreference: (chatId) => readChatReasoningPreference(chatId),
  readRuntimePolicy: (chatId) => readChatRuntimePolicyState(chatId),
  dispatchKernel: (detail) => dispatchJarvisSendWithAcceptance(detail),
});

export async function dispatchChatToChat(
  input: ChatToChatDispatchInput,
  deps: ChatToChatDispatchDeps = browserChatToChatDispatchDeps,
): Promise<ChatToChatDispatchReceipt> {
  if (
    !stableValue(input.sourceChatId, 512) ||
    !stableValue(input.targetChatId, 512) ||
    !stableValue(input.dispatchKey, 1_024) ||
    typeof input.instruction !== 'string' ||
    !input.instruction.trim() ||
    input.instruction.length > 8_000
  )
    return rejected(input, 'invalid_input');
  if (input.sourceChatId === input.targetChatId) return rejected(input, 'same_chat');
  const initialAuthority = await resolveAuthority(input, deps);
  if (!initialAuthority.ok) return rejected(input, initialAuthority.reason);
  const digest = deps.digest ?? sha256;
  const now = (deps.now ?? Date.now)();
  const envelope = await canonicalEnvelope(input, initialAuthority.source, now, digest);
  if (!envelope)
    return rejected(
      input,
      canonicalProjection(input.projection, now) ? 'projection_mismatch' : 'projection_unsafe',
    );
  const messageId = `msg_handoff_${await digest(`chat-handoff-v${DISPATCH_VERSION}\0${initialAuthority.snapshot.accountId}\0${input.dispatchKey}`)}`;
  if (!stableValue(messageId, 512)) return rejected(input, 'invalid_input');
  const originalOwner = deps.captureSyncOwner();
  if (!syncOwnerBindsAuthority(originalOwner, initialAuthority.snapshot)) {
    return rejected(input, 'access_denied');
  }
  let modelSelection: ChatModelSelection | undefined;
  let reasoningPreference: ReasoningPreference;
  let runtimePolicy: ChatRuntimePolicyState;
  try {
    modelSelection = deps.readModelSelection(initialAuthority.target);
    reasoningPreference = deps.readReasoningPreference(input.targetChatId);
    runtimePolicy = deps.readRuntimePolicy(input.targetChatId);
  } catch {
    return rejected(input, 'access_denied');
  }
  const pendingMarker = markerFor(initialAuthority.snapshot, input, messageId, envelope, 'pending');
  const pendingParts = partsFor(envelope, pendingMarker);
  let claimed: ChatDispatchClaimResult;
  try {
    claimed = await deps.claimChatDispatch(
      {
        message: {
          id: messageId as MessageId,
          chat_id: initialAuthority.target.id,
          role: 'user',
          parts: pendingParts,
        },
        target: dispatchTarget(initialAuthority.snapshot),
        matchesExisting: (message) =>
          parseExistingClaim(message, messageId, initialAuthority.snapshot, input, envelope)
            .kind === 'valid',
      },
      originalOwner,
      () => currentAuthorityMatches(deps, initialAuthority.snapshot, originalOwner),
    );
  } catch (error) {
    throw error;
  }
  if (claimed.status === 'authority_revoked') return rejected(input, 'access_denied');
  if (claimed.status === 'conflict') return rejected(input, 'dispatch_key_conflict');
  if (!('message' in claimed)) return rejected(input, 'dispatch_key_conflict');
  const parsedClaim = parseExistingClaim(
    claimed.message,
    messageId,
    initialAuthority.snapshot,
    input,
    envelope,
  );
  if (parsedClaim.kind !== 'valid') return rejected(input, 'dispatch_key_conflict');
  if (claimed.status === 'existing') return receiptFromMarker(input, parsedClaim.marker);
  if (parsedClaim.marker.state !== 'pending') {
    return rejected(input, 'dispatch_key_conflict');
  }
  const finalAuthority = await resolveAuthority(input, deps);
  if (
    !finalAuthority.ok ||
    JSON.stringify(initialAuthority.snapshot) !== JSON.stringify(finalAuthority.snapshot) ||
    !currentAuthorityMatches(deps, initialAuthority.snapshot, originalOwner)
  ) {
    return rejected(input, finalAuthority.ok ? 'access_denied' : finalAuthority.reason);
  }
  let durablePending: Message | undefined;
  try {
    durablePending = await deps.getMessage(messageId);
  } catch {
    return rejected(input, 'chat_unavailable');
  }
  if (!durablePending) return rejected(input, 'dispatch_key_conflict');
  const parsedDurable = parseExistingClaim(
    durablePending,
    messageId,
    finalAuthority.snapshot,
    input,
    envelope,
  );
  if (parsedDurable.kind !== 'valid' || parsedDurable.marker.state !== 'pending') {
    return rejected(input, 'dispatch_key_conflict');
  }
  const detail: SendDetail = {
    chatId: input.targetChatId,
    cancellationKey: messageId as MessageId,
    ...(input.queueIfBusy ? { queueIfBusy: true } : {}),
    text: envelope.text,
    ...(modelSelection ? { modelSelectionOverride: modelSelection } : {}),
    reasoningPreference,
    runtimeSettings: runtimePolicy.settings,
    accessLevel: runtimePolicy.access,
    automaticModelRoutingEligible: false,
  };
  if (!currentAuthorityMatches(deps, finalAuthority.snapshot, originalOwner)) {
    return rejected(input, 'access_denied');
  }
  let terminalState: Extract<DispatchState, 'accepted' | 'failed'> = 'accepted';
  let terminalFailure: DispatchFailure | undefined;
  try {
    input.onPrepared?.(messageId);
    const acceptance = deps.dispatchKernel(detail);
    await acceptance;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    terminalState = 'failed';
    terminalFailure = message.includes('TIMEOUT')
      ? 'runtime_timeout'
      : message.includes('CANCELLED')
        ? 'runtime_cancelled'
        : 'runtime_rejected';
  }
  const postRuntimeAuthority = await resolveAuthority(input, deps);
  if (
    !postRuntimeAuthority.ok ||
    JSON.stringify(finalAuthority.snapshot) !== JSON.stringify(postRuntimeAuthority.snapshot) ||
    !currentAuthorityMatches(deps, finalAuthority.snapshot, originalOwner)
  ) {
    return Object.freeze({
      status: 'pending' as const,
      dispatchKey: input.dispatchKey,
      targetChatId: input.targetChatId,
      messageId,
    });
  }
  const transitioned = await transitionState(
    deps,
    postRuntimeAuthority.snapshot,
    originalOwner,
    input,
    envelope,
    messageId,
    pendingParts,
    terminalState,
    terminalFailure,
  );
  if (!transitioned) {
    return Object.freeze({
      status: 'pending' as const,
      dispatchKey: input.dispatchKey,
      targetChatId: input.targetChatId,
      messageId,
    });
  }
  if (terminalState === 'accepted') {
    return Object.freeze({
      status: 'dispatched' as const,
      dispatchKey: input.dispatchKey,
      targetChatId: input.targetChatId,
      messageId,
    });
  }
  return Object.freeze({
    status: 'failed' as const,
    reason: terminalFailure ?? 'runtime_rejected',
    dispatchKey: input.dispatchKey,
    targetChatId: input.targetChatId,
    messageId,
  });
}

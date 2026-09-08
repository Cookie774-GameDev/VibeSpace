import type { Chat, ChatId, ProjectId, WorkspaceId } from '@/types';
import type { JarvisDexie } from '@/lib/db/database';
import { createJarvisApprovalMutationRepository, createJarvisRepositories } from '@/lib/db/jarvisRepositories';
import { createJarvisExecutionJournal } from '@/lib/jarvis/executionJournal';
import type { ChatRunState } from '@/features/chat/runtime/chatRunState';
import type { CaoGuidance } from '@/features/jarvis-memory/caoGuidance';
import { collectCaoLearningEvidence } from '@/features/jarvis-memory/caoLearningEvidence';
import { CAO_LEARNER_IDENTITY } from './bootstrap';
import { resolveCaoControlTargets, type CaoControlCommand, type CaoControlScope, type CaoResolvedControlTarget } from './controlCommand';
import { createProductionCaoControlComposition } from './productionControlComposition';
import { createProductionCaoTargetRegistry } from './productionTargetRegistry';
import { createProductionCaoControlRecordRepository } from './productionControlRecordRepository';
import type { CaoControlRecord, CaoControlStatus } from './controlRuntime';
import type { CaoCanonicalControlAuthorityInput } from './productionControlCapabilityPorts';

type Authorization = { signature: string; mode: 'approve-before-send' | 'full-access'; guidance: CaoGuidance };
type Binding = { target: CaoResolvedControlTarget; signature: string; turnKey?: string };
type Review = { text: string; receipt: Record<string, unknown> };
export type CaoChatCommandRecord = CaoControlScope & {
  schemaVersion: 1; requestId: string; runId: string; callerChatId: string;
  command: CaoControlCommand; bindings: Binding[]; authorization: string;
  status: CaoControlStatus | 'preparing'; createdAt: number; updatedAt: number;
  report?: string; review?: Review; approvalId?: string; error?: string;
  effects: { targetId: string; receiptId: string; outcome: string }[];
};
export const caoChatCommandKey = (accountId: string, requestId: string) => `cao.command.v1:${accountId}:${requestId}`;
export const caoChatCommandLatestKey = (accountId: string, chatId: string) => `cao.command.latest.v1:${accountId}:${chatId}`;
const effectAction = (action: string) => action === 'restart' || action === 'cancel';
const terminalStatus = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Production composition of the existing journal, exact-target registry and control runtime. */
export function createCaoChatCommands(deps: {
  database: JarvisDexie;
  accountId(): string | undefined;
  authorization(accountId: string): Promise<Authorization>;
  agentSignature(chat: Chat): string;
  runState(chatId: string): ChatRunState | undefined;
  review(action: string, evidence: string, guidance: CaoGuidance, signal: AbortSignal, requestId: string): Promise<Review>;
  control(action: 'restart' | 'cancel', chatId: string, turnKey: string, resumeKey: string,
    signal: AbortSignal, authorize: () => Promise<void>): Promise<'resumed' | 'cancelled'>;
}) {
  const db = deps.database;
  const repositories = createJarvisRepositories(db);
  const journal = createJarvisExecutionJournal(repositories);
  const approvals = createJarvisApprovalMutationRepository(db);
  const registry = createProductionCaoTargetRegistry(db);
  const controls = createProductionCaoControlRecordRepository(db);
  const active = new Map<string, AbortController>();
  const signature = (chat: Chat) => JSON.stringify({ workspace: chat.workspace_id, project: chat.project_id,
    connection: chat.connection, backend: chat.backend_affinity, agents: chat.active_agent_ids,
    resolvedAgent: deps.agentSignature(chat), archived: Boolean(chat.archived) });
  const read = async (accountId: string, requestId: string) => {
    if (deps.accountId() !== accountId) throw Error('cao_control_account_changed');
    const value = (await db.settings.get(caoChatCommandKey(accountId, requestId)))?.value as CaoChatCommandRecord | undefined;
    if (value && (value.schemaVersion !== 1 || value.accountId !== accountId || value.requestId !== requestId))
      throw Error('cao_control_record_invalid');
    if (deps.accountId() !== accountId) throw Error('cao_control_account_changed');
    return value;
  };
  const save = async (record: CaoChatCommandRecord) => {
    record.updatedAt = Date.now();
    await db.settings.put({ key: caoChatCommandKey(record.accountId, record.requestId), value: structuredClone(record), updated_at: record.updatedAt });
  };
  const check = async (record: CaoChatCommandRecord, revision = true) => {
    const auth = await deps.authorization(record.accountId);
    if (auth.signature !== record.authorization) throw Error('cao_control_authority_changed');
    const [workspace, project] = await Promise.all([db.workspaces.get(record.workspaceId as WorkspaceId), db.projects.get(record.projectId as ProjectId)]);
    if (workspace?.owner_id !== record.accountId || project?.workspace_id !== record.workspaceId)
      throw Error('cao_control_scope_unavailable');
    for (const binding of record.bindings) {
      const chat = await db.chats.get(binding.target.targetId as ChatId);
      if (!chat || chat.archived || signature(chat) !== binding.signature ||
          (revision && chat.updated_at !== binding.target.revision)) throw Error('cao_control_target_changed');
    }
    if ((await deps.authorization(record.accountId)).signature !== record.authorization) throw Error('cao_control_authority_changed');
    return auth;
  };
  const tail = async (record: CaoChatCommandRecord) => (await repositories.event.listByRun(record.accountId, record.runId, { limit: 500 })).at(-1)?.seq ?? 0;
  const decideApproval = async (record: CaoChatCommandRecord, decision: 'approve' | 'deny') => {
    if (!record.approvalId) throw Error('cao_control_approval_invalid');
    await approvals.decide({ accountId: record.accountId, runId: record.runId, requestId: record.requestId,
      attemptNumber: 1, approvalId: record.approvalId, decision, decidedAt: Date.now(), expectedEventTailSeq: await tail(record) });
  };
  const settleJournal = async (record: CaoChatCommandRecord) => {
    const run = await journal.getRun(record.accountId, record.runId);
    if (!run || terminalStatus(run.status) || !terminalStatus(record.status)) return;
    await journal.transitionRun({ accountId: record.accountId, runId: record.runId, expectedStatus: run.status,
      nextStatus: record.status as 'completed' | 'failed' | 'cancelled', completedAt: Date.now(),
      event: { idempotencyKey: `cao-command-final:${record.requestId}`, title: `CAO ${record.command.action}: ${record.status}`,
        sourceRefs: [], artifactIds: [], createdAt: Date.now() } });
  };
  async function execute(record: CaoChatCommandRecord, signal: AbortSignal) {
    await check(record);
    const action = record.command.action;
    const composition = createProductionCaoControlComposition({
      database: db, journal, events: repositories.event, approvals: repositories.approval,
      now: Date.now, newRunId: () => record.runId, newLeaseId: () => id('cao_lease'), leaseMs: 60000,
      cancelRun: async () => active.get(record.requestId)?.abort(),
      async requestApproval() {
        const auth = await check(record);
        const approvalId = id('jappr');
        const params = { action, targets: record.bindings.map(x => x.target), authorization: record.authorization };
        await approvals.createPending({ accountId: record.accountId, expectedEventTailSeq: await tail(record), approval: {
          schemaVersion: 1, id: approvalId, runId: record.runId, requestId: record.requestId, attemptNumber: 1,
          actionId: `cao.control.${action}`, actionVersion: 1, capabilityId: `cao.chat.${action}`,
          capabilitySnapshotHash: await hash(record.bindings), params, paramsHash: await hash(params),
          targetSnapshot: params.targets, expectedEffect: action === 'restart' ? 'Stop the captured chat turn and resume its retained request.' : action === 'cancel' ? 'Stop only the captured chat turn.' : 'Review fresh chat evidence without running tools.',
          risk: 'confirm', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 600000,
        } });
        record.approvalId = approvalId;
        await save(record);
        if (auth.mode === 'full-access') await decideApproval(record, 'approve');
        return approvalId;
      },
      authorities: { terminal: {}, chat: { [action]: async (input: CaoCanonicalControlAuthorityInput) => {
        signal.throwIfAborted(); input.signal.throwIfAborted();
        await check(record, !effectAction(action) || record.effects.length === 0);
        if (record.approvalId && record.effects.length === 0) {
          await approvals.claimApprovedExecution({ accountId: record.accountId, runId: record.runId,
            requestId: record.requestId, attemptNumber: 1, approvalId: record.approvalId,
            producerKind: 'action', ownerId: record.requestId, evidenceRef: record.runId,
            startedAt: Date.now(), expectedEventTailSeq: await tail(record) });
        }
        const binding = record.bindings.find(x => x.target.targetId === input.target.targetId)!;
        let outcome = 'reviewed';
        if (effectAction(action)) {
          outcome = await deps.control(action as 'restart' | 'cancel', input.target.targetId, binding.turnKey ?? '',
            `${record.requestId}:${record.effects.length}`, signal, async () => { await check(record, false); });
        }
        signal.throwIfAborted();
        const receiptId = id('cao_effect');
        record.effects.push({ targetId: input.target.targetId, receiptId, outcome });
        await save(record);
        await journal.appendEvent(record.accountId, record.runId, { type: 'message', idempotencyKey: receiptId,
          title: `CAO ${action}: ${outcome}`, safeSummary: effectAction(action) ? `Exact chat request ${outcome}; this is delivery evidence, not completion of its task.` : 'Grounded read-only review captured.',
          sourceRefs: [], artifactIds: [], createdAt: Date.now() });
        return { status: 'completed' as const, receiptId };
      } } },
      async verifyCompletedAction({ record: controlRecord }) {
        signal.throwIfAborted();
        await check(record, !effectAction(action));
        const observed = await registry.readExact({ ...record, leaseId: controlRecord.leaseId!, targets: controlRecord.targets });
        if (observed.length !== record.bindings.length || observed.some(target => target.ownerLeaseId !== controlRecord.leaseId ||
            target.accountId !== record.accountId || target.workspaceId !== record.workspaceId || target.projectId !== record.projectId ||
            target.locked || !record.effects.some(effect => effect.targetId === target.targetId))) throw Error('cao_control_effect_unconfirmed');
      },
    });
    const cancelInput = { accountId: record.accountId, workspaceId: record.workspaceId,
      projectId: record.projectId, requestId: record.requestId };
    const onAbort = () => { void composition.cancel(cancelInput).catch(() => undefined); };
    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
    record.status = 'running'; await save(record);
    let result;
    try { result = await composition.run({ ...cancelInput, command: record.command, targets: record.bindings.map(x => x.target) }); }
    finally { signal.removeEventListener('abort', onAbort); }
    record.status = result.status;
    record.error = result.errorCode;
    record.approvalId = result.approvalId;
    if (result.status === 'completed') record.report = record.review?.text ?? record.effects.map(effect => `${effect.targetId}: ${effect.outcome}. This confirms the control request, not completion of the agent's task.`).join('\n');
    await save(record); await settleJournal(record);
    return structuredClone(record);
  }
  const guarded = async (record: CaoChatCommandRecord, work: (signal: AbortSignal) => Promise<CaoChatCommandRecord>) => {
    if (active.has(record.requestId)) throw Error('cao_control_already_running');
    const controller = new AbortController(); active.set(record.requestId, controller);
    try { return await work(controller.signal); }
    catch (error) {
      record.status = controller.signal.aborted ? 'cancelled' : 'failed';
      record.error = error instanceof Error && /^cao_control_[a-z0-9_]+$/.test(error.message) ? error.message : 'cao_control_execution_failed';
      await closeControl(record);
      await save(record); await settleJournal(record);
      throw error;
    } finally { active.delete(record.requestId); }
  };
  async function closeControl(record: CaoChatCommandRecord) {
    const control = await controls.load(record.requestId);
    if (!control || terminalStatus(control.status)) return;
    if (control.accountId !== record.accountId || control.runId !== record.runId) throw Error('cao_control_record_invalid');
    if (!(await controls.save(control.revision, { ...control, revision: control.revision + 1,
      status: record.status === 'cancelled' ? 'cancelled' : 'failed', updatedAt: Date.now() }))) throw Error('cao_control_persistence_conflict');
    if (control.leaseId) await registry.releaseExact({ accountId: control.accountId, workspaceId: control.workspaceId,
      projectId: control.projectId, runId: control.runId, leaseId: control.leaseId, targets: control.targets });
  }
  return {
    read,
    async prepare(input: CaoControlScope & { callerChatId: string; command: CaoControlCommand }) {
      const auth = await deps.authorization(input.accountId);
      const latestId = (await db.settings.get(caoChatCommandLatestKey(input.accountId, input.callerChatId)))?.value;
      if (typeof latestId === 'string') {
        const previous = await read(input.accountId, latestId);
        if (previous && !terminalStatus(previous.status)) throw Error('cao_control_previous_command_pending');
      }
      if (input.command.selectors.some(x => x.kind !== 'chat')) throw Error('cao_control_terminal_authority_unavailable');
      const caller = await db.chats.get(input.callerChatId as ChatId);
      if (!caller || caller.workspace_id !== input.workspaceId || caller.project_id !== input.projectId) throw Error('cao_control_scope_unavailable');
      const chats = await db.chats.where('project_id').equals(input.projectId).toArray();
      const resolved = resolveCaoControlTargets({ command: input.command, scope: input, candidates: chats.map(chat => ({
        accountId: input.accountId, workspaceId: chat.workspace_id, projectId: chat.project_id!, kind: 'chat', targetId: chat.id,
        title: chat.title, revision: chat.updated_at, selected: true, locked: Boolean(chat.archived),
      })) });
      const record: CaoChatCommandRecord = { ...input, schemaVersion: 1, requestId: id('cao_command'), runId: id('jrun'),
        authorization: auth.signature, status: 'preparing', createdAt: Date.now(), updatedAt: Date.now(), effects: [],
        bindings: resolved.targets.map(target => ({ target, signature: signature(chats.find(chat => chat.id === target.targetId)!), turnKey: deps.runState(target.targetId)?.cancellationKey })) };
      await check(record);
      await save(record);
      await db.settings.put({ key: caoChatCommandLatestKey(input.accountId, input.callerChatId), value: record.requestId, updated_at: Date.now() });
      return guarded(record, async signal => {
        if (!effectAction(input.command.action)) {
          const history = (await Promise.all(record.bindings.map(async ({ target }) => db.messages.where('[chat_id+created_at]')
            .between([target.targetId, 0], [target.targetId, Date.now()], true, true).reverse().limit(100).toArray()))).flat();
          const evidence = collectCaoLearningEvidence(history, record.bindings.map(x => x.target.targetId));
          record.review = await deps.review(input.command.action, JSON.stringify({ ...evidence, targets: record.bindings.map(x => ({ ...x.target, state: deps.runState(x.target.targetId) ?? 'no active turn' })) }), auth.guidance, signal, record.requestId);
          if (!record.review.text.trim() || record.review.text.length > 16000) throw Error('cao_control_review_invalid');
        }
        signal.throwIfAborted(); await check(record);
        if ((await read(record.accountId, record.requestId))?.status !== 'preparing') throw Error('cao_control_interrupted');
        await journal.allocateRun({ id: record.runId, accountId: record.accountId, workspaceId: record.workspaceId,
          projectId: record.projectId, chatId: record.callerChatId, source: 'typed_chat', agentId: 'jarvis-cao', identityVersion: 1,
          profileRevisionId: record.authorization, model: { providerId: CAO_LEARNER_IDENTITY.providerId,
            modelId: CAO_LEARNER_IDENTITY.modelId, connectionId: CAO_LEARNER_IDENTITY.connectionId,
            connectionMode: 'external-cli', capabilities: { reasoning: true }, capturedAt: Date.now() } });
        await journal.transitionRun({ accountId: record.accountId, runId: record.runId, expectedStatus: 'queued', nextStatus: 'running',
          event: { idempotencyKey: `cao-command-start:${record.requestId}`, title: `CAO ${record.command.action}`, sourceRefs: [], artifactIds: [], createdAt: Date.now() } });
        return execute(record, signal);
      });
    },
    async decide(accountId: string, requestId: string, decision: 'approve' | 'deny') {
      const record = await read(accountId, requestId);
      if (!record) throw Error('cao_control_record_missing');
      if (terminalStatus(record.status)) return record;
      if (record.status !== 'awaiting_approval') throw Error('cao_control_recovery_required');
      return guarded(record, async signal => { await check(record); await decideApproval(record, decision); return execute(record, signal); });
    },
    async cancel(accountId: string, requestId: string) {
      const record = await read(accountId, requestId);
      if (!record || terminalStatus(record.status)) return;
      if (active.has(requestId)) { active.get(requestId)!.abort(); return; }
      if (record.status === 'awaiting_approval') { await decideApproval(record, 'deny'); }
      record.status = 'cancelled'; await closeControl(record); await save(record); await settleJournal(record);
    },
    async recover(accountId: string, requestId: string) {
      if (active.has(requestId)) return;
      const record = await read(accountId, requestId);
      if (!record || !['preparing', 'running'].includes(record.status)) return;
      record.status = 'failed'; record.error = 'cao_control_interrupted_check_target_before_retry';
      await closeControl(record); await save(record); await settleJournal(record);
    },
  };
}

import type {
  JarvisApprovalV1,
  JarvisAuthorityBoundResult,
  JarvisRun,
} from '@/lib/jarvis/contracts';
import type { JarvisRequestAttempt } from '@/lib/jarvis/requestEnvelope';
import type {
  JarvisCanonicalActionExecutionResult,
  JarvisKernelActionPort,
} from '@/lib/jarvis/approvalEngine';
import type { JarvisActionCatalog } from '@/lib/jarvis/actions/catalog';
import type { ToolGatewayExecutionContext } from '@/lib/harness/toolGatewayRuntime';

export type ToolGatewayActionRequest = Readonly<{
  actionId: string;
  params: Readonly<Record<string, unknown>>;
  context: ToolGatewayExecutionContext;
}>;
export type ToolGatewayActionScope = Readonly<{
  parentRun: JarvisRun;
  attempt: JarvisRequestAttempt;
}>;
type BoundExecution = JarvisAuthorityBoundResult<JarvisCanonicalActionExecutionResult>;
type Pending = {
  accountId: string;
  attemptKey: string;
  request: ToolGatewayActionRequest;
  approval: JarvisApprovalV1;
  resolve(choice: 'approve' | 'deny'): void;
  reject(error: Error): void;
  decision?: { choice: 'approve' | 'deny'; promise: ReturnType<JarvisKernelActionPort['decide']> };
};

function attemptIdentity(accountId: string, attempt: JarvisRequestAttempt): string {
  return JSON.stringify([accountId, attempt.runId, attempt.requestId, attempt.attemptNumber]);
}

function callFingerprint(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 64) throw Error('tool_action_parameters_invalid');
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw Error('tool_action_parameters_invalid');
    seen.add(value);
    const result = Array.isArray(value)
      ? `[${value.map((item) => callFingerprint(item, seen, depth + 1)).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${callFingerprint((value as Record<string, unknown>)[key], seen, depth + 1)}`,
          )
          .join(',')}}`;
    seen.delete(value);
    return result;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Installed only by the protected host. UI decisions never obtain an executor port. */
export function createToolGatewayActionBroker(deps: {
  actions: JarvisKernelActionPort;
  catalog: JarvisActionCatalog;
  now(): number;
  loadScope(request: ToolGatewayActionRequest): Promise<ToolGatewayActionScope>;
  publishPending(
    approval: JarvisApprovalV1,
    scope: ToolGatewayActionScope,
    request: ToolGatewayActionRequest,
  ): Promise<void>;
  publishOutcome(
    approval: JarvisApprovalV1,
    outcome: JarvisCanonicalActionExecutionResult | Error,
  ): Promise<void>;
}) {
  const pending = new Map<string, Pending>();
  // Retain rejected and settled identities for the whole owning attempt, not an approval ID.
  const calls = new Map<string, Map<string, string>>();
  let disposed = false;
  const current = async (request: ToolGatewayActionRequest) => {
    if (disposed || request.context.signal?.aborted) throw Error('tool_action_cancelled');
    const scope = await deps.loadScope(request);
    if (request.context.isRequestLive && !(await request.context.isRequestLive()))
      throw Error('tool_action_cancelled');
    if (disposed || request.context.signal?.aborted) throw Error('tool_action_cancelled');
    return scope;
  };
  const committed = (result: BoundExecution) => {
    if (result.kind !== 'committed') throw Error('tool_action_authority_revoked');
    return result.value;
  };
  return {
    owns(accountId: string, approvalId: string): boolean {
      return pending.get(approvalId)?.accountId === accountId;
    },
    async decide(accountId: string, approvalId: string, choice: 'approve' | 'deny') {
      const waiter = pending.get(approvalId);
      if (!waiter || waiter.accountId !== accountId) return null;
      if (deps.now() >= waiter.approval.expiresAt) throw Error('tool_action_expired');
      const scope = await current(waiter.request);
      if (waiter.decision) {
        if (waiter.decision.choice !== choice) throw Error('tool_action_decision_conflict');
        return waiter.decision.promise;
      }
      const promise = (async () => {
        const result = await deps.actions.decide({
          parentRun: scope.parentRun,
          approvalId,
          decision: choice,
        });
        await current(waiter.request);
        if (result.kind !== 'committed') throw Error('tool_action_authority_revoked');
        if (
          result.value.id !== approvalId ||
          result.value.status !== (choice === 'approve' ? 'approved' : 'denied')
        ) {
          throw Error('tool_action_decision_unverified');
        }
        waiter.resolve(choice);
        return result;
      })();
      waiter.decision = { choice, promise };
      try {
        return await promise;
      } catch (error) {
        waiter.reject(error instanceof Error ? error : Error('tool_action_decision_failed'));
        throw error;
      }
    },
    async request(input: ToolGatewayActionRequest): Promise<JarvisCanonicalActionExecutionResult> {
      const request = {
        ...input,
        params: structuredClone(input.params),
        context: Object.freeze({ ...input.context }),
      };
      const scope = await current(request);
      const attemptKey = attemptIdentity(scope.parentRun.accountId, scope.attempt);
      const callKey = JSON.stringify([
        request.context.sessionId,
        request.context.messageId,
        request.context.requestId,
      ]);
      let fingerprint = 'invalid-payload';
      let fingerprintError: unknown;
      try {
        fingerprint = callFingerprint({ actionId: request.actionId, params: request.params });
      } catch (error) {
        fingerprintError = error;
      }
      const attemptCalls = calls.get(attemptKey) ?? new Map<string, string>();
      const previous = attemptCalls.get(callKey);
      if (previous !== undefined)
        throw Error(
          previous === fingerprint ? 'tool_action_call_replayed' : 'tool_action_call_conflict',
        );
      if (attemptCalls.size >= 4096) throw Error('tool_action_call_limit');
      // Reserve before validation and before any async canonical creation/execution.
      // Rejected payloads cannot be changed and retried under the same logical call.
      attemptCalls.set(callKey, fingerprint);
      calls.set(attemptKey, attemptCalls);
      if (fingerprintError) throw fingerprintError;
      const registration = deps.catalog.resolve(request.actionId);
      if (!registration?.exposeToAI) throw Error('command_not_found');
      const context = {
        source: 'ai' as const,
        chatId: scope.parentRun.chatId,
        accountId: scope.parentRun.accountId,
        runId: scope.parentRun.id,
        requestId: scope.attempt.requestId,
        attemptNumber: scope.attempt.attemptNumber,
        messageId: request.context.messageId,
        callId: request.context.requestId,
        signal: request.context.signal,
        isRequestLive: request.context.isRequestLive,
      };
      const create = {
        parentRun: scope.parentRun,
        attempt: scope.attempt,
        actionId: registration.id,
        actionVersion: registration.version,
        params: structuredClone(registration.validateParameters(request.params)),
        expiresAt: deps.now() + 5 * 60_000,
      };
      if (registration.approval === 'never') {
        const result = committed(
          await deps.actions.executeAutoApprovedSafe({ ...create, context }),
        );
        await current(request);
        return result;
      }
      const created = await deps.actions.create(create);
      await current(request);
      if (created.kind !== 'committed') throw Error('tool_action_authority_revoked');
      const approval = created.value;
      if (
        approval.runId !== scope.parentRun.id ||
        approval.requestId !== scope.attempt.requestId ||
        approval.attemptNumber !== scope.attempt.attemptNumber ||
        approval.actionId !== registration.id ||
        approval.actionVersion !== registration.version ||
        approval.status !== 'pending' ||
        approval.expiresAt <= deps.now()
      )
        throw Error('tool_action_approval_unverified');
      if (pending.has(approval.id)) throw Error('tool_action_approval_replayed');
      let resolve!: Pending['resolve'];
      let reject!: Pending['reject'];
      const decision = new Promise<'approve' | 'deny'>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // A cancellation during async publication must not become an unhandled rejection.
      void decision.catch(() => {});
      pending.set(approval.id, {
        accountId: scope.parentRun.accountId,
        attemptKey,
        request,
        approval,
        resolve,
        reject,
      });
      const signal = request.context.signal;
      const abort = () => reject(Error('tool_action_cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      const expiry = setTimeout(
        () => reject(Error('tool_action_expired')),
        Math.max(0, approval.expiresAt - deps.now()),
      );
      try {
        if (signal?.aborted) abort();
        await deps.publishPending(approval, scope, request);
        const choice = await decision;
        if (choice !== 'approve') throw Error('tool_action_denied');
        const liveScope = await current(request);
        const result = committed(
          await deps.actions.execute({
            parentRun: liveScope.parentRun,
            approvalId: approval.id,
            context: { ...context, approvalId: approval.id },
          }),
        );
        await current(request);
        await deps.publishOutcome(approval, result);
        return result;
      } catch (error) {
        await deps.publishOutcome(
          approval,
          error instanceof Error ? error : Error('tool_action_failed'),
        );
        throw error;
      } finally {
        clearTimeout(expiry);
        signal?.removeEventListener('abort', abort);
        pending.delete(approval.id);
      }
    },
    releaseAttempt(accountId: string, attempt: JarvisRequestAttempt) {
      const key = attemptIdentity(accountId, attempt);
      calls.delete(key);
      for (const waiter of pending.values()) {
        if (waiter.attemptKey === key) waiter.reject(Error('tool_action_cancelled'));
      }
    },
    dispose() {
      disposed = true;
      calls.clear();
      for (const waiter of pending.values()) waiter.reject(Error('tool_action_cancelled'));
    },
  };
}

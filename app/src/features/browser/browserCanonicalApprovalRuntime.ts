import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import type { JarvisKernelActionPort } from '@/lib/jarvis/approvalEngine';
import {
  createBrowserApprovalAdapter,
  type BrowserApprovalParentReference,
} from './browserApprovalAdapter';
import {
  validateBrowserReviewedAction,
  type BrowserReviewContext,
  type BrowserToolRequest,
} from './browserActions';
import { useBrowserStore, type BrowserState } from './browserStore';
import type { BrowserReviewedAction } from './browserTypes';

const UNAVAILABLE = 'Browser Operator canonical parent authority is unavailable.';
const FAILED = 'Canonical browser operation failed before verified settlement.';
const CANCELLED = 'Browser operation was cancelled before verified settlement.';
const COMPLETED = 'Approved browser operation completed and was observed.';

export type BrowserCanonicalApprovalAuthority = Readonly<{
  parent: BrowserApprovalParentReference;
  actions: Pick<
    JarvisKernelActionPort,
    'create' | 'decide' | 'execute' | 'executeAutoApprovedSafe'
  >;
}>;

export type BrowserCanonicalApprovalOutcome = Readonly<{
  ok: boolean;
  actionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'denied' | 'expired' | 'unavailable';
  message: string;
}>;

type BrowserApprovalStore = Pick<BrowserState, 'agentActions' | 'activeTab' | 'resolveAgentAction'>;

export interface BrowserCanonicalApprovalRuntime {
  register(actionId: string, authority: BrowserCanonicalApprovalAuthority): void;
  approve(actionId: string): Promise<BrowserCanonicalApprovalOutcome>;
  deny(actionId: string): BrowserCanonicalApprovalOutcome;
  revoke(actionId: string): void;
}

export interface BrowserCanonicalApprovalRuntimeDependencies {
  readonly store?: () => BrowserApprovalStore;
  readonly activeAccountId?: () => string | undefined;
  readonly now?: () => number;
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function immutableAction(action: BrowserReviewedAction): Readonly<BrowserReviewedAction> {
  return deepFreeze(structuredClone(action));
}

function outcome(
  actionId: string,
  status: BrowserCanonicalApprovalOutcome['status'],
  message: string,
): BrowserCanonicalApprovalOutcome {
  return Object.freeze({ ok: status === 'completed', actionId, status, message });
}

function cancellationError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && (error.name === 'AbortError' || /cancel/i.test(error.message)))
  );
}

export function createBrowserCanonicalApprovalRuntime(
  dependencies: BrowserCanonicalApprovalRuntimeDependencies = {},
): BrowserCanonicalApprovalRuntime {
  const getStore = dependencies.store ?? (() => useBrowserStore.getState());
  const activeAccountId =
    dependencies.activeAccountId ?? (() => getActiveAccountIdentity()?.accountId);
  const now = dependencies.now ?? (() => Date.now());
  const authorities = new Map<string, BrowserCanonicalApprovalAuthority>();
  const inFlight = new Map<string, Promise<BrowserCanonicalApprovalOutcome>>();
  const consumed = new Set<string>();

  const settle = (
    actionId: string,
    status: Exclude<BrowserCanonicalApprovalOutcome['status'], 'denied'>,
    message: string,
  ) => {
    getStore().resolveAgentAction(actionId, status, message);
    return outcome(actionId, status, message);
  };

  const settleExecution = (
    actionId: string,
    result: Awaited<ReturnType<JarvisKernelActionPort['execute']>>,
  ) => {
    if (result.kind !== 'committed') return settle(actionId, 'unavailable', UNAVAILABLE);
    if (result.value.kind !== 'settled' || !result.value.result.ok) {
      return settle(actionId, 'failed', FAILED);
    }
    return settle(actionId, 'completed', COMPLETED);
  };

  return Object.freeze<BrowserCanonicalApprovalRuntime>({
    register(actionId, authority) {
      if (
        !actionId ||
        consumed.has(actionId) ||
        authorities.has(actionId) ||
        !Object.isFrozen(authority) ||
        !Object.isFrozen(authority.parent) ||
        typeof authority.actions?.create !== 'function' ||
        typeof authority.actions?.decide !== 'function' ||
        typeof authority.actions?.execute !== 'function' ||
        typeof authority.actions?.executeAutoApprovedSafe !== 'function'
      ) {
        throw new Error('Invalid or duplicate canonical browser approval authority.');
      }
      const action = getStore().agentActions.find((candidate) => candidate.id === actionId);
      if (!action || action.status !== 'pending') {
        throw new Error('Canonical browser review is unavailable.');
      }
      authorities.set(
        actionId,
        Object.freeze({
          parent: authority.parent,
          actions: Object.freeze({
            create: authority.actions.create,
            decide: authority.actions.decide,
            execute: authority.actions.execute,
            executeAutoApprovedSafe: authority.actions.executeAutoApprovedSafe,
          }),
        }),
      );
    },
    approve(actionId) {
      const existing = inFlight.get(actionId);
      if (existing) return existing;
      const pending = (async () => {
        const store = getStore();
        const action = store.agentActions.find((candidate) => candidate.id === actionId);
        const authority = authorities.get(actionId);
        if (!action || action.status !== 'pending' || consumed.has(actionId)) {
          return outcome(actionId, 'unavailable', UNAVAILABLE);
        }
        if (!authority) {
          consumed.add(actionId);
          return settle(actionId, 'unavailable', UNAVAILABLE);
        }
        const tab = store.activeTab();
        const accountId = activeAccountId();
        if (!tab || !accountId || action.frameId !== undefined) {
          consumed.add(actionId);
          authorities.delete(actionId);
          return settle(actionId, 'unavailable', UNAVAILABLE);
        }
        const reviewed = immutableAction(action);
        const request: BrowserToolRequest = {
          tool: reviewed.kind,
          params: reviewed.parameters,
          requester: reviewed.requester,
        };
        const context: BrowserReviewContext = {
          accountId,
          origin: originForUrl(tab.url),
          tabId: tab.id,
          target: { ...reviewed.target, currentUrl: tab.url },
          now: now(),
        };
        consumed.add(actionId);
        authorities.delete(actionId);
        const validation = await validateBrowserReviewedAction(reviewed, request, context);
        if (!validation.ok) {
          return settle(
            actionId,
            validation.reason === 'expired' ? 'expired' : 'unavailable',
            validation.reason === 'expired'
              ? 'Browser Operator review expired.'
              : UNAVAILABLE,
          );
        }

        const actions = authority.actions;
        const adapter = createBrowserApprovalAdapter({
          actions: Object.freeze({
            create: actions.create,
            executeAutoApprovedSafe: actions.executeAutoApprovedSafe,
          }),
        });
        try {
          const submitted = await adapter.submit(
            validation.action,
            authority.parent,
          );
          if (submitted.kind === 'safe_execution') {
            return settleExecution(actionId, submitted.result);
          }
          if (
            submitted.result.kind !== 'committed' ||
            submitted.result.value.status !== 'pending' ||
            submitted.result.value.runId !== authority.parent.parentRun.id
          ) {
            return settle(actionId, 'unavailable', UNAVAILABLE);
          }
          const approvalId = submitted.result.value.id;
          const decision = await actions.decide({
            parentRun: authority.parent.parentRun,
            approvalId,
            decision: 'approve',
          });
          if (
            decision.kind !== 'committed' ||
            decision.value.id !== approvalId ||
            decision.value.runId !== authority.parent.parentRun.id ||
            decision.value.status !== 'approved'
          ) {
            return settle(actionId, 'unavailable', UNAVAILABLE);
          }
          return settleExecution(
            actionId,
            await actions.execute({
              parentRun: authority.parent.parentRun,
              approvalId,
              context: authority.parent.context,
            }),
          );
        } catch (error) {
          return settle(
            actionId,
            cancellationError(error) ? 'cancelled' : 'failed',
            cancellationError(error) ? CANCELLED : FAILED,
          );
        }
      })().finally(() => inFlight.delete(actionId));
      inFlight.set(actionId, pending);
      return pending;
    },
    deny(actionId) {
      const action = getStore().agentActions.find((candidate) => candidate.id === actionId);
      if (!action || action.status !== 'pending' || consumed.has(actionId)) {
        return outcome(actionId, 'unavailable', UNAVAILABLE);
      }
      consumed.add(actionId);
      authorities.delete(actionId);
      getStore().resolveAgentAction(actionId, 'denied', 'Denied by user.');
      return outcome(actionId, 'denied', 'Denied by user.');
    },
    revoke(actionId) {
      authorities.delete(actionId);
    },
  });
}

export const browserCanonicalApprovalRuntime = createBrowserCanonicalApprovalRuntime();

export function registerBrowserCanonicalApprovalAuthority(
  actionId: string,
  authority: BrowserCanonicalApprovalAuthority,
): void {
  browserCanonicalApprovalRuntime.register(actionId, authority);
}

export function approveBrowserCanonicalReviewedAction(
  actionId: string,
): Promise<BrowserCanonicalApprovalOutcome> {
  return browserCanonicalApprovalRuntime.approve(actionId);
}

export function denyBrowserCanonicalReviewedAction(
  actionId: string,
): BrowserCanonicalApprovalOutcome {
  return browserCanonicalApprovalRuntime.deny(actionId);
}

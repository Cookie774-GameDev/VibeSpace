import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import type { JarvisIssuedActionExecution } from '@/lib/jarvis/approvalEngine';
import type { BrowserActionAuthorization } from '@/lib/jarvis/browserActionApproval';
import { createBrowserGoalPlaywrightAdapter } from '@/lib/jarvis/browserGoalPlaywrightAdapter';
import {
  createPlaywrightBrowserWorker,
  hashPlaywrightBrowserAction,
  type PlaywrightBrowserAction,
  type PlaywrightBrowserReceipt,
  type PlaywrightIsolatedHostPort,
} from '@/lib/jarvis/playwrightBrowserWorker';
import { evaluateUntrustedContent } from '@/lib/jarvis/untrustedContentPolicy';
import { BROWSER_OPERATOR_CAPABILITY_ID } from './browserApprovalAdapter';

const OPERATIONS = new Set([
  'browser.readPage',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.upload',
  'browser.download',
  'browser.screenshot',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;

export type BrowserPlaywrightHostScope = Readonly<{
  accountId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  taskId: string;
  agentId: string;
  purpose: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type BrowserPlaywrightActionBinding = Readonly<{
  requestId: string;
  attemptNumber: number;
  operation: string;
  parametersHash: string;
  reviewedHash: string;
  action: PlaywrightBrowserAction;
  authorization: BrowserActionAuthorization;
  timeoutMs: number;
}>;

export type BrowserPlaywrightHostLease = Readonly<{
  id: string;
  scope: BrowserPlaywrightHostScope;
  revoke(): void;
}>;

type RegisteredBinding = BrowserPlaywrightActionBinding &
  Readonly<{ actionHash: `sha256:${string}` }>;

type HostRecord = Readonly<{
  id: string;
  scope: BrowserPlaywrightHostScope;
  port: PlaywrightIsolatedHostPort;
  bindings: ReadonlyMap<string, RegisteredBinding>;
  claimedBindings: Set<string>;
}>;

let activeHost: HostRecord | null = null;

function stableText(value: unknown, maximum = 2_000): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Playwright host origin.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid Playwright host origin.');
  }
  return url.origin.toLowerCase();
}

function bindingKey(requestId: string, attemptNumber: number, operation: string): string {
  return `${requestId}\u0000${attemptNumber}\u0000${operation}`;
}

function canonicalOperationForAction(action: PlaywrightBrowserAction): string | null {
  if (action.name === 'observe') return 'browser.readPage';
  if (action.name === 'navigate') return 'browser.navigate';
  if (action.name === 'click') return 'browser.click';
  if (action.name === 'fill') return 'browser.type';
  if (action.name === 'upload') return 'browser.upload';
  if (action.name === 'download') return 'browser.download';
  if (action.name === 'screenshot') return 'browser.screenshot';
  return null;
}

function adapterOperationForAction(action: PlaywrightBrowserAction): string {
  const operation = canonicalOperationForAction(action);
  if (operation === 'browser.readPage') return 'browser.snapshot';
  if (operation === 'browser.upload') return 'browser.type';
  return operation ?? 'browser.unsupported';
}

export async function registerIsolatedPlaywrightBrowserHost(input: {
  scope: BrowserPlaywrightHostScope;
  port: PlaywrightIsolatedHostPort;
  bindings: readonly BrowserPlaywrightActionBinding[];
}): Promise<BrowserPlaywrightHostLease> {
  const { scope } = input;
  if (
    !SAFE_ID.test(scope.accountId) ||
    !SAFE_ID.test(scope.projectId) ||
    !SAFE_ID.test(scope.runId) ||
    !SAFE_ID.test(scope.sessionId) ||
    !SAFE_ID.test(scope.tabId) ||
    canonicalOrigin(scope.origin) !== scope.origin.toLowerCase() ||
    !SAFE_ID.test(scope.taskId) ||
    !SAFE_ID.test(scope.agentId) ||
    !stableText(scope.purpose, 1_000) ||
    !Number.isSafeInteger(scope.issuedAt) ||
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.issuedAt < 0 ||
    scope.expiresAt <= scope.issuedAt ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 500
  ) {
    throw new Error('Invalid isolated Playwright host registration.');
  }
  const bindings = new Map<string, RegisteredBinding>();
  for (const binding of input.bindings) {
    const actionHash = await hashPlaywrightBrowserAction(binding.action);
    const key = bindingKey(binding.requestId, binding.attemptNumber, binding.operation);
    if (
      !SAFE_ID.test(binding.requestId) ||
      !Number.isSafeInteger(binding.attemptNumber) ||
      binding.attemptNumber < 1 ||
      !OPERATIONS.has(binding.operation) ||
      !/^(?:sha256:)?[a-f0-9]{64}$/u.test(binding.parametersHash) ||
      !/^(?:sha256:)?[a-f0-9]{64}$/u.test(binding.reviewedHash) ||
      !Number.isSafeInteger(binding.timeoutMs) ||
      binding.timeoutMs < 1 ||
      binding.timeoutMs > 30_000 ||
      binding.authorization.requestId !== binding.requestId ||
      binding.authorization.accountId !== scope.accountId ||
      binding.authorization.projectId !== scope.projectId ||
      binding.authorization.sessionId !== scope.sessionId ||
      binding.authorization.actionHash !== actionHash ||
      canonicalOperationForAction(binding.action) !== binding.operation ||
      bindings.has(key)
    ) {
      throw new Error('Invalid exact Playwright action binding.');
    }
    bindings.set(
      key,
      Object.freeze({
        ...binding,
        action: Object.freeze(structuredClone(binding.action)),
        authorization: Object.freeze(structuredClone(binding.authorization)),
        actionHash,
      }),
    );
  }
  const id = `playwright-host-${crypto.randomUUID()}`;
  const frozenScope = Object.freeze({ ...scope });
  const frozenPort: PlaywrightIsolatedHostPort = Object.freeze({
    resolveLease: input.port.resolveLease.bind(input.port),
    execute: input.port.execute.bind(input.port),
  });
  activeHost = Object.freeze({
    id,
    scope: frozenScope,
    port: frozenPort,
    bindings,
    claimedBindings: new Set<string>(),
  });
  return Object.freeze({
    id,
    scope: frozenScope,
    revoke() {
      if (activeHost?.id === id) activeHost = null;
    },
  });
}

export function revokeIsolatedPlaywrightBrowserHost(): void {
  activeHost = null;
}

export function hasLiveIsolatedPlaywrightBrowserHost(now = Date.now()): boolean {
  return (
    activeHost !== null &&
    now >= activeHost.scope.issuedAt &&
    now < activeHost.scope.expiresAt
  );
}

export async function dispatchIsolatedPlaywrightBrowserAction(input: {
  operation: string;
  registrationVersion: number;
  approvedOrigin: string;
  approvedTabId: string;
  approvedParametersHash: string;
  approvedReviewedHash: string;
  context: RegisteredActionExecutionContext;
  execution: JarvisIssuedActionExecution;
}): Promise<ActionResult> {
  const host = activeHost;
  const now = Date.now();
  if (!host || now < host.scope.issuedAt || now >= host.scope.expiresAt) {
    return { ok: false, error: 'A live isolated Playwright host registration is required.' };
  }
  const key = bindingKey(
    input.context.requestId,
    input.context.attemptNumber,
    input.operation,
  );
  const binding = host.bindings.get(key);
  if (
    !binding ||
    input.registrationVersion !== 1 ||
    input.context.source !== 'ai' ||
    input.context.accountId !== host.scope.accountId ||
    input.context.runId !== host.scope.runId ||
    input.approvedOrigin !== host.scope.origin ||
    input.approvedTabId !== host.scope.tabId ||
    input.approvedParametersHash !== binding.parametersHash ||
    input.approvedReviewedHash !== binding.reviewedHash ||
    input.execution.approval.status !== 'consumed' ||
    input.execution.approval.capabilityId !== BROWSER_OPERATOR_CAPABILITY_ID ||
    input.execution.approval.actionId !== input.operation ||
    input.execution.approval.actionVersion !== input.registrationVersion ||
    input.execution.approval.runId !== host.scope.runId ||
    input.execution.approval.requestId !== binding.requestId ||
    input.execution.approval.attemptNumber !== binding.attemptNumber ||
    input.execution.initialLiveProof.accountId !== host.scope.accountId ||
    input.execution.initialLiveProof.runId !== host.scope.runId ||
    input.execution.initialLiveProof.requestId !== binding.requestId ||
    input.execution.initialLiveProof.attemptNumber !== binding.attemptNumber
  ) {
    return { ok: false, error: 'Playwright host scope does not match the issued execution.' };
  }
  if (host.claimedBindings.has(key)) {
    return { ok: false, error: 'Playwright action binding has already been claimed.' };
  }
  host.claimedBindings.add(key);

  const worker = createPlaywrightBrowserWorker(host.port);
  const adapter = createBrowserGoalPlaywrightAdapter({
    id: BROWSER_OPERATOR_CAPABILITY_ID,
    worker,
    maximumRetainedReceipts: 1,
    catalog: {
      resolve: async (request) =>
        Object.freeze({
          accountId: host.scope.accountId,
          projectId: host.scope.projectId,
          runId: host.scope.runId,
          workspaceRoot: `vibe-browser:${host.scope.sessionId}:${host.scope.tabId}`,
          scope: Object.freeze({
            accountId: host.scope.accountId,
            projectId: host.scope.projectId,
            taskId: host.scope.taskId,
            agentId: host.scope.agentId,
            purpose: host.scope.purpose,
            sessionId: host.scope.sessionId,
            requestId: binding.requestId,
            actionHash: binding.actionHash,
            now,
            timeoutMs: binding.timeoutMs,
          }),
          action: binding.action,
          authorization: binding.authorization,
        }),
    },
  });
  const request = Object.freeze({
    capabilityId: BROWSER_OPERATOR_CAPABILITY_ID,
    capabilityVersion: 1,
    kind: 'browser' as const,
    operation: adapterOperationForAction(binding.action),
    accountId: host.scope.accountId,
    runId: host.scope.runId,
    requestId: binding.requestId,
    attemptNumber: binding.attemptNumber,
    workspaceRoot: `vibe-browser:${host.scope.sessionId}:${host.scope.tabId}`,
    parameterHash: binding.actionHash,
  });
  try {
    const started = input.execution.beginExternalEffect((signal) => {
      if (signal.aborted) {
        throw new Error('Playwright browser operation was cancelled before execution.');
      }
      return {
        completion: adapter.nativeAdapter.execute({ request, signal }),
      };
    });
    if (started.kind !== 'committed') {
      throw new Error('Playwright authority was revoked before execution.');
    }
    const adapterResult = await started.value.completion;
    const receipt = adapter.receipt(adapterResult.resultRef);
    if (!receipt) throw new Error('Canonical Playwright receipt was not retained.');
    const recorded = await input.execution.recordResult({
      state: adapterResult.state,
      resultRef: adapterResult.resultRef,
      completedAt: receipt.finishedAt,
    });
    if (recorded.kind !== 'committed') {
      throw new Error('Playwright authority was revoked before result recording.');
    }
    const contentReceipt = receipt.observation
      ? await evaluateUntrustedContent({
          source: 'browser_dom',
          content: `${receipt.observation.title}\n${receipt.observation.text}`,
        })
      : undefined;
    return {
      ok: true,
      summary: 'Approved isolated Playwright operation completed.',
      data: {
        outcome: Object.freeze({
          capabilityId: BROWSER_OPERATOR_CAPABILITY_ID,
          capabilityVersion: 1,
          kind: 'browser',
          operation: input.operation,
          state: adapterResult.state,
          resultRef: adapterResult.resultRef,
          evidenceRef: recorded.value.proofRef,
        }),
        receipt,
        ...(contentReceipt ? { contentReceipt } : {}),
        sessionId: host.scope.sessionId,
        tabId: host.scope.tabId,
        hostSource: 'playwright',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && /cancel|abort|revok/i.test(error.message)
          ? 'Playwright browser operation was cancelled before verified settlement.'
          : 'Playwright browser operation failed before verified settlement.',
    };
  }
}

export function getRetainedPlaywrightReceipt(
  result: ActionResult,
): PlaywrightBrowserReceipt | undefined {
  if (!result.ok || !result.data || typeof result.data !== 'object') return undefined;
  return (result.data as { receipt?: PlaywrightBrowserReceipt }).receipt;
}

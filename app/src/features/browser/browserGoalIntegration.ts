import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import type { JarvisIssuedActionExecution } from '@/lib/jarvis/approvalEngine';
import type { JarvisRegisteredActionDefinition } from '@/lib/jarvis/actions/catalog';
import { hashJarvisText } from '@/lib/jarvis/identity';
import {
  createNativeCapabilityBroker,
  type NativeCapabilityAdapterResult,
  type NativeCapabilityRequest,
} from '@/lib/jarvis/nativeCapabilityBroker';
import { evaluateUntrustedContent } from '@/lib/jarvis/untrustedContentPolicy';
import type { CdpSession } from './browserClient';
import { canonicalizeBrowserJson } from './browserActions';
import { BROWSER_OPERATOR_CAPABILITY_ID } from './browserApprovalAdapter';
import type { BrowserCanonicalApprovalParametersV1 } from './browserApprovalAdapter';
import type { BrowserJsonObject, BrowserJsonValue } from './browserTypes';
import {
  dispatchIsolatedPlaywrightBrowserAction,
  hasLiveIsolatedPlaywrightBrowserHost,
  registerIsolatedPlaywrightBrowserHost,
  revokeIsolatedPlaywrightBrowserHost,
  type BrowserPlaywrightHostLease,
  type BrowserPlaywrightHostScope,
  type BrowserPlaywrightActionBinding,
} from './browserPlaywrightIntegration';
import type { PlaywrightIsolatedHostPort } from '@/lib/jarvis/playwrightBrowserWorker';

export const BROWSER_GOAL_HOST_LEASE_MS = 15 * 60_000;

const FIXED_OPERATIONS = new Set([
  'browser.readPage',
  'browser.navigate',
  'browser.click',
  'browser.type',
]);
const PLAYWRIGHT_OPERATIONS = new Set([
  ...FIXED_OPERATIONS,
  'browser.upload',
  'browser.download',
  'browser.screenshot',
]);
const FIXED_PAGE_PROBE =
  "(() => ({url: String(location.href), title: String(document.title), text: String(document.body?.innerText ?? '').slice(0, 20000)}))()";

export type BrowserGoalHostScope = Readonly<{
  accountId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  purpose: 'browser_goal';
  issuedAt: number;
  expiresAt: number;
}>;

export type BrowserGoalHostLease = Readonly<{
  id: string;
  scope: BrowserGoalHostScope;
  revoke(): void;
}>;

type HostRecord = Readonly<{
  id: string;
  scope: BrowserGoalHostScope;
  cdp: Pick<CdpSession, 'evaluate' | 'navigate' | 'inputClick' | 'inputType'>;
}>;

let activeHost: HostRecord | null = null;
export type BrowserGoalHostSource = 'scoped_cdp' | 'playwright';
let selectedHostSource: BrowserGoalHostSource | null = null;
let selectedPlaywrightHostId: string | null = null;
const claimedCanonicalExecutions = new WeakSet<object>();

function stableText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2_000 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

function canonicalApprovalParameters(
  value: Readonly<Record<string, unknown>>,
  operation: string,
): BrowserCanonicalApprovalParametersV1 {
  const record = plainRecord(value);
  const capability = plainRecord(record?.capability);
  const parameters = plainRecord(record?.parameters);
  const target = plainRecord(record?.target);
  if (
    !record ||
    Reflect.ownKeys(record).length !== 12 ||
    record.schemaVersion !== 1 ||
    !stableText(record.reviewId) ||
    !stableText(record.origin) ||
    !stableText(record.tabId) ||
    (record.frameId !== null && !stableText(record.frameId)) ||
    !target ||
    !parameters ||
    !stableText(record.parametersHash) ||
    !stableText(record.reviewedHash) ||
    !stableText(record.expectedEffect) ||
    !['safe', 'confirm', 'dangerous'].includes(String(record.reviewedRisk)) ||
    !capability ||
    Reflect.ownKeys(capability).length !== 2 ||
    capability.id !== BROWSER_OPERATOR_CAPABILITY_ID ||
    capability.operation !== operation
  ) {
    throw new Error('Canonical browser approval parameters are required.');
  }
  canonicalizeBrowserJson(target as BrowserJsonObject);
  canonicalizeBrowserJson(parameters as BrowserJsonObject);
  return value as BrowserCanonicalApprovalParametersV1;
}

function fixedNumber(value: BrowserJsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Browser ${label} must be a finite number.`);
  }
  return value;
}

function fixedText(value: BrowserJsonValue | undefined, label: string): string {
  if (!stableText(value)) throw new Error(`Browser ${label} must be nonblank.`);
  return value;
}

function assertHostAuthority(host: HostRecord): void {
  const now = Date.now();
  if (
    activeHost?.id !== host.id ||
    now < host.scope.issuedAt ||
    now >= host.scope.expiresAt
  ) {
    throw new DOMException('Browser host authority revoked.', 'AbortError');
  }
}

async function observePage(
  cdp: HostRecord['cdp'],
): Promise<Readonly<{ url: string; title: string; text: string }>> {
  const response = plainRecord(await cdp.evaluate(FIXED_PAGE_PROBE));
  const result = plainRecord(response?.result);
  const value = plainRecord(result?.value);
  if (!value || !stableText(value.url) || typeof value.title !== 'string' || typeof value.text !== 'string') {
    throw new Error('Browser post-action observation was unavailable.');
  }
  return Object.freeze({
    url: value.url,
    title: value.title.slice(0, 1_000),
    text: value.text.slice(0, 20_000),
  });
}

export function registerBrowserGoalHostSession(input: {
  scope: BrowserGoalHostScope;
  cdp: Pick<CdpSession, 'evaluate' | 'navigate' | 'inputClick' | 'inputType'>;
}): BrowserGoalHostLease {
  const { scope } = input;
  if (
    !stableText(scope.accountId) ||
    !stableText(scope.sessionId) ||
    !stableText(scope.tabId) ||
    !stableText(scope.origin) ||
    scope.purpose !== 'browser_goal' ||
    !Number.isSafeInteger(scope.issuedAt) ||
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.expiresAt <= scope.issuedAt
  ) {
    throw new Error('Invalid browser host session scope.');
  }
  const id = `browser-host-${crypto.randomUUID()}`;
  const frozenScope = Object.freeze({ ...scope });
  activeHost = Object.freeze({ id, scope: frozenScope, cdp: input.cdp });
  selectedHostSource = 'scoped_cdp';
  return Object.freeze({
    id,
    scope: frozenScope,
    revoke() {
      if (activeHost?.id === id) {
        activeHost = null;
        if (selectedHostSource === 'scoped_cdp') selectedHostSource = null;
      }
    },
  });
}

export function revokeBrowserGoalHostSession(): void {
  activeHost = null;
  if (selectedHostSource === 'scoped_cdp') selectedHostSource = null;
}

export function hasLiveBrowserGoalHostSession(now = Date.now()): boolean {
  return (
    selectedHostSource === 'scoped_cdp' &&
    activeHost !== null &&
    now >= activeHost.scope.issuedAt &&
    now < activeHost.scope.expiresAt
  );
}

export async function registerBrowserGoalPlaywrightHost(input: {
  scope: BrowserPlaywrightHostScope;
  port: PlaywrightIsolatedHostPort;
  bindings: readonly BrowserPlaywrightActionBinding[];
}): Promise<BrowserPlaywrightHostLease> {
  const lease = await registerIsolatedPlaywrightBrowserHost(input);
  selectedHostSource = 'playwright';
  selectedPlaywrightHostId = lease.id;
  return Object.freeze({
    ...lease,
    revoke() {
      lease.revoke();
      if (
        selectedHostSource === 'playwright' &&
        selectedPlaywrightHostId === lease.id
      ) {
        selectedHostSource = null;
        selectedPlaywrightHostId = null;
      }
    },
  });
}

export function revokeBrowserGoalPlaywrightHost(): void {
  revokeIsolatedPlaywrightBrowserHost();
  selectedPlaywrightHostId = null;
  if (selectedHostSource === 'playwright') selectedHostSource = null;
}

export function selectedBrowserGoalHostSource(): BrowserGoalHostSource | null {
  return selectedHostSource;
}

async function executeFixedHostOperation(
  host: HostRecord,
  operation: string,
  parameters: Readonly<Record<string, BrowserJsonValue>>,
  signal: AbortSignal,
): Promise<Readonly<{ observation: Awaited<ReturnType<typeof observePage>>; resultRef: `jresult_${string}` }>> {
  assertHostAuthority(host);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (operation === 'browser.navigate') {
    const url = fixedText(parameters.url, 'URL');
    await host.cdp.navigate(url);
    assertHostAuthority(host);
  } else if (operation === 'browser.click') {
    await host.cdp.inputClick(
      fixedNumber(parameters.x, 'x coordinate'),
      fixedNumber(parameters.y, 'y coordinate'),
    );
    assertHostAuthority(host);
  } else if (operation === 'browser.type') {
    await host.cdp.inputType(fixedText(parameters.text, 'text'));
    assertHostAuthority(host);
  } else if (operation !== 'browser.readPage') {
    throw new Error('Unsupported fixed browser operation.');
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const observation = await observePage(host.cdp);
  assertHostAuthority(host);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const digest = await hashJarvisText(
    canonicalizeBrowserJson({
      operation,
      sessionId: host.scope.sessionId,
      tabId: host.scope.tabId,
      observation,
    }),
  );
  return Object.freeze({
    observation,
    resultRef: `jresult_browser_${digest}` as const,
  });
}

export async function dispatchCanonicalBrowserGoalAction(input: {
  registration: Readonly<JarvisRegisteredActionDefinition>;
  params: Readonly<Record<string, unknown>>;
  context: RegisteredActionExecutionContext;
  execution: JarvisIssuedActionExecution;
}): Promise<ActionResult | null> {
  const operation = input.registration.id;
  if (
    !FIXED_OPERATIONS.has(operation) &&
    !(selectedHostSource === 'playwright' && PLAYWRIGHT_OPERATIONS.has(operation))
  ) {
    return null;
  }
  if (
    input.registration.executor.kind !== 'builtin' ||
    input.registration.executor.registryActionId !== operation
  ) {
    return { ok: false, error: 'Canonical browser registration is unavailable.' };
  }

  let approved: BrowserCanonicalApprovalParametersV1;
  try {
    approved = canonicalApprovalParameters(input.params, operation);
  } catch {
    return { ok: false, error: 'Canonical browser approval binding is invalid.' };
  }

  const storedParameterHash = await hashJarvisText(
    canonicalizeBrowserJson(approved.parameters as BrowserJsonObject),
  );
  if (storedParameterHash !== approved.parametersHash) {
    return { ok: false, error: 'Browser parameters do not match the reviewed hash.' };
  }
  if (selectedHostSource === 'playwright') {
    if (!hasLiveIsolatedPlaywrightBrowserHost()) {
      return { ok: false, error: 'A live isolated Playwright host registration is required.' };
    }
    if (
      originForUrl(String((approved.target as Record<string, unknown>).currentUrl ?? '')) !==
      approved.origin
    ) {
      return { ok: false, error: 'Playwright host scope does not match the reviewed origin.' };
    }
    if (claimedCanonicalExecutions.has(input.execution as object)) {
      return { ok: false, error: 'Canonical browser execution has already been claimed.' };
    }
    claimedCanonicalExecutions.add(input.execution as object);
    return dispatchIsolatedPlaywrightBrowserAction({
      operation,
      registrationVersion: input.registration.version,
      approvedOrigin: approved.origin,
      approvedTabId: approved.tabId,
      approvedParametersHash: approved.parametersHash,
      approvedReviewedHash: approved.reviewedHash,
      context: input.context,
      execution: input.execution,
    });
  }
  if (selectedHostSource !== 'scoped_cdp') {
    return { ok: false, error: 'An explicit browser host source registration is required.' };
  }
  const host = activeHost;
  const now = Date.now();
  if (!host || now < host.scope.issuedAt || now >= host.scope.expiresAt) {
    return { ok: false, error: 'A live scoped Vibe Browser host session is required.' };
  }
  if (
    input.context.source !== 'ai' ||
    input.context.accountId !== host.scope.accountId ||
    input.context.accountId !== input.execution.initialLiveProof.accountId ||
    input.context.runId !== input.execution.approval.runId ||
    input.context.requestId !== input.execution.approval.requestId ||
    input.context.attemptNumber !== input.execution.approval.attemptNumber ||
    approved.tabId !== host.scope.tabId ||
    approved.origin !== host.scope.origin ||
    originForUrl(String((approved.target as Record<string, unknown>).currentUrl ?? '')) !==
      host.scope.origin
  ) {
    return { ok: false, error: 'Browser host scope does not match the issued execution.' };
  }

  let captured:
    | Readonly<{
        observation: Awaited<ReturnType<typeof observePage>>;
        resultRef: `jresult_${string}`;
      }>
    | undefined;
  const broker = createNativeCapabilityBroker({
    verifyIssuedRequest: (request, execution) =>
      (execution === input.execution ||
        execution.initialLiveProof === input.execution.initialLiveProof) &&
      request.accountId === input.context.accountId &&
      request.runId === input.context.runId &&
      request.requestId === input.context.requestId &&
      request.attemptNumber === input.context.attemptNumber,
  });
  broker.register({
    id: BROWSER_OPERATOR_CAPABILITY_ID,
    version: input.registration.version,
    kind: 'browser',
    operations: [operation],
    risk: operation === 'browser.readPage' ? 'read-only' : 'external-side-effect',
    approval: operation === 'browser.readPage' ? 'never' : 'always',
    producerKinds: ['action'],
    async execute({ signal }): Promise<NativeCapabilityAdapterResult> {
      captured = await executeFixedHostOperation(host, operation, approved.parameters, signal);
      return { state: 'completed', resultRef: captured.resultRef };
    },
  });
  const request: NativeCapabilityRequest = {
    capabilityId: BROWSER_OPERATOR_CAPABILITY_ID,
    capabilityVersion: input.registration.version,
    kind: 'browser',
    operation,
    accountId: input.context.accountId,
    runId: input.context.runId,
    requestId: input.context.requestId,
    attemptNumber: input.context.attemptNumber,
    workspaceRoot: `vibe-browser:${host.scope.sessionId}:${host.scope.tabId}`,
    parameterHash: input.execution.approval.paramsHash.startsWith('sha256:')
      ? input.execution.approval.paramsHash
      : `sha256:${input.execution.approval.paramsHash}`,
  };
  const brokerExecution =
    request.parameterHash === input.execution.approval.paramsHash
      ? input.execution
      : ({
          approval: Object.freeze({
            ...input.execution.approval,
            paramsHash: request.parameterHash,
          }),
          producerKind: input.execution.producerKind,
          ownerId: input.execution.ownerId,
          startEvent: input.execution.startEvent,
          initialLiveProof: input.execution.initialLiveProof,
          beginExternalEffect: input.execution.beginExternalEffect.bind(input.execution),
          transferTerminalOwnership:
            input.execution.transferTerminalOwnership.bind(input.execution),
          recordResult: input.execution.recordResult.bind(input.execution),
          recordCancellationVerified:
            input.execution.recordCancellationVerified.bind(input.execution),
          requestCancellation: input.execution.requestCancellation.bind(input.execution),
          dispose: input.execution.dispose.bind(input.execution),
        } as unknown as JarvisIssuedActionExecution);

  try {
    if (claimedCanonicalExecutions.has(input.execution as object)) {
      return { ok: false, error: 'Canonical browser execution has already been claimed.' };
    }
    claimedCanonicalExecutions.add(input.execution as object);
    const outcome = await broker.execute(request, brokerExecution);
    if (!captured) throw new Error('Browser result was not captured.');
    const contentReceipt = await evaluateUntrustedContent({
      source: 'browser_dom',
      content: `${captured.observation.title}\n${captured.observation.text}`,
    });
    return {
      ok: true,
      summary:
        operation === 'browser.readPage'
          ? 'Browser page observation recorded.'
          : 'Approved browser operation completed and was observed.',
      data: {
        outcome,
        observation: captured.observation,
        contentReceipt,
        sessionId: host.scope.sessionId,
        tabId: host.scope.tabId,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && /cancel/i.test(error.message)
          ? 'Browser operation was cancelled before verified settlement.'
          : 'Canonical browser operation failed before verified settlement.',
    };
  }
}

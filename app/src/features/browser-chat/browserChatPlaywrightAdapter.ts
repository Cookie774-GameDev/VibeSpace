import type { BrowserActionAuthorization } from '@/lib/jarvis/browserActionApproval';
import {
  assertPlaywrightBrowserAction,
  hashPlaywrightBrowserAction,
  type PlaywrightBrowserAction,
  type PlaywrightBrowserReceipt,
  type PlaywrightBrowserScope,
  type PlaywrightBrowserWorker,
} from '@/lib/jarvis/playwrightBrowserWorker';
import {
  evaluateUntrustedContent,
  type UntrustedContentReceipt,
} from '@/lib/jarvis/untrustedContentPolicy';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import type { BrowserChatCapabilityLease } from './permissionRegistry';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const READ_ACTIONS = new Set<PlaywrightBrowserAction['name']>(['observe', 'screenshot', 'pause']);

export type BrowserChatPlaywrightErrorCode =
  | 'scope_invalid'
  | 'capability_mismatch'
  | 'request_invalid'
  | 'operation_cancelled'
  | 'authority_denied'
  | 'runtime_denied'
  | 'result_invalid';

export class BrowserChatPlaywrightError extends Error {
  constructor(readonly code: BrowserChatPlaywrightErrorCode) {
    super(`Browser Chat Playwright operation rejected: ${code}.`);
    this.name = 'BrowserChatPlaywrightError';
  }
}

type AuthorizedBrowserAction = Readonly<{
  scope: PlaywrightBrowserScope;
  authorization: BrowserActionAuthorization;
}>;

export interface BrowserChatPlaywrightAuthority {
  authorize(
    input: Readonly<{
      accountId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
      action: PlaywrightBrowserAction;
      actionHash: `sha256:${string}`;
      now: number;
      signal: AbortSignal;
    }>,
  ): Promise<AuthorizedBrowserAction | null>;
}

type AdapterOptions = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  approvalBroker: BrowserChatApprovalBroker;
  worker: PlaywrightBrowserWorker;
  authority: BrowserChatPlaywrightAuthority;
}>;

export type BrowserChatPlaywrightPublicReceipt = Readonly<
  Omit<PlaywrightBrowserReceipt, 'url' | 'pageIds' | 'observation'> & {
    url: string;
    pageIds: readonly string[];
    observation?: Readonly<{
      pageId: string;
      url: string;
      bytes: number;
      truncated: boolean;
      contentTrust: UntrustedContentReceipt;
      title?: string;
      text?: string;
    }>;
  }
>;

function validateOptions(options: AdapterOptions): void {
  if (
    !SAFE_ID.test(options.accountId) ||
    !SAFE_ID.test(options.workspaceId) ||
    !SAFE_ID.test(options.projectId)
  ) {
    throw new BrowserChatPlaywrightError('scope_invalid');
  }
}

function begin(
  options: AdapterOptions,
  lease: BrowserChatCapabilityLease,
  capabilityId: 'browser.read' | 'browser.mutate',
  now: number,
) {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatPlaywrightError('capability_mismatch');
  }
  if (lease.accountId !== options.accountId || lease.workspaceId !== options.workspaceId) {
    throw new BrowserChatPlaywrightError('scope_invalid');
  }
  return options.approvalBroker.begin(lease, { now });
}

function validateAuthorized(
  authorized: AuthorizedBrowserAction | null,
  options: AdapterOptions,
  taskId: string,
  actionHash: string,
  now: number,
): asserts authorized is AuthorizedBrowserAction {
  if (!authorized) throw new BrowserChatPlaywrightError('authority_denied');
  const { scope, authorization } = authorized;
  if (
    !scope ||
    scope.accountId !== options.accountId ||
    scope.projectId !== options.projectId ||
    scope.taskId !== taskId ||
    scope.actionHash !== actionHash ||
    scope.now !== now ||
    !SAFE_ID.test(scope.agentId) ||
    !SAFE_ID.test(scope.sessionId) ||
    !SAFE_ID.test(scope.requestId) ||
    typeof scope.purpose !== 'string' ||
    scope.purpose.length < 1 ||
    scope.purpose.length > 1_000 ||
    !Number.isSafeInteger(scope.timeoutMs) ||
    scope.timeoutMs < 1 ||
    scope.timeoutMs > 30_000 ||
    !authorization ||
    authorization.accountId !== options.accountId ||
    authorization.projectId !== options.projectId ||
    authorization.requestId !== scope.requestId ||
    authorization.sessionId !== scope.sessionId ||
    authorization.actionHash !== actionHash
  ) {
    throw new BrowserChatPlaywrightError('authority_denied');
  }
}

function publicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserChatPlaywrightError('result_invalid');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    raw.length > 8_192
  ) {
    throw new BrowserChatPlaywrightError('result_invalid');
  }
  return `${url.origin.toLowerCase()}${url.pathname}`;
}

async function publicReceipt(
  receipt: PlaywrightBrowserReceipt,
): Promise<BrowserChatPlaywrightPublicReceipt> {
  const base = {
    action: receipt.action,
    pageId: receipt.pageId,
    url: publicUrl(receipt.url),
    pageIds: Object.freeze([...receipt.pageIds]),
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    resultRef: receipt.resultRef,
    actionHash: receipt.actionHash,
    authority: receipt.authority,
    untrustedPageContent: receipt.untrustedPageContent,
    ...(receipt.screenshot === undefined
      ? {}
      : { screenshot: Object.freeze({ ...receipt.screenshot }) }),
    ...(receipt.trace === undefined ? {} : { trace: Object.freeze({ ...receipt.trace }) }),
    ...(receipt.download === undefined ? {} : { download: Object.freeze({ ...receipt.download }) }),
    ...(receipt.uploadedArtifactRef === undefined
      ? {}
      : { uploadedArtifactRef: receipt.uploadedArtifactRef }),
  };
  if (!receipt.observation) return Object.freeze(base);
  let contentTrust: UntrustedContentReceipt;
  try {
    contentTrust = await evaluateUntrustedContent({
      source: 'browser_dom',
      content: `${receipt.observation.title}\n${receipt.observation.text}`,
    });
  } catch {
    throw new BrowserChatPlaywrightError('result_invalid');
  }
  const observationBase = {
    pageId: receipt.observation.pageId,
    url: publicUrl(receipt.observation.url),
    bytes: receipt.observation.bytes,
    truncated: receipt.observation.truncated,
    contentTrust,
  };
  return Object.freeze({
    ...base,
    observation: Object.freeze(
      contentTrust.disposition === 'data_only'
        ? {
            ...observationBase,
            title: receipt.observation.title,
            text: receipt.observation.text,
          }
        : observationBase,
    ),
  });
}

export function createBrowserChatPlaywrightAdapter(options: AdapterOptions) {
  validateOptions(options);

  return Object.freeze({
    async execute(input: {
      lease: BrowserChatCapabilityLease;
      taskId: string;
      action: PlaywrightBrowserAction;
      now?: number;
    }) {
      const now = input.now ?? Date.now();
      if (!SAFE_ID.test(input.taskId) || !Number.isSafeInteger(now) || now < 0) {
        throw new BrowserChatPlaywrightError('request_invalid');
      }
      try {
        assertPlaywrightBrowserAction(input.action);
      } catch {
        throw new BrowserChatPlaywrightError('request_invalid');
      }
      const capabilityId = READ_ACTIONS.has(input.action.name) ? 'browser.read' : 'browser.mutate';
      const operation = begin(options, input.lease, capabilityId, now);
      try {
        const actionHash = await hashPlaywrightBrowserAction(input.action);
        if (!HASH.test(actionHash) || operation.signal.aborted) {
          throw new BrowserChatPlaywrightError(
            operation.signal.aborted ? 'operation_cancelled' : 'request_invalid',
          );
        }
        const authorized = await options.authority.authorize({
          accountId: options.accountId,
          workspaceId: options.workspaceId,
          projectId: options.projectId,
          taskId: input.taskId,
          action: input.action,
          actionHash,
          now,
          signal: operation.signal,
        });
        validateAuthorized(authorized, options, input.taskId, actionHash, now);
        const receipt = await options.worker.execute({
          scope: authorized.scope,
          action: input.action,
          authorization: authorized.authorization,
          signal: operation.signal,
        });
        if (operation.signal.aborted || receipt.actionHash !== actionHash) {
          throw new BrowserChatPlaywrightError(
            operation.signal.aborted ? 'operation_cancelled' : 'result_invalid',
          );
        }
        return await publicReceipt(receipt);
      } catch (error) {
        if (error instanceof BrowserChatPlaywrightError) throw error;
        throw new BrowserChatPlaywrightError(
          operation.signal.aborted ? 'operation_cancelled' : 'runtime_denied',
        );
      } finally {
        operation.finish();
      }
    },
  });
}

import type { BrowserContextOptions } from 'playwright-core';
import {
  classifyBrowserAction,
  type BrowserActionAuthorization,
  type BrowserActionKind,
} from './browserActionApproval';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const ARTIFACT_REF = /^jartifact_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const QUARANTINE_REF = /^jquarantine_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const ACTIONS = new Set<PlaywrightBrowserActionName>([
  'observe',
  'navigate',
  'click',
  'fill',
  'select',
  'check',
  'open_tab',
  'switch_tab',
  'close_tab',
  'upload',
  'download',
  'screenshot',
  'trace_start',
  'trace_stop',
  'pause',
]);

export type PlaywrightBrowserActionName =
  | 'observe'
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'open_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'upload'
  | 'download'
  | 'screenshot'
  | 'trace_start'
  | 'trace_stop'
  | 'pause';

export type PlaywrightSemanticTarget =
  | Readonly<{ kind: 'role'; role: string; name: string; exact: boolean }>
  | Readonly<{ kind: 'label'; label: string; exact: boolean }>
  | Readonly<{ kind: 'test_id'; testId: string }>;

export type PlaywrightBrowserAction =
  | Readonly<{ name: 'observe' }>
  | Readonly<{ name: 'navigate'; url: string }>
  | Readonly<{ name: 'click'; target: PlaywrightSemanticTarget }>
  | Readonly<{ name: 'fill'; target: PlaywrightSemanticTarget; value: string }>
  | Readonly<{ name: 'select'; target: PlaywrightSemanticTarget; values: readonly string[] }>
  | Readonly<{ name: 'check'; target: PlaywrightSemanticTarget; checked: boolean }>
  | Readonly<{ name: 'open_tab'; url: string | null }>
  | Readonly<{ name: 'switch_tab'; pageId: string }>
  | Readonly<{ name: 'close_tab'; pageId: string }>
  | Readonly<{ name: 'upload'; target: PlaywrightSemanticTarget; artifactRef: string }>
  | Readonly<{ name: 'download'; target: PlaywrightSemanticTarget }>
  | Readonly<{ name: 'screenshot'; fullPage: boolean }>
  | Readonly<{ name: 'trace_start' }>
  | Readonly<{ name: 'trace_stop' }>
  | Readonly<{ name: 'pause' }>;

export type PlaywrightBrowserLease = Readonly<{
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  taskId: string;
  agentId: string;
  purpose: string;
  sessionId: string;
  contextId: string;
  profileId: string;
  persistentProfile: false;
  browserName: 'chromium' | 'firefox' | 'webkit';
  pageIds: readonly string[];
  activePageId: string;
  allowedOrigins: readonly string[];
  allowedActions: readonly PlaywrightBrowserActionName[];
  authority: Readonly<{
    observe: boolean;
    action: boolean;
    upload: boolean;
    download: boolean;
  }>;
  uploads: readonly Readonly<{
    artifactRef: string;
    sha256: `sha256:${string}`;
    bytes: number;
  }>[];
  maxPages: number;
  issuedAt: number;
  expiresAt: number;
}>;

export type PlaywrightBrowserScope = Readonly<{
  accountId: string;
  projectId: string;
  taskId: string;
  agentId: string;
  purpose: string;
  sessionId: string;
  requestId: string;
  actionHash: `sha256:${string}`;
  now: number;
  timeoutMs: number;
}>;

export type PlaywrightObservation = Readonly<{
  pageId: string;
  url: string;
  title: string;
  text: string;
  bytes: number;
  truncated: boolean;
}>;

export type PlaywrightBinaryArtifact = Readonly<{
  artifactRef: `jartifact_${string}`;
  sha256: `sha256:${string}`;
  bytes: number;
  mimeType: string;
}>;

export type PlaywrightQuarantinedDownload = Readonly<{
  quarantineRef: `jquarantine_${string}`;
  sha256: `sha256:${string}`;
  bytes: number;
  mimeType: string;
  originalName: string;
  scanState: 'pending' | 'clean' | 'blocked';
  availableForUse: boolean;
}>;

export type PlaywrightBrowserHostReceipt = Readonly<{
  action: PlaywrightBrowserActionName;
  pageId: string;
  url: string;
  pageIds: readonly string[];
  startedAt: number;
  finishedAt: number;
  resultRef: `jresult_${string}`;
  observation?: PlaywrightObservation;
  screenshot?: PlaywrightBinaryArtifact;
  trace?: PlaywrightBinaryArtifact;
  download?: PlaywrightQuarantinedDownload;
  uploadedArtifactRef?: string;
}>;

export type PlaywrightBrowserReceipt = PlaywrightBrowserHostReceipt &
  Readonly<{
    actionHash: `sha256:${string}`;
    authority: 'scoped';
    untrustedPageContent: true;
  }>;

export interface PlaywrightIsolatedHostPort {
  resolveLease(
    input: PlaywrightBrowserScope & Readonly<{ signal: AbortSignal }>,
  ): Promise<PlaywrightBrowserLease | null>;
  execute(input: {
    lease: PlaywrightBrowserLease;
    action: PlaywrightBrowserAction;
    contextOptions: Readonly<
      Pick<BrowserContextOptions, 'acceptDownloads' | 'javaScriptEnabled' | 'serviceWorkers'>
    > &
      Readonly<{ storageState: undefined }>;
    signal: AbortSignal;
  }): Promise<PlaywrightBrowserHostReceipt>;
}

export interface PlaywrightBrowserWorker {
  execute(input: {
    scope: PlaywrightBrowserScope;
    action: PlaywrightBrowserAction;
    authorization: BrowserActionAuthorization;
    signal: AbortSignal;
  }): Promise<PlaywrightBrowserReceipt>;
}

function stableText(value: unknown, maximum = 4_096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !CONTROL.test(value)
  );
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function sha256(value: unknown): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalize(value))),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function browserApprovalKind(action: PlaywrightBrowserAction): BrowserActionKind {
  if (action.name === 'observe' || action.name === 'screenshot' || action.name === 'pause') {
    return 'read';
  }
  if (action.name === 'navigate' || action.name === 'open_tab' || action.name === 'switch_tab') {
    return 'navigate';
  }
  if (action.name === 'fill' || action.name === 'select' || action.name === 'check') return 'type';
  if (action.name === 'upload') return 'upload';
  if (action.name === 'download') return 'download';
  return 'click';
}

export async function hashPlaywrightBrowserAction(
  action: PlaywrightBrowserAction,
): Promise<`sha256:${string}`> {
  return sha256(action);
}

export function assertPlaywrightBrowserAction(action: PlaywrightBrowserAction): void {
  validateAction(action);
}

function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid browser URL.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Browser URL is outside the allowed web schemes.');
  }
  return parsed.origin.toLowerCase();
}

function assertTarget(target: PlaywrightSemanticTarget): void {
  if (target.kind === 'role') {
    if (!stableText(target.role, 80) || !stableText(target.name, 500) || typeof target.exact !== 'boolean') {
      throw new Error('Invalid semantic browser target.');
    }
    return;
  }
  if (target.kind === 'label') {
    if (!stableText(target.label, 500) || typeof target.exact !== 'boolean') {
      throw new Error('Invalid semantic browser target.');
    }
    return;
  }
  if (target.kind !== 'test_id' || !stableText(target.testId, 200)) {
    throw new Error('Invalid semantic browser target.');
  }
}

function validateAction(action: PlaywrightBrowserAction): void {
  if (
    typeof action !== 'object' ||
    action === null ||
    !('name' in action) ||
    typeof action.name !== 'string' ||
    !ACTIONS.has(action.name as PlaywrightBrowserActionName)
  ) {
    throw new Error('Unsupported browser action.');
  }
  if (action.name === 'navigate') {
    originOf(action.url);
  } else if (action.name === 'open_tab' && action.url !== null) {
    originOf(action.url);
  }
  if (
    action.name === 'click' ||
    action.name === 'fill' ||
    action.name === 'select' ||
    action.name === 'check' ||
    action.name === 'upload' ||
    action.name === 'download'
  ) {
    assertTarget(action.target);
  }
  if (action.name === 'fill' && (action.value.length > 16_384 || CONTROL.test(action.value))) {
    throw new Error('Browser form value exceeds its bound.');
  }
  if (
    action.name === 'select' &&
    (action.values.length === 0 ||
      action.values.length > 100 ||
      action.values.some((value) => !stableText(value, 1_000)))
  ) {
    throw new Error('Invalid browser select values.');
  }
  if (action.name === 'check' && typeof action.checked !== 'boolean') {
    throw new Error('Invalid browser check state.');
  }
  if ((action.name === 'switch_tab' || action.name === 'close_tab') && !SAFE_ID.test(action.pageId)) {
    throw new Error('Invalid browser page target.');
  }
  if (action.name === 'upload' && !ARTIFACT_REF.test(action.artifactRef)) {
    throw new Error('Browser upload requires an immutable artifact.');
  }
  if (action.name === 'screenshot' && typeof action.fullPage !== 'boolean') {
    throw new Error('Invalid screenshot action.');
  }
}

function assertLease(scope: PlaywrightBrowserScope, lease: PlaywrightBrowserLease): void {
  if (
    lease.schemaVersion !== 1 ||
    lease.accountId !== scope.accountId ||
    lease.projectId !== scope.projectId ||
    lease.taskId !== scope.taskId ||
    lease.agentId !== scope.agentId ||
    lease.purpose !== scope.purpose ||
    lease.sessionId !== scope.sessionId ||
    !SAFE_ID.test(lease.contextId) ||
    !SAFE_ID.test(lease.profileId) ||
    !lease.profileId.startsWith('isolated-') ||
    lease.persistentProfile !== false ||
    !['chromium', 'firefox', 'webkit'].includes(lease.browserName) ||
    !Array.isArray(lease.pageIds) ||
    lease.pageIds.length < 1 ||
    lease.pageIds.length > lease.maxPages ||
    new Set(lease.pageIds).size !== lease.pageIds.length ||
    lease.pageIds.some((pageId) => !SAFE_ID.test(pageId)) ||
    !lease.pageIds.includes(lease.activePageId) ||
    !Array.isArray(lease.allowedOrigins) ||
    lease.allowedOrigins.length < 1 ||
    lease.allowedOrigins.length > 50 ||
    new Set(lease.allowedOrigins.map((origin) => origin.toLowerCase())).size !==
      lease.allowedOrigins.length ||
    lease.allowedOrigins.some((origin) => originOf(origin) !== origin.toLowerCase()) ||
    !Array.isArray(lease.allowedActions) ||
    new Set(lease.allowedActions).size !== lease.allowedActions.length ||
    lease.allowedActions.some((action) => !ACTIONS.has(action)) ||
    typeof lease.authority.observe !== 'boolean' ||
    typeof lease.authority.action !== 'boolean' ||
    typeof lease.authority.upload !== 'boolean' ||
    typeof lease.authority.download !== 'boolean' ||
    !Array.isArray(lease.uploads) ||
    lease.uploads.length > 100 ||
    new Set(lease.uploads.map(({ artifactRef }) => artifactRef)).size !== lease.uploads.length ||
    lease.uploads.some(
      (upload) =>
        !ARTIFACT_REF.test(upload.artifactRef) ||
        !SHA256.test(upload.sha256) ||
        !Number.isSafeInteger(upload.bytes) ||
        upload.bytes < 0 ||
        upload.bytes > 100 * 1024 * 1024,
    ) ||
    !Number.isSafeInteger(lease.maxPages) ||
    lease.maxPages < 1 ||
    lease.maxPages > 20 ||
    !Number.isSafeInteger(lease.issuedAt) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.issuedAt < 0 ||
    lease.expiresAt <= lease.issuedAt ||
    scope.now < lease.issuedAt ||
    scope.now >= lease.expiresAt
  ) {
    throw new Error('Matching isolated browser session lease is required.');
  }
}

function validateReceipt(
  receipt: PlaywrightBrowserHostReceipt,
  action: PlaywrightBrowserAction,
  lease: PlaywrightBrowserLease,
  timeoutMs: number,
): void {
  const samePageSet =
    receipt.pageIds.length === lease.pageIds.length &&
    receipt.pageIds.every((pageId) => lease.pageIds.includes(pageId));
  if (
    receipt.action !== action.name ||
    !SAFE_ID.test(receipt.pageId) ||
    !lease.pageIds.includes(receipt.pageId) &&
      !(action.name === 'open_tab' && receipt.pageIds.includes(receipt.pageId)) ||
    !lease.allowedOrigins.includes(originOf(receipt.url)) ||
    !Array.isArray(receipt.pageIds) ||
    receipt.pageIds.length < 1 ||
    receipt.pageIds.length > lease.maxPages ||
    new Set(receipt.pageIds).size !== receipt.pageIds.length ||
    receipt.pageIds.some((pageId) => !SAFE_ID.test(pageId)) ||
    (action.name === 'open_tab' &&
      (receipt.pageIds.length !== lease.pageIds.length + 1 ||
        lease.pageIds.includes(receipt.pageId) ||
        !lease.pageIds.every((pageId) => receipt.pageIds.includes(pageId)))) ||
    (action.name === 'close_tab' &&
      (receipt.pageIds.length !== lease.pageIds.length - 1 ||
        receipt.pageIds.includes(action.pageId) ||
        !receipt.pageIds.every((pageId) => lease.pageIds.includes(pageId)))) ||
    (action.name !== 'open_tab' && action.name !== 'close_tab' && !samePageSet) ||
    !Number.isSafeInteger(receipt.startedAt) ||
    !Number.isSafeInteger(receipt.finishedAt) ||
    receipt.startedAt < 0 ||
    receipt.finishedAt < receipt.startedAt ||
    receipt.finishedAt - receipt.startedAt > timeoutMs ||
    !RESULT_REF.test(receipt.resultRef)
  ) {
    throw new Error('Playwright host returned invalid canonical evidence.');
  }
  if (receipt.observation) {
    if (
      receipt.observation.pageId !== receipt.pageId ||
      receipt.observation.url !== receipt.url ||
      typeof receipt.observation.title !== 'string' ||
      receipt.observation.title.length > 2_000 ||
      CONTROL.test(receipt.observation.title) ||
      typeof receipt.observation.text !== 'string' ||
      receipt.observation.bytes !== bytes(receipt.observation.text) ||
      receipt.observation.bytes > MAX_OBSERVATION_BYTES ||
      typeof receipt.observation.truncated !== 'boolean'
    ) {
      throw new Error('Playwright observation exceeded its canonical bound.');
    }
  }
  for (const [artifact, maximum, expectedMime] of [
    [receipt.screenshot, MAX_SCREENSHOT_BYTES, 'image/png'],
    [receipt.trace, MAX_TRACE_BYTES, 'application/zip'],
  ] as const) {
    if (
      artifact &&
      (!ARTIFACT_REF.test(artifact.artifactRef) ||
        !SHA256.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 1 ||
        artifact.bytes > maximum ||
        artifact.mimeType !== expectedMime)
    ) {
      throw new Error('Playwright binary artifact exceeded its canonical bound.');
    }
  }
  if (receipt.download) {
    const download = receipt.download;
    if (
      action.name !== 'download' ||
      !QUARANTINE_REF.test(download.quarantineRef) ||
      !SHA256.test(download.sha256) ||
      !Number.isSafeInteger(download.bytes) ||
      download.bytes < 0 ||
      download.bytes > 100 * 1024 * 1024 ||
      !stableText(download.mimeType, 200) ||
      !stableText(download.originalName, 255) ||
      /[\\/]/u.test(download.originalName) ||
      download.originalName === '.' ||
      download.originalName === '..' ||
      download.originalName.endsWith('.') ||
      download.originalName.endsWith(' ') ||
      !['pending', 'clean', 'blocked'].includes(download.scanState) ||
      download.availableForUse !== (download.scanState === 'clean')
    ) {
      throw new Error('Browser download was not safely quarantined.');
    }
  }
  if (
    action.name === 'upload' &&
    receipt.uploadedArtifactRef !== action.artifactRef
  ) {
    throw new Error('Browser host uploaded a different artifact.');
  }
  if (
    (action.name === 'observe' && !receipt.observation) ||
    (action.name === 'screenshot' && !receipt.screenshot) ||
    (action.name === 'trace_stop' && !receipt.trace) ||
    (action.name === 'download' && !receipt.download)
  ) {
    throw new Error('Playwright host omitted required canonical evidence.');
  }
}

function requiredAuthority(action: PlaywrightBrowserActionName): keyof PlaywrightBrowserLease['authority'] {
  if (action === 'observe' || action === 'screenshot' || action.startsWith('trace')) return 'observe';
  if (action === 'upload') return 'upload';
  if (action === 'download') return 'download';
  return 'action';
}

function immutableLease(lease: PlaywrightBrowserLease): PlaywrightBrowserLease {
  return Object.freeze({
    ...lease,
    pageIds: Object.freeze([...lease.pageIds]),
    allowedOrigins: Object.freeze([...lease.allowedOrigins]),
    allowedActions: Object.freeze([...lease.allowedActions]),
    authority: Object.freeze({ ...lease.authority }),
    uploads: Object.freeze(lease.uploads.map((upload) => Object.freeze({ ...upload }))),
  });
}

function immutableAction(action: PlaywrightBrowserAction): PlaywrightBrowserAction {
  if (action.name === 'select') {
    return Object.freeze({
      ...action,
      target: Object.freeze({ ...action.target }),
      values: Object.freeze([...action.values]),
    });
  }
  if (
    action.name === 'click' ||
    action.name === 'fill' ||
    action.name === 'check' ||
    action.name === 'upload' ||
    action.name === 'download'
  ) {
    return Object.freeze({ ...action, target: Object.freeze({ ...action.target }) });
  }
  return Object.freeze({ ...action });
}

function immutableReceipt(
  receipt: PlaywrightBrowserHostReceipt,
  actionHash: `sha256:${string}`,
): PlaywrightBrowserReceipt {
  return Object.freeze({
    ...receipt,
    pageIds: Object.freeze([...receipt.pageIds]),
    ...(receipt.observation
      ? { observation: Object.freeze({ ...receipt.observation }) }
      : {}),
    ...(receipt.screenshot ? { screenshot: Object.freeze({ ...receipt.screenshot }) } : {}),
    ...(receipt.trace ? { trace: Object.freeze({ ...receipt.trace }) } : {}),
    ...(receipt.download ? { download: Object.freeze({ ...receipt.download }) } : {}),
    actionHash,
    authority: 'scoped',
    untrustedPageContent: true,
  });
}

async function executeBounded(
  port: PlaywrightIsolatedHostPort,
  input: Omit<Parameters<PlaywrightIsolatedHostPort['execute']>[0], 'signal'>,
  outerSignal: AbortSignal,
  timeoutMs: number,
): Promise<PlaywrightBrowserHostReceipt> {
  if (outerSignal.aborted) throw new Error('Browser action was cancelled before execution.');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  outerSignal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let rejectAborted: ((reason: Error) => void) | undefined;
  const onAborted = () => {
    rejectAborted?.(
      new Error(
        timedOut
          ? 'Browser action exceeded its execution timeout.'
          : 'Browser action was cancelled before settlement.',
      ),
    );
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
    controller.signal.addEventListener('abort', onAborted, { once: true });
  });
  try {
    return await Promise.race([
      port.execute({ ...input, signal: controller.signal }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAborted);
  }
}

export function createPlaywrightBrowserWorker(
  port: PlaywrightIsolatedHostPort,
): PlaywrightBrowserWorker {
  const claimedRequests = new Set<string>();
  return Object.freeze<PlaywrightBrowserWorker>({
    async execute(input) {
      const scope = Object.freeze({ ...input.scope });
      const authorization = Object.freeze({
        ...input.authorization,
        classification: Object.freeze({ ...input.authorization.classification }),
      });
      const { signal } = input;
      validateAction(input.action);
      const action = immutableAction(input.action);
      if (
        !SAFE_ID.test(scope.accountId) ||
        !SAFE_ID.test(scope.projectId) ||
        !SAFE_ID.test(scope.taskId) ||
        !SAFE_ID.test(scope.agentId) ||
        !stableText(scope.purpose, 1_000) ||
        !SAFE_ID.test(scope.sessionId) ||
        !SAFE_ID.test(scope.requestId) ||
        !SHA256.test(scope.actionHash) ||
        !Number.isSafeInteger(scope.now) ||
        scope.now < 0 ||
        !Number.isSafeInteger(scope.timeoutMs) ||
        scope.timeoutMs < 1 ||
        scope.timeoutMs > 30_000
      ) {
        throw new Error('Invalid isolated browser execution scope.');
      }
      const actionHash = await hashPlaywrightBrowserAction(action);
      const approvalKind = browserApprovalKind(action);
      const classification = classifyBrowserAction(approvalKind);
      if (
        actionHash !== scope.actionHash ||
        authorization.accountId !== scope.accountId ||
        authorization.projectId !== scope.projectId ||
        authorization.sessionId !== scope.sessionId ||
        authorization.requestId !== scope.requestId ||
        authorization.actionHash !== scope.actionHash ||
        authorization.action !== approvalKind ||
        authorization.authority !== 'scoped' ||
        authorization.classification.risk !== classification.risk ||
        authorization.classification.approval !== classification.approval ||
        (classification.approval === 'explicit') !== Boolean(authorization.grantId) ||
        (authorization.grantId !== undefined && !SAFE_ID.test(authorization.grantId))
      ) {
        throw new Error('Matching browser action authorization is required.');
      }
      const claimKey = `${scope.accountId}\u0000${scope.projectId}\u0000${scope.sessionId}\u0000${scope.requestId}`;
      if (claimedRequests.has(claimKey)) throw new Error('Browser action request was already claimed.');
      claimedRequests.add(claimKey);
      if (signal.aborted) throw new Error('Browser action was cancelled before execution.');
      const resolvedLease = await port.resolveLease(Object.freeze({ ...scope, signal }));
      if (signal.aborted) throw new Error('Browser action was cancelled before execution.');
      if (!resolvedLease) throw new Error('Matching isolated browser session lease is required.');
      assertLease(scope, resolvedLease);
      const lease = immutableLease(resolvedLease);
      if (
        !lease.allowedActions.includes(action.name) ||
        !lease.authority[requiredAuthority(action.name)]
      ) {
        throw new Error('Browser session lease does not allow this action.');
      }
      if (action.name === 'navigate') {
        if (!lease.allowedOrigins.includes(originOf(action.url))) {
          throw new Error('Browser navigation origin is outside the session lease.');
        }
      } else if (
        action.name === 'open_tab' &&
        action.url !== null &&
        !lease.allowedOrigins.includes(originOf(action.url))
      ) {
        throw new Error('Browser navigation origin is outside the session lease.');
      }
      if (
        (action.name === 'switch_tab' || action.name === 'close_tab') &&
        !lease.pageIds.includes(action.pageId)
      ) {
        throw new Error('Browser page is outside the session lease.');
      }
      if (
        action.name === 'open_tab' &&
        lease.pageIds.length >= lease.maxPages
      ) {
        throw new Error('Browser session page limit is exhausted.');
      }
      if (
        action.name === 'upload' &&
        !lease.uploads.some(({ artifactRef }) => artifactRef === action.artifactRef)
      ) {
        throw new Error('Browser upload artifact is outside the session lease.');
      }
      const receipt = await executeBounded(
        port,
        {
          lease,
          action,
          contextOptions: Object.freeze({
            acceptDownloads: action.name === 'download' && lease.authority.download,
            javaScriptEnabled: true,
            serviceWorkers: 'block',
            storageState: undefined,
          }),
        },
        signal,
        scope.timeoutMs,
      );
      if (signal.aborted) throw new Error('Browser action was cancelled before settlement.');
      validateReceipt(receipt, action, lease, scope.timeoutMs);
      return immutableReceipt(receipt, actionHash);
    },
  });
}

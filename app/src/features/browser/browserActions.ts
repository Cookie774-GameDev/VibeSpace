import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { hashJarvisText, isProtectedJarvisAgent } from '@/lib/jarvis/identity';
import type { CdpSession } from './browserClient';
import { useBrowserStore } from './browserStore';
import type {
  BrowserActionRequester,
  BrowserActionRisk,
  BrowserActionTarget,
  BrowserJsonObject,
  BrowserJsonValue,
  BrowserReviewedAction,
} from './browserTypes';
import type { BrowserCanonicalApprovalAuthority } from './browserCanonicalApprovalRuntime';

export interface BrowserToolRequest {
  tool: string;
  params?: BrowserJsonObject;
  summary?: string;
  requester?: BrowserActionRequester;
}

export interface BrowserToolResult {
  ok: boolean;
  tool: string;
  message: string;
  data?: unknown;
}

export const BROWSER_ACTION_VERSION = 1;
export const BROWSER_REVIEW_TTL_MS = 5 * 60_000;
const SAFE_CANONICAL_REVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;

export type BrowserReviewContext = {
  accountId: string;
  origin: string;
  tabId: string;
  frameId?: string;
  target: BrowserActionTarget;
  now: number;
};

export type BrowserReviewValidation =
  | { ok: true; action: BrowserReviewedAction }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'not_pending'
        | 'account_mismatch'
        | 'expired'
        | 'hash_mismatch'
        | 'action_changed'
        | 'origin_changed'
        | 'tab_changed'
        | 'frame_changed'
        | 'target_changed'
        | 'risk_changed';
    };

const UNAVAILABLE_MESSAGE =
  'Browser Operator execution is unavailable until canonical approval is active.';

const ALLOWED_TOOLS = new Set([
  'browser.open',
  'browser.newTab',
  'browser.closeTab',
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.wait',
  'browser.inspect',
  'browser.readPage',
  'browser.findText',
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.select',
  'browser.check',
  'browser.uncheck',
  'browser.upload',
  'browser.download',
  'browser.scroll',
  'browser.screenshot',
  'browser.getConsoleErrors',
  'browser.getCurrentUrl',
  'browser.listTabs',
  'browser.switchTab',
  'browser.submit',
  'browser.delete',
  'browser.purchase',
  'browser.pay',
  'browser.login',
  'browser.signIn',
  'browser.checkout',
  'browser.stop',
]);

const CONFIRM_TOOLS = new Set([
  'browser.open',
  'browser.click',
  'browser.type',
  'browser.press',
  'browser.select',
  'browser.check',
  'browser.uncheck',
  'browser.upload',
  'browser.download',
  'browser.navigate',
]);

const DANGEROUS_TOOLS = new Set([
  'browser.submit',
  'browser.delete',
  'browser.purchase',
  'browser.pay',
  'browser.login',
  'browser.signIn',
  'browser.checkout',
]);

const DANGEROUS_HINTS = [
  'submit',
  'delete',
  'purchase',
  'pay',
  'password',
  'login',
  'sign-in',
  'sign in',
  'signin',
  'checkout',
];

const PROTECTED_PARAMETER_KEYS = new Set([
  'password',
  'passphrase',
  'cookie',
  'setcookie',
  'authorization',
  'authorizationheader',
  'authheader',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'token',
  'clientsecret',
  'privatekey',
  'recoverycode',
  'recoveryphrase',
  'seedphrase',
  'mnemonic',
  'credentialhandle',
  'credentialhandleid',
  'secrethandle',
  'secrethandleid',
]);

function canonicalizeValue(value: unknown, active: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Browser parameters require finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError('Browser parameters must be JSON-safe.');
  }
  if (active.has(value)) throw new TypeError('Browser parameters cannot contain cycles.');

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const indexes: number[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) {
          throw new TypeError('Browser parameter arrays require only indexed values.');
        }
        const index = Number(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !Number.isSafeInteger(index) ||
          index >= value.length ||
          !descriptor?.enumerable ||
          !('value' in descriptor)
        ) {
          throw new TypeError('Browser parameter arrays require plain indexed values.');
        }
        indexes.push(index);
      }
      if (indexes.length !== value.length) {
        throw new TypeError('Browser parameter arrays cannot contain sparse holes.');
      }
      return `[${indexes
        .sort((left, right) => left - right)
        .map((index) => canonicalizeValue(value[index], active))
        .join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Browser parameters require plain objects.');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Browser parameters require string keys.');
    }
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('Browser parameters require enumerable data properties.');
      }
    }
    const object = value as Record<string, unknown>;
    return `{${(ownKeys as string[])
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(object[key], active)}`)
      .join(',')}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalizeBrowserJson(value: BrowserJsonValue): string {
  return canonicalizeValue(value, new Set());
}

function normalizeParameters(parameters: BrowserJsonObject | undefined): BrowserJsonObject {
  const canonical = canonicalizeBrowserJson(parameters ?? {});
  const parsed: unknown = JSON.parse(canonical);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new TypeError('Browser parameters must be an object.');
  }
  return parsed as BrowserJsonObject;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRequester(requester: BrowserActionRequester): BrowserActionRequester {
  const id = String(requester.agent.id).trim();
  const slug = requester.agent.slug.trim();
  if (requester.kind !== 'agent' || !id || !slug) {
    throw new TypeError('A complete browser requester snapshot is required.');
  }
  const runId = normalizeOptionalText(requester.runId);
  return {
    kind: 'agent',
    agent: {
      id: id as BrowserActionRequester['agent']['id'],
      slug,
      builtin: requester.agent.builtin === true,
    },
    ...(runId ? { runId } : {}),
  };
}

function normalizedRequesterForHash(requester: BrowserActionRequester) {
  return {
    kind: 'agent' as const,
    agent: {
      id: String(requester.agent.id),
      slug: requester.agent.slug,
      builtin: requester.agent.builtin === true,
    },
    runId: requester.runId ?? null,
  };
}

function normalizedTargetForHash(target: BrowserActionTarget) {
  return {
    currentUrl: target.currentUrl,
    requestedUrl: target.requestedUrl ?? null,
    selector: target.selector ?? null,
    coordinates: target.coordinates ? { x: target.coordinates.x, y: target.coordinates.y } : null,
  };
}

function normalizedFrameId(frameId: string | undefined): string | null {
  return frameId ?? null;
}

function protectedParameterKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (PROTECTED_PARAMETER_KEYS.has(normalized)) return true;
  return [
    'password',
    'passphrase',
    'cookie',
    'authorization',
    'apikey',
    'token',
    'clientsecret',
    'privatekey',
    'recoverycode',
    'recoveryphrase',
    'seedphrase',
    'mnemonic',
    'credentialhandle',
    'secrethandle',
  ].some((stem) => normalized.includes(stem));
}

function protectedParameterValue(value: string): boolean {
  return (
    /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value) ||
    /\b(?:bearer|basic)\s+[a-z0-9+/._=-]{8,}\b/i.test(value) ||
    /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/.test(value) ||
    /\b(?:sk|pk|api)[-_][a-z0-9_-]{16,}\b/i.test(value) ||
    /(?:password|cookie|authorization|api[_ -]?key|access[_ -]?token|client[_ -]?secret|recovery[_ -]?code)\s*[:=]/i.test(
      value,
    )
  );
}

function containsProtectedParameters(value: BrowserJsonValue): boolean {
  if (typeof value === 'string') return protectedParameterValue(value);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsProtectedParameters);
  for (const [key, nested] of Object.entries(value)) {
    if (protectedParameterKey(key)) return true;
    if (key.toLowerCase() === 'secret' && nested === true) return true;
    if (containsProtectedParameters(nested)) return true;
  }
  return false;
}

export function classifyRisk(tool: string, parameters?: BrowserJsonObject): BrowserActionRisk {
  if (DANGEROUS_TOOLS.has(tool)) return 'dangerous';
  const parameterText = parameters ? canonicalizeBrowserJson(parameters).toLowerCase() : '';
  if (DANGEROUS_HINTS.some((hint) => parameterText.includes(hint))) return 'dangerous';
  if (CONFIRM_TOOLS.has(tool)) return 'confirm';
  return 'safe';
}

export function validateBrowserTool(req: BrowserToolRequest): BrowserToolResult | null {
  if (!ALLOWED_TOOLS.has(req.tool)) {
    return {
      ok: false,
      tool: req.tool,
      message: 'Unknown or disallowed browser tool.',
    };
  }
  if (req.tool === 'browser.evaluate' || req.tool === 'browser.runJs') {
    return { ok: false, tool: req.tool, message: 'Arbitrary JavaScript is not allowed.' };
  }
  return null;
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

function targetForRequest(currentUrl: string, parameters: BrowserJsonObject): BrowserActionTarget {
  const requestedUrl = normalizeOptionalText(parameters.url);
  const selector = normalizeOptionalText(parameters.selector);
  const x = typeof parameters.x === 'number' && Number.isFinite(parameters.x) ? parameters.x : null;
  const y = typeof parameters.y === 'number' && Number.isFinite(parameters.y) ? parameters.y : null;
  return {
    currentUrl,
    ...(requestedUrl ? { requestedUrl } : {}),
    ...(selector ? { selector } : {}),
    ...(x !== null && y !== null ? { coordinates: { x, y } } : {}),
  };
}

function expectedEffectFor(tool: string): string {
  if (tool === 'browser.navigate' || tool === 'browser.open')
    return 'Navigate the active browser tab.';
  if (tool === 'browser.click') return 'Interact with the selected page control.';
  if (tool === 'browser.type') return 'Enter non-secret text in the active page.';
  if (tool === 'browser.readPage' || tool === 'browser.inspect') return 'Inspect the active page.';
  return 'Perform the reviewed browser operation.';
}

function safeSummaryFor(
  requester: BrowserActionRequester,
  tool: string,
  risk: BrowserActionRisk,
): string {
  const actor = isProtectedJarvisAgent(requester.agent) ? 'JARVIS' : 'Agent';
  const operation = tool.startsWith('browser.') ? tool.slice('browser.'.length) : 'operation';
  return `${actor} requested browser ${operation}; ${risk} review required.`;
}

function reviewPayload(
  action: Omit<
    BrowserReviewedAction,
    'id' | 'parametersHash' | 'reviewedHash' | 'safeSummary' | 'status' | 'requestedAt' | 'result'
  >,
) {
  return {
    accountId: action.accountId,
    requester: normalizedRequesterForHash(action.requester),
    kind: action.kind,
    actionVersion: action.actionVersion,
    origin: action.origin,
    tabId: action.tabId,
    frameId: normalizedFrameId(action.frameId),
    target: normalizedTargetForHash(action.target),
    parameters: action.parameters,
    expectedEffect: action.expectedEffect,
    risk: action.risk,
    expiresAt: action.expiresAt,
  };
}

async function reviewedHashFor(
  action: Omit<
    BrowserReviewedAction,
    'id' | 'parametersHash' | 'reviewedHash' | 'safeSummary' | 'status' | 'requestedAt' | 'result'
  >,
): Promise<string> {
  return hashJarvisText(canonicalizeBrowserJson(reviewPayload(action)));
}

function unavailableResult(
  tool: string,
  data: Record<string, BrowserJsonValue> = {},
): BrowserToolResult {
  return {
    ok: false,
    tool,
    message: UNAVAILABLE_MESSAGE,
    data: { status: 'unavailable', ...data },
  };
}

export async function requestBrowserTool(
  req: BrowserToolRequest,
  cdp: CdpSession | null,
  canonicalAuthority?: BrowserCanonicalApprovalAuthority,
): Promise<BrowserToolResult> {
  void cdp;
  const invalid = validateBrowserTool(req);
  if (invalid) return invalid;

  const store = useBrowserStore.getState();
  if (req.tool === 'browser.stop') {
    store.abortAgentActions();
    return { ok: true, tool: req.tool, message: 'Agent control stopped.' };
  }

  const tab = store.activeTab();
  if (tab?.controlMode === 'user_only') {
    return {
      ok: false,
      tool: req.tool,
      message: 'Tab is user-only. Programmatic browser actions are disabled.',
      data: { status: 'unavailable' },
    };
  }

  const identity = getActiveAccountIdentity();
  if (!identity || !tab || !req.requester) return unavailableResult(req.tool);

  let parameters: BrowserJsonObject;
  let requester: BrowserActionRequester;
  try {
    parameters = normalizeParameters(req.params);
    requester = normalizeRequester(req.requester);
  } catch {
    return unavailableResult(req.tool);
  }

  if (containsProtectedParameters(parameters)) {
    return {
      ok: false,
      tool: req.tool,
      message: 'Browser Operator request contains protected parameters.',
      data: { status: 'unavailable' },
    };
  }

  const risk = classifyRisk(req.tool, parameters);
  const requestedAt = Date.now();
  const frameId = normalizeOptionalText(parameters.frameId);
  const canonicalReviewId = canonicalAuthority?.parent.context.callId;
  if (
    canonicalAuthority &&
    (typeof canonicalReviewId !== 'string' ||
      !SAFE_CANONICAL_REVIEW_ID.test(canonicalReviewId) ||
      store.agentActions.some((candidate) => candidate.id === canonicalReviewId))
  ) {
    return unavailableResult(req.tool, { reason: 'canonical_parent_identity_invalid' });
  }
  const base = {
    accountId: identity.accountId,
    requester,
    kind: req.tool,
    actionVersion: BROWSER_ACTION_VERSION,
    origin: originForUrl(tab.url),
    tabId: tab.id,
    ...(frameId ? { frameId } : {}),
    target: targetForRequest(tab.url, parameters),
    parameters,
    expectedEffect: expectedEffectFor(req.tool),
    risk,
    expiresAt: requestedAt + BROWSER_REVIEW_TTL_MS,
  } satisfies Omit<
    BrowserReviewedAction,
    'id' | 'parametersHash' | 'reviewedHash' | 'safeSummary' | 'status' | 'requestedAt' | 'result'
  >;
  const action: BrowserReviewedAction = {
    id: canonicalReviewId ?? `browser-action-${crypto.randomUUID()}`,
    ...base,
    parametersHash: await hashJarvisText(canonicalizeBrowserJson(parameters)),
    reviewedHash: await reviewedHashFor(base),
    safeSummary: safeSummaryFor(requester, req.tool, risk),
    status: 'pending',
    requestedAt,
  };
  store.enqueueAgentAction(action);
  if (canonicalAuthority) {
    try {
      const { registerBrowserCanonicalApprovalAuthority } = await import(
        './browserCanonicalApprovalRuntime'
      );
      registerBrowserCanonicalApprovalAuthority(action.id, canonicalAuthority);
    } catch {
      store.resolveAgentAction(action.id, 'unavailable', UNAVAILABLE_MESSAGE);
      return unavailableResult(req.tool, {
        actionId: action.id,
        reason: 'canonical_authority_rejected',
      });
    }
  }

  return unavailableResult(req.tool, { actionId: action.id, risk });
}

function browserJsonEqual(left: BrowserJsonValue, right: BrowserJsonValue): boolean {
  try {
    return canonicalizeBrowserJson(left) === canonicalizeBrowserJson(right);
  } catch {
    return false;
  }
}

export async function validateBrowserReviewedAction(
  action: BrowserReviewedAction | undefined,
  request: BrowserToolRequest,
  context: BrowserReviewContext,
): Promise<BrowserReviewValidation> {
  if (!action) return { ok: false, reason: 'not_found' };
  if (action.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const activeIdentity = getActiveAccountIdentity();
  if (
    !activeIdentity ||
    action.accountId !== activeIdentity.accountId ||
    action.accountId !== context.accountId
  ) {
    return { ok: false, reason: 'account_mismatch' };
  }
  if (context.now >= action.expiresAt) return { ok: false, reason: 'expired' };

  let requestParameters: BrowserJsonObject;
  let requestRequester: BrowserActionRequester;
  try {
    requestParameters = normalizeParameters(request.params);
    if (!request.requester) return { ok: false, reason: 'action_changed' };
    requestRequester = normalizeRequester(request.requester);
  } catch {
    return { ok: false, reason: 'hash_mismatch' };
  }

  if (
    request.tool !== action.kind ||
    action.actionVersion !== BROWSER_ACTION_VERSION ||
    expectedEffectFor(action.kind) !== action.expectedEffect ||
    !browserJsonEqual(
      normalizedRequesterForHash(requestRequester),
      normalizedRequesterForHash(action.requester),
    ) ||
    isProtectedJarvisAgent(requestRequester.agent) !==
      isProtectedJarvisAgent(action.requester.agent)
  ) {
    return { ok: false, reason: 'action_changed' };
  }
  if (context.origin !== action.origin) return { ok: false, reason: 'origin_changed' };
  if (context.tabId !== action.tabId) return { ok: false, reason: 'tab_changed' };
  if (normalizedFrameId(context.frameId) !== normalizedFrameId(action.frameId)) {
    return { ok: false, reason: 'frame_changed' };
  }
  if (
    !browserJsonEqual(
      normalizedTargetForHash(context.target),
      normalizedTargetForHash(action.target),
    )
  ) {
    return { ok: false, reason: 'target_changed' };
  }

  const derivedRisk = classifyRisk(request.tool, requestParameters);
  if (derivedRisk !== action.risk) return { ok: false, reason: 'risk_changed' };
  if (safeSummaryFor(action.requester, action.kind, action.risk) !== action.safeSummary) {
    return { ok: false, reason: 'action_changed' };
  }

  try {
    const requestParametersHash = await hashJarvisText(canonicalizeBrowserJson(requestParameters));
    const storedParametersHash = await hashJarvisText(canonicalizeBrowserJson(action.parameters));
    if (
      requestParametersHash !== action.parametersHash ||
      storedParametersHash !== action.parametersHash ||
      !browserJsonEqual(requestParameters, action.parameters)
    ) {
      return { ok: false, reason: 'hash_mismatch' };
    }
    const reviewedHash = await reviewedHashFor(action);
    if (reviewedHash !== action.reviewedHash) return { ok: false, reason: 'hash_mismatch' };
  } catch {
    return { ok: false, reason: 'hash_mismatch' };
  }

  return { ok: true, action };
}

export async function consumeBrowserReviewedAction(
  actionId: string,
  cdp: CdpSession | null,
): Promise<BrowserToolResult> {
  void cdp;
  const store = useBrowserStore.getState();
  const action = store.agentActions.find((candidate) => candidate.id === actionId);
  if (!action) {
    return unavailableResult('browser.unknown', { actionId, reason: 'not_found' });
  }

  const tab = store.activeTab();
  const identity = getActiveAccountIdentity();
  const currentUrl = tab?.url ?? '';
  const validation = await validateBrowserReviewedAction(
    action,
    {
      tool: action.kind,
      params: action.parameters,
      requester: action.requester,
    },
    {
      accountId: identity?.accountId ?? '',
      origin: originForUrl(currentUrl),
      tabId: tab?.id ?? '',
      frameId: undefined,
      target: { currentUrl },
      now: Date.now(),
    },
  );

  if (!validation.ok) {
    if (validation.reason === 'expired') {
      store.resolveAgentAction(action.id, 'expired', 'Browser Operator review expired.');
    } else if (validation.reason !== 'not_pending') {
      store.resolveAgentAction(action.id, 'unavailable', UNAVAILABLE_MESSAGE);
    }
    return unavailableResult(action.kind, {
      actionId: action.id,
      reason: validation.reason,
    });
  }

  store.resolveAgentAction(action.id, 'unavailable', UNAVAILABLE_MESSAGE);
  return {
    ok: false,
    tool: action.kind,
    message: UNAVAILABLE_MESSAGE,
    data: { status: 'unavailable', actionId: action.id },
  };
}

/** Compatibility export quarantined until Task 16B/19D mounts the canonical adapter. */
export async function executeBrowserTool(
  req: BrowserToolRequest,
  cdp: CdpSession | null,
): Promise<BrowserToolResult> {
  void cdp;
  return unavailableResult(req.tool);
}

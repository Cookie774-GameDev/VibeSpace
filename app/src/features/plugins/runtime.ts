import { nativeFetch } from '@/lib/nativeFetch';
import {
  isRegisteredPluginToolExecutor,
  type JarvisRegisteredActionExecutor,
} from '@/lib/jarvis/actions/catalog';
import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import { getPluginManifest } from './catalog';
import type { ExistingPluginCredentialAdapter } from './credentials';
import {
  withPluginCredentialLocatorLocks,
  type ExistingPluginCredentialLocator,
  type JarvisExistingCredentialAuthorization,
  type JarvisExistingCredentialAuthorizationAuthority,
  type PluginCredentialAccountGrantRepository,
  type PluginCredentialAccountGrantV1,
  type PluginCredentialLocatorLockSet,
} from './credentialAuthorization';
import type { PluginStore } from './store';
import type { PluginHttpTest, PluginManifest, PluginTestResult } from './types';
import { isConnectableStatus } from './types';
import { PLUGIN_CONNECTION_ADAPTERS } from './connectionFramework';
import { gmailArtifactDrafts, runGmailTool, testGmailConnection } from './gmailProvider';
import {
  googleDriveArtifactDrafts,
  runGoogleDriveTool,
  testGoogleDriveConnection,
} from './googleDriveProvider';
import {
  canvaArtifactDrafts,
  runCanvaTool,
  testCanvaConnection,
  type CanvaCredentialRotation,
} from './canvaProvider';
import { runZapierTool, testZapierConnection, type ZapierGatewayFactory } from './zapierProvider';
import type {
  CanonicalPluginEvidence,
  CanonicalPluginEvidenceAuthority,
} from '@/lib/jarvis/artifactProducerAdapters';
import type { JarvisArtifactDraft } from '@/lib/jarvis/contracts';

type CredentialMap = Record<string, string>;

export type PluginAuthorizationStartResult =
  | Readonly<{
      ok: true;
      state: 'awaiting_approval' | 'connected';
      authorizationUrl?: string;
      userCode?: string;
      accountLabel?: string;
    }>
  | Readonly<{
      ok: false;
      error: string;
      setupUrl?: string;
    }>;

/**
 * Trusted provider boundary. Implementations own PKCE/device secrets and
 * secure grant storage; the renderer receives only a token-free receipt.
 */
export interface PluginAuthorizationAuthority {
  begin(input: {
    accountId: string;
    pluginId: string;
    path: 'native_oauth_pkce' | 'hosted_oauth' | 'device_authorization' | 'app_installation';
    scopes: readonly string[];
  }): Promise<PluginAuthorizationStartResult>;
  cancel(input: { accountId: string; pluginId: string }): Promise<void>;
}

export interface PluginManagementCapability {
  beginAuthorization(input: {
    accountId: string;
    pluginId: string;
  }): Promise<PluginAuthorizationStartResult>;
  cancelAuthorization(input: { accountId: string; pluginId: string }): Promise<void>;
  saveCredential(input: {
    accountId: string;
    pluginId: string;
    fieldId: string;
    value: string;
  }): Promise<void>;
  testConnection(input: { accountId: string; pluginId: string }): Promise<PluginTestResult>;
  disconnect(input: { accountId: string; pluginId: string }): Promise<void>;
}

/** @internal Closed inside the trusted JARVIS security composition. */
export interface RegisteredPluginToolExecutor {
  execute(input: {
    accountId: string;
    registration: Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
  }): Promise<ActionResult>;
}

/** @internal Trusted execution surface used only after approval-bound handles resolve. */
export interface PreparedRegisteredPluginToolExecutor extends RegisteredPluginToolExecutor {
  startPrepared(input: {
    accountId: string;
    registration: Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
    credentialValues: Readonly<Record<string, string>>;
    credentialAuthorizations: readonly JarvisExistingCredentialAuthorization[];
  }): Promise<ActionResult>;
}

type CanonicalPluginRegistration = Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }>;

export interface CanonicalPluginArtifactCapability {
  readonly authority: CanonicalPluginEvidenceAuthority;
  consumeCanonicalResult(input: {
    evidence: CanonicalPluginEvidence;
    registration: CanonicalPluginRegistration;
    result: Extract<ActionResult, { ok: true }>;
  }): Promise<readonly JarvisArtifactDraft[] | null>;
  invalidateAccount(accountId: string): void;
  invalidateAll(): void;
}

export interface CanonicalPluginArtifactResultReadPort {
  readCanonicalPluginResult(evidence: CanonicalPluginEvidence): Promise<Readonly<{
    evidence: CanonicalPluginEvidence;
    registration: CanonicalPluginRegistration;
    executor: RegisteredPluginToolExecutor;
  }> | null>;
}

export interface CanonicalPluginArtifactGrantAuthority {
  revalidateCanonicalPluginGrant(input: {
    evidence: CanonicalPluginEvidence;
    registration: CanonicalPluginRegistration;
  }): Promise<boolean>;
}

const canonicalRegisteredPluginExecutors = new WeakSet<object>();

function validPluginEvidence(evidence: CanonicalPluginEvidence): boolean {
  const stable = (value: string) =>
    value.length > 0 && value.trim() === value && !value.includes('\u0000');
  return (
    Object.isFrozen(evidence) &&
    evidence.producerId === 'plugin_result' &&
    (evidence.state === 'succeeded' || evidence.state === 'partial') &&
    Number.isSafeInteger(evidence.attemptNumber) &&
    evidence.attemptNumber > 0 &&
    Number.isSafeInteger(evidence.verifiedAt) &&
    evidence.verifiedAt >= 0 &&
    stable(evidence.accountId) &&
    stable(evidence.runId) &&
    stable(evidence.requestId) &&
    stable(evidence.resultRef) &&
    stable(evidence.pluginId) &&
    stable(evidence.invocationId)
  );
}

function samePluginEvidence(
  left: CanonicalPluginEvidence,
  right: CanonicalPluginEvidence,
): boolean {
  return (
    left.producerId === right.producerId &&
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.attemptNumber === right.attemptNumber &&
    left.resultRef === right.resultRef &&
    left.state === right.state &&
    left.verifiedAt === right.verifiedAt &&
    left.pluginId === right.pluginId &&
    left.invocationId === right.invocationId
  );
}

/** @internal Supplied only to the trusted artifact runtime composition. */
export function createCanonicalPluginEvidenceAuthority(input: {
  executor: RegisteredPluginToolExecutor;
  activeAccountId(): string | undefined;
  results: CanonicalPluginArtifactResultReadPort;
  grants: CanonicalPluginArtifactGrantAuthority;
}): CanonicalPluginEvidenceAuthority {
  if (!canonicalRegisteredPluginExecutors.has(input.executor as object)) {
    throw new TypeError('canonical_plugin_executor_invalid');
  }
  return Object.freeze({
    async verify(evidence: CanonicalPluginEvidence) {
      if (!validPluginEvidence(evidence) || input.activeAccountId() !== evidence.accountId) {
        return null;
      }
      let record: Awaited<ReturnType<typeof input.results.readCanonicalPluginResult>>;
      try {
        record = await input.results.readCanonicalPluginResult(evidence);
      } catch {
        return null;
      }
      if (
        !record ||
        !Object.isFrozen(record) ||
        record.executor !== input.executor ||
        !validPluginEvidence(record.evidence) ||
        !samePluginEvidence(evidence, record.evidence) ||
        !Object.isFrozen(record.registration) ||
        !isRegisteredPluginToolExecutor(record.registration) ||
        record.registration.pluginId !== evidence.pluginId
      ) {
        return null;
      }
      const manifest = getPluginManifest(record.registration.pluginId);
      if (
        !manifest ||
        !isConnectableStatus(manifest.status) ||
        !manifest.tools.some((tool) => tool.name === record.registration.toolName)
      ) {
        return null;
      }
      let grantCurrent = false;
      try {
        grantCurrent = await input.grants.revalidateCanonicalPluginGrant({
          evidence: record.evidence,
          registration: record.registration,
        });
      } catch {
        return null;
      }
      return grantCurrent && input.activeAccountId() === evidence.accountId
        ? record.evidence
        : null;
    },
  });
}

function safeFailure(reason: string): Error {
  return new Error(`Plugin credential authority denied the operation: ${reason}.`);
}

function exactNonblank(value: string, label: string): string {
  if (!value || value.trim() !== value) throw safeFailure(`${label}_invalid`);
  return value;
}

function assertActiveAccount(
  requestedAccountId: string,
  activeAccountId: () => string | undefined,
): void {
  exactNonblank(requestedAccountId, 'account');
  if (activeAccountId() !== requestedAccountId) throw safeFailure('account_mismatch');
}

function manifestFor(pluginId: string): PluginManifest {
  exactNonblank(pluginId, 'plugin');
  const manifest = getPluginManifest(pluginId);
  if (!manifest) throw safeFailure('plugin_unavailable');
  return manifest;
}

function locatorFor(manifest: PluginManifest, fieldId: string): ExistingPluginCredentialLocator {
  exactNonblank(fieldId, 'field');
  if (!manifest.fields.some((field) => field.id === fieldId)) {
    throw safeFailure('credential_locator_unavailable');
  }
  return Object.freeze({ pluginId: manifest.id, fieldId });
}

function locatorsFor(manifest: PluginManifest): readonly ExistingPluginCredentialLocator[] {
  return manifest.fields.map((field) =>
    Object.freeze({
      pluginId: manifest.id,
      fieldId: field.id,
    }),
  );
}

function grantIdentity(grant: PluginCredentialAccountGrantV1) {
  return {
    accountId: grant.accountId,
    pluginId: grant.pluginId,
    fieldId: grant.fieldId,
    grantId: grant.grantId,
    revision: grant.revision,
  };
}

async function authorizeLocators(input: {
  accountId: string;
  locators: readonly ExistingPluginCredentialLocator[];
  authority: JarvisExistingCredentialAuthorizationAuthority;
}): Promise<readonly JarvisExistingCredentialAuthorization[]> {
  const authorizations: JarvisExistingCredentialAuthorization[] = [];
  for (const locator of input.locators) {
    const decision = await input.authority.authorize({
      accountId: input.accountId,
      locator,
    });
    if (!decision.authorized) throw safeFailure(decision.reason);
    authorizations.push(decision.authorization);
  }
  return authorizations;
}

async function readAuthorizedCredentials(input: {
  accountId: string;
  locators: readonly ExistingPluginCredentialLocator[];
  activeAccountId: () => string | undefined;
  authority: JarvisExistingCredentialAuthorizationAuthority;
  adapter: ExistingPluginCredentialAdapter;
}): Promise<
  Readonly<{
    values: CredentialMap;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
  }>
> {
  if (input.locators.length === 0) {
    assertActiveAccount(input.accountId, input.activeAccountId);
    return { values: {}, authorizations: [] };
  }
  const authorizations = await authorizeLocators({
    accountId: input.accountId,
    locators: input.locators,
    authority: input.authority,
  });
  return await withPluginCredentialLocatorLocks(input.locators, async (locks) => {
    assertActiveAccount(input.accountId, input.activeAccountId);
    const values: CredentialMap = {};
    for (const authorization of authorizations) {
      const before = await input.authority.revalidateLocked({ authorization, locks });
      if (!before.authorized) throw safeFailure(before.reason);
      let value: string | undefined;
      try {
        value = await input.adapter.readExistingCredential(authorization.locator);
      } catch {
        throw safeFailure('credential_grant_unavailable');
      }
      const after = await input.authority.revalidateLocked({ authorization, locks });
      if (!after.authorized) throw safeFailure(after.reason);
      if (value === undefined) throw safeFailure('credential_grant_unavailable');
      values[authorization.locator.fieldId] = value;
    }
    return { values, authorizations };
  });
}

function required(values: CredentialMap, key: string, label: string): string {
  const value = values[key]?.trim();
  if (!value) throw safeFailure(`${label.toLowerCase().replace(/\s+/g, '_')}_required`);
  return value;
}

const GITHUB_OWNER = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_DEFAULT_BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const GITHUB_ACTOR = /^(?=.{1,100}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const GITHUB_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const GITHUB_WORKFLOW_STATE = /^[a-z][a-z_]{0,39}$/;
const GITHUB_COMMIT_LIMIT = 5;
const GITHUB_WORKFLOW_LIMIT = 10;
const GITHUB_TITLE_LIMIT = 240;
const GITHUB_BODY_LIMIT = 4_000;
const GITHUB_LABEL_LIMIT = 80;
const GITHUB_LABEL_COUNT_LIMIT = 12;
const GITHUB_COMMIT_MESSAGE_LIMIT = 500;
const GITHUB_RELEASE_NAME_LIMIT = 240;
const GITHUB_WORKFLOW_NAME_LIMIT = 240;
const GITHUB_RELEASE_TAG_LIMIT = 255;
const EXTERNAL_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN((?: [A-Z0-9]+)*) PRIVATE KEY-----[\s\S]*?(?:-----END\1 PRIVATE KEY-----|$)/gi,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/gi,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gi,
  /\bxox[bp]-[A-Za-z0-9-]{20,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:gsk_|sb_secret_)[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:xai-|sk-ant-)[A-Za-z0-9_-]{16,}\b/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/gi,
  /\bwhsec_[A-Za-z0-9_]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi,
  /\b(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|x[-_ ]?api[-_ ]?key|api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|signing[-_ ]?key|service[-_ ]?role|password|passwd|credential|secret)\b\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;}]+)/gi,
];

function exactParameterRecord(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  reason: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw safeFailure(reason);
  }
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor || !('value' in descriptor)) {
      throw safeFailure(reason);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function providerRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw safeFailure('provider_response_invalid');
  }
  return value as Record<string, unknown>;
}

function githubOwner(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !GITHUB_OWNER.test(value)) throw safeFailure(reason);
  return value;
}

function githubRepository(value: unknown, reason: string): string {
  if (
    typeof value !== 'string' ||
    !GITHUB_REPOSITORY.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw safeFailure(reason);
  }
  return value;
}

function githubRepositoryTarget(
  params: Readonly<Record<string, unknown>>,
): Readonly<{ owner: string; repository: string }> {
  const record = exactParameterRecord(params, ['owner', 'repository'], 'repository_target_invalid');
  return {
    owner: githubOwner(record.owner, 'repository_target_invalid'),
    repository: githubRepository(record.repository, 'repository_target_invalid'),
  };
}

function githubNumberedTarget(
  params: Readonly<Record<string, unknown>>,
): Readonly<{ owner: string; repository: string; number: number }> {
  const record = exactParameterRecord(
    params,
    ['owner', 'repository', 'number'],
    'numbered_target_invalid',
  );
  if (!Number.isSafeInteger(record.number) || (record.number as number) <= 0) {
    throw safeFailure('numbered_target_invalid');
  }
  return {
    owner: githubOwner(record.owner, 'numbered_target_invalid'),
    repository: githubRepository(record.repository, 'numbered_target_invalid'),
    number: record.number as number,
  };
}

function githubCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw safeFailure('provider_response_invalid');
  }
  return value as number;
}

function githubDefaultBranch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !GITHUB_DEFAULT_BRANCH.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{')
  ) {
    throw safeFailure('provider_response_invalid');
  }
  return value;
}

function githubTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !GITHUB_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw safeFailure('provider_response_invalid');
  }
  return value;
}

function githubOptionalTimestamp(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : githubTimestamp(value);
}

function githubActor(value: unknown): string {
  const record = providerRecord(value);
  if (typeof record.login !== 'string' || !GITHUB_ACTOR.test(record.login)) {
    throw safeFailure('provider_response_invalid');
  }
  return record.login;
}

function redactExternalSecrets(value: string): string {
  let result = value;
  for (const pattern of EXTERNAL_SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted secret]');
  }
  return result;
}

function boundedExternalText(
  value: unknown,
  limit: number,
  required: boolean,
): Readonly<{ text?: string; truncated: boolean }> {
  if (value === null || value === undefined) {
    if (required) throw safeFailure('provider_response_invalid');
    return { truncated: false };
  }
  if (typeof value !== 'string') throw safeFailure('provider_response_invalid');
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) {
    if (required) throw safeFailure('provider_response_invalid');
    return { truncated: false };
  }
  const redacted = redactExternalSecrets(normalized);
  const characters = Array.from(redacted);
  return {
    text: characters.slice(0, limit).join(''),
    truncated: characters.length > limit,
  };
}

function githubLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw safeFailure('provider_response_invalid');
  return value.slice(0, GITHUB_LABEL_COUNT_LIMIT).map((candidate) => {
    const label = providerRecord(candidate);
    const normalized = boundedExternalText(label.name, GITHUB_LABEL_LIMIT, true).text;
    if (!normalized) throw safeFailure('provider_response_invalid');
    return normalized;
  });
}

function githubProviderArray(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw safeFailure('provider_response_invalid');
  }
  return value;
}

function githubCommitSha(value: unknown): string {
  if (typeof value !== 'string' || !GITHUB_COMMIT_SHA.test(value)) {
    throw safeFailure('provider_response_invalid');
  }
  return value.toLowerCase();
}

function githubOptionalActor(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : githubActor(value);
}

function githubWorkflowId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw safeFailure('provider_response_invalid');
  }
  return value as number;
}

function githubWorkflowState(value: unknown): string {
  if (typeof value !== 'string' || !GITHUB_WORKFLOW_STATE.test(value)) {
    throw safeFailure('provider_response_invalid');
  }
  return value;
}

function githubReleaseTag(value: unknown): string {
  if (typeof value !== 'string') throw safeFailure('provider_response_invalid');
  const normalized = value.normalize('NFC');
  const components = normalized.split('/');
  if (
    !normalized ||
    normalized !== value ||
    Array.from(normalized).length > GITHUB_RELEASE_TAG_LIMIT ||
    /[\p{Cc}\p{Cf}\p{Z}~^:?*]/u.test(normalized) ||
    normalized.includes('[') ||
    normalized.includes('\\') ||
    normalized.includes('..') ||
    normalized.includes('@{') ||
    components.some(
      (component) =>
        !component ||
        component.startsWith('.') ||
        component.endsWith('.') ||
        component.toLowerCase().endsWith('.lock'),
    ) ||
    redactExternalSecrets(normalized) !== normalized
  ) {
    throw safeFailure('provider_response_invalid');
  }
  return normalized;
}

function githubHeaders(
  token: string,
  accept = 'application/vnd.github+json',
): Readonly<Record<string, string>> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function normalizeStoreDomain(raw: string): string {
  const store = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store)) {
    throw safeFailure('store_domain_invalid');
  }
  return store;
}

function mailchimpDatacenter(apiKey: string): string {
  const suffix = apiKey.trim().split('-').pop();
  if (!suffix || !/^[a-z]{2}\d+$/i.test(suffix)) throw safeFailure('datacenter_invalid');
  return suffix.toLowerCase();
}

function substitute(template: string, values: CredentialMap, manifest: PluginManifest): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (manifest.id === 'supabase' && key === 'url') {
      return normalizeSupabaseProjectOrigin(required(values, 'url', 'Project URL'));
    }
    if (key === 'store') return normalizeStoreDomain(required(values, 'store', 'Store domain'));
    if (key === 'basic_email_key') {
      return btoa(
        `${required(values, 'email', 'Account email')}:${required(values, 'api_key', 'Management API key')}`,
      );
    }
    if (key === 'basic_auth') {
      return btoa(
        `${required(values, 'account_sid', 'Account SID')}:${required(values, 'auth_token', 'Auth token')}`,
      );
    }
    if (key === 'stripe_basic') return btoa(`${required(values, 'secret_key', 'Secret key')}:`);
    if (key === 'datacenter') return mailchimpDatacenter(required(values, 'api_key', 'API key'));
    if (key === 'mongo_basic') {
      return btoa(
        `${required(values, 'public_key', 'Public key')}:${required(values, 'private_key', 'Private key')}`,
      );
    }
    if (key === 'woo_basic') {
      return btoa(
        `${required(values, 'consumer_key', 'Consumer key')}:${required(values, 'consumer_secret', 'Consumer secret')}`,
      );
    }
    if (key === 'chargebee_basic') return btoa(`${required(values, 'api_key', 'API key')}:`);
    if (key === 'wp_basic') {
      return btoa(
        `${required(values, 'username', 'Username')}:${required(values, 'app_password', 'Application password')}`,
      );
    }
    const field = manifest.fields.find((candidate) => candidate.id === key);
    return required(values, key, field?.label ?? key);
  });
}

function readPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== 'object') return undefined;
    const match = /^(\w+)\[(\d+)\]$/.exec(segment);
    if (match) {
      const list = (current as Record<string, unknown>)[match[1]!];
      return Array.isArray(list) ? list[Number(match[2])] : undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, data);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function requestProbe(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  acceptEmpty?: boolean,
): Promise<{ data: Record<string, unknown>; hostname?: string }> {
  const response = await nativeFetch(url, { ...init, signal, timeoutMs: 12_000 });
  const body = await response.text();
  if (!response.ok && !acceptEmpty) throw safeFailure(`connection_rejected_${response.status}`);
  if (!body.trim()) return { data: {}, hostname: safeHostname(url) };
  try {
    return { data: JSON.parse(body) as Record<string, unknown>, hostname: safeHostname(url) };
  } catch {
    if (acceptEmpty && response.ok) return { data: {}, hostname: safeHostname(url) };
    throw safeFailure('provider_response_invalid');
  }
}

async function runHttpTest(
  manifest: PluginManifest,
  values: CredentialMap,
  test: PluginHttpTest,
  signal: AbortSignal,
): Promise<PluginTestResult> {
  const url = substitute(test.url, values, manifest);
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(test.headers ?? {})) {
    headers[header] = substitute(value, values, manifest);
  }
  const init: RequestInit = {
    method: test.method ?? 'GET',
    headers,
    ...(manifest.id === 'supabase' ? { redirect: 'error' as const } : {}),
  };
  if (test.body) init.body = substitute(test.body, values, manifest);
  const { data, hostname } = await requestProbe(url, init, signal, test.acceptEmpty);
  if (Object.prototype.hasOwnProperty.call(data, 'ok') && data.ok !== true) {
    throw safeFailure('provider_rejected');
  }
  let accountLabel: string | undefined;
  if (test.accountLabelPath) {
    const value = readPath(data, test.accountLabelPath);
    if (value != null && value !== '') accountLabel = String(value);
  }
  if (!accountLabel && hostname) accountLabel = hostname;
  return { ok: true, accountLabel: accountLabel ?? manifest.provider };
}

function manualSetupResult(manifest: PluginManifest): PluginTestResult {
  return {
    ok: false,
    error:
      manifest.authType === 'oauth'
        ? 'Manual Setup Required: complete OAuth authorization, then test again.'
        : 'Manual Setup Required: complete provider setup, then test again.',
  };
}

function isPrivilegedSupabaseKey(value: string): boolean {
  const key = value.trim();
  if (/^(?:sb_secret_|service_role(?:$|[._-]))/iu.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const encoded = parts[1].replace(/-/gu, '+').replace(/_/gu, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as unknown;
    return (
      Boolean(payload) &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).role === 'service_role'
    );
  } catch {
    return false;
  }
}

function normalizeSupabaseProjectOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw safeFailure('supabase_project_url_invalid');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\.supabase\.co$/u.test(hostname)
  ) {
    throw safeFailure('supabase_project_url_invalid');
  }
  return `https://${hostname}`;
}

async function testManifestConnection(
  manifest: PluginManifest,
  values: CredentialMap,
  signal: AbortSignal = AbortSignal.timeout(12_000),
  zapierGatewayFactory?: ZapierGatewayFactory,
): Promise<PluginTestResult> {
  if (manifest.id === 'mock-connector' || manifest.authType === 'none') {
    return { ok: true, accountLabel: 'Local test connector' };
  }
  for (const field of manifest.fields) {
    if (field.required && !values[field.id]?.trim())
      throw safeFailure('required_field_unavailable');
  }
  if (manifest.id === 'gmail') return await testGmailConnection({ values, signal });
  if (manifest.id === 'google-drive') {
    return await testGoogleDriveConnection({ values, signal });
  }
  if (manifest.id === 'supabase' && isPrivilegedSupabaseKey(values.key ?? '')) {
    throw safeFailure('supabase_privileged_key_rejected');
  }
  if (manifest.id === 'zapier') {
    return await testZapierConnection({ values, signal, gatewayFactory: zapierGatewayFactory });
  }
  if (manifest.httpTest) return await runHttpTest(manifest, values, manifest.httpTest, signal);
  if (
    manifest.authType === 'oauth' ||
    manifest.status === 'needs_credentials' ||
    manifest.status === 'blocked' ||
    manifest.authType === 'service_account'
  ) {
    return manualSetupResult(manifest);
  }
  return { ok: false, error: 'This catalog entry does not have a live connector yet.' };
}

async function runGithubTool(input: {
  toolName: string;
  params: Readonly<Record<string, unknown>>;
  values: CredentialMap;
  signal: AbortSignal;
}): Promise<ActionResult> {
  const token = required(input.values, 'token', 'GitHub token');
  if (input.toolName === 'identity') {
    exactParameterRecord(input.params, [], 'identity_parameters_invalid');
    const response = providerRecord(
      (
        await requestProbe(
          'https://api.github.com/user',
          { method: 'GET', redirect: 'error', headers: githubHeaders(token) },
          input.signal,
        )
      ).data,
    );
    const login = githubOwner(response.login, 'provider_response_invalid');
    const publicRepositories = githubCount(response.public_repos);
    const privateRepositories =
      response.total_private_repos === undefined
        ? undefined
        : githubCount(response.total_private_repos);
    return {
      ok: true,
      summary: `GitHub account ${login} verified.`,
      data: {
        login,
        profileUrl: `https://github.com/${login}`,
        publicRepositories,
        ...(privateRepositories === undefined ? {} : { privateRepositories }),
      },
    };
  }

  if (input.toolName === 'repository_context') {
    const target = githubRepositoryTarget(input.params);
    const response = providerRecord(
      (
        await requestProbe(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repository,
          )}`,
          { method: 'GET', redirect: 'error', headers: githubHeaders(token) },
          input.signal,
        )
      ).data,
    );
    if (typeof response.full_name !== 'string') throw safeFailure('provider_response_invalid');
    const fullNameParts = response.full_name.split('/');
    if (fullNameParts.length !== 2) throw safeFailure('provider_response_invalid');
    const canonicalOwner = githubOwner(fullNameParts[0], 'provider_response_invalid');
    const canonicalRepository = githubRepository(fullNameParts[1], 'provider_response_invalid');
    const fullName = `${canonicalOwner}/${canonicalRepository}`;
    if (
      canonicalOwner.toLowerCase() !== target.owner.toLowerCase() ||
      canonicalRepository.toLowerCase() !== target.repository.toLowerCase()
    ) {
      throw safeFailure('provider_response_invalid');
    }
    const visibility =
      response.visibility === 'public' ||
      response.visibility === 'private' ||
      response.visibility === 'internal'
        ? response.visibility
        : typeof response.private === 'boolean'
          ? response.private
            ? 'private'
            : 'public'
          : undefined;
    if (!visibility || typeof response.archived !== 'boolean') {
      throw safeFailure('provider_response_invalid');
    }
    return {
      ok: true,
      summary: `GitHub repository ${fullName} retrieved.`,
      data: {
        fullName,
        repositoryUrl: `https://github.com/${fullName}`,
        visibility,
        defaultBranch: githubDefaultBranch(response.default_branch),
        stars: githubCount(response.stargazers_count),
        forks: githubCount(response.forks_count),
        openIssuesAndPullRequests: githubCount(response.open_issues_count),
        archived: response.archived,
        updatedAt: githubTimestamp(response.updated_at),
      },
    };
  }

  if (input.toolName === 'recent_commits') {
    const target = githubRepositoryTarget(input.params);
    const fullName = `${target.owner}/${target.repository}`;
    const response = (
      await requestProbe(
        `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.repository,
        )}/commits?per_page=${GITHUB_COMMIT_LIMIT}&page=1`,
        { method: 'GET', redirect: 'error', headers: githubHeaders(token) },
        input.signal,
      )
    ).data;
    const commits = githubProviderArray(response, GITHUB_COMMIT_LIMIT).map((candidate) => {
      const record = providerRecord(candidate);
      const sha = githubCommitSha(record.sha);
      const commit = providerRecord(record.commit);
      const committer = providerRecord(commit.committer);
      const verification = providerRecord(commit.verification);
      if (typeof verification.verified !== 'boolean') {
        throw safeFailure('provider_response_invalid');
      }
      const message = boundedExternalText(commit.message, GITHUB_COMMIT_MESSAGE_LIMIT, true).text;
      if (!message) throw safeFailure('provider_response_invalid');
      const author = githubOptionalActor(record.author);
      return {
        sha,
        commitUrl: `https://github.com/${fullName}/commit/${sha}`,
        untrustedMessageExcerpt: message,
        ...(author === undefined ? {} : { author }),
        committedAt: githubTimestamp(committer.date),
        verified: verification.verified,
      };
    });
    return {
      ok: true,
      summary: `${commits.length} recent GitHub commits retrieved for ${fullName}.`,
      data: {
        contentTrust: 'external_untrusted',
        fullName,
        commits,
      },
    };
  }

  if (input.toolName === 'latest_release') {
    const target = githubRepositoryTarget(input.params);
    const fullName = `${target.owner}/${target.repository}`;
    const response = providerRecord(
      (
        await requestProbe(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repository,
          )}/releases/latest`,
          { method: 'GET', redirect: 'error', headers: githubHeaders(token) },
          input.signal,
        )
      ).data,
    );
    if (response.draft !== false || response.prerelease !== false) {
      throw safeFailure('provider_response_invalid');
    }
    const tagName = githubReleaseTag(response.tag_name);
    const name = boundedExternalText(response.name, GITHUB_RELEASE_NAME_LIMIT, false);
    const body = boundedExternalText(response.body, GITHUB_BODY_LIMIT, false);
    return {
      ok: true,
      summary: `Latest GitHub release retrieved for ${fullName}.`,
      data: {
        contentTrust: 'external_untrusted',
        fullName,
        releaseUrl: `https://github.com/${fullName}/releases/tag/${encodeURIComponent(tagName)}`,
        tagName,
        ...(name.text === undefined ? {} : { untrustedName: name.text }),
        ...(body.text === undefined ? {} : { untrustedBodyExcerpt: body.text }),
        bodyTruncated: body.truncated,
        author: githubActor(response.author),
        prerelease: response.prerelease,
        createdAt: githubTimestamp(response.created_at),
        publishedAt: githubTimestamp(response.published_at),
      },
    };
  }

  if (input.toolName === 'workflows') {
    const target = githubRepositoryTarget(input.params);
    const fullName = `${target.owner}/${target.repository}`;
    const response = providerRecord(
      (
        await requestProbe(
          `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
            target.repository,
          )}/actions/workflows?per_page=${GITHUB_WORKFLOW_LIMIT}&page=1`,
          { method: 'GET', redirect: 'error', headers: githubHeaders(token) },
          input.signal,
        )
      ).data,
    );
    const totalCount = githubCount(response.total_count);
    const workflows = githubProviderArray(response.workflows, GITHUB_WORKFLOW_LIMIT).map(
      (candidate) => {
        const workflow = providerRecord(candidate);
        const id = githubWorkflowId(workflow.id);
        const name = boundedExternalText(workflow.name, GITHUB_WORKFLOW_NAME_LIMIT, true).text;
        if (!name) throw safeFailure('provider_response_invalid');
        return {
          id,
          workflowUrl: `https://github.com/${fullName}/actions/workflows/${id}`,
          untrustedName: name,
          state: githubWorkflowState(workflow.state),
          createdAt: githubTimestamp(workflow.created_at),
          updatedAt: githubTimestamp(workflow.updated_at),
        };
      },
    );
    if (totalCount < workflows.length) throw safeFailure('provider_response_invalid');
    return {
      ok: true,
      summary: `${workflows.length} GitHub workflows retrieved for ${fullName}; Actions logs not retrieved.`,
      data: {
        contentTrust: 'external_untrusted',
        fullName,
        totalCount,
        actionsLogsRetrieved: false,
        workflows,
      },
    };
  }

  if (input.toolName !== 'issue_context' && input.toolName !== 'pull_request_context') {
    throw safeFailure('plugin_tool_unavailable');
  }
  const target = githubNumberedTarget(input.params);
  const isIssue = input.toolName === 'issue_context';
  const resource = isIssue ? 'issues' : 'pulls';
  const response = providerRecord(
    (
      await requestProbe(
        `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
          target.repository,
        )}/${resource}/${target.number}`,
        {
          method: 'GET',
          redirect: 'error',
          headers: githubHeaders(token, 'application/vnd.github.text+json'),
        },
        input.signal,
      )
    ).data,
  );
  if (response.number !== target.number) throw safeFailure('provider_response_invalid');
  if (isIssue && Object.prototype.hasOwnProperty.call(response, 'pull_request')) {
    throw safeFailure('github_target_type_mismatch');
  }
  if (response.state !== 'open' && response.state !== 'closed') {
    throw safeFailure('provider_response_invalid');
  }
  const title = boundedExternalText(response.title, GITHUB_TITLE_LIMIT, true);
  const body = boundedExternalText(response.body_text, GITHUB_BODY_LIMIT, false);
  const fullName = `${target.owner}/${target.repository}`;
  const closedAt = githubOptionalTimestamp(response.closed_at);
  const common = {
    contentTrust: 'external_untrusted',
    fullName,
    number: target.number,
    state: response.state,
    untrustedTitle: title.text!,
    ...(body.text === undefined ? {} : { untrustedBodyExcerpt: body.text }),
    bodyTruncated: body.truncated,
    author: githubActor(response.user),
    createdAt: githubTimestamp(response.created_at),
    updatedAt: githubTimestamp(response.updated_at),
    ...(closedAt === undefined ? {} : { closedAt }),
  };

  if (isIssue) {
    if (typeof response.locked !== 'boolean') throw safeFailure('provider_response_invalid');
    return {
      ok: true,
      summary: `GitHub issue ${fullName}#${target.number} retrieved.`,
      data: {
        ...common,
        issueUrl: `https://github.com/${fullName}/issues/${target.number}`,
        untrustedLabels: githubLabels(response.labels),
        comments: githubCount(response.comments),
        locked: response.locked,
      },
    };
  }

  if (typeof response.draft !== 'boolean' || typeof response.merged !== 'boolean') {
    throw safeFailure('provider_response_invalid');
  }
  const base = providerRecord(response.base);
  const head = providerRecord(response.head);
  const mergedAt = githubOptionalTimestamp(response.merged_at);
  return {
    ok: true,
    summary: `GitHub pull request ${fullName}#${target.number} retrieved.`,
    data: {
      ...common,
      pullRequestUrl: `https://github.com/${fullName}/pull/${target.number}`,
      draft: response.draft,
      merged: response.merged,
      baseBranch: githubDefaultBranch(base.ref),
      headBranch: githubDefaultBranch(head.ref),
      changedFiles: githubCount(response.changed_files),
      additions: githubCount(response.additions),
      deletions: githubCount(response.deletions),
      comments: githubCount(response.comments),
      reviewComments: githubCount(response.review_comments),
      ...(mergedAt === undefined ? {} : { mergedAt }),
    },
  };
}

function deepFreezePluginResult<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) throw safeFailure('plugin_result_invalid');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw safeFailure('plugin_result_invalid');
    deepFreezePluginResult(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(value);
}

function canonicalPluginResult(result: ActionResult): ActionResult {
  return deepFreezePluginResult(structuredClone(result));
}

function githubFullName(value: unknown): string {
  if (typeof value !== 'string') throw safeFailure('plugin_result_invalid');
  const parts = value.split('/');
  if (parts.length !== 2) throw safeFailure('plugin_result_invalid');
  return `${githubOwner(parts[0], 'plugin_result_invalid')}/${githubRepository(
    parts[1],
    'plugin_result_invalid',
  )}`;
}

function githubLinkDraft(input: {
  evidence: CanonicalPluginEvidence;
  title: string;
  uri: string;
}): JarvisArtifactDraft {
  const sourceRefs: JarvisArtifactDraft['artifact']['sourceRefs'] = [];
  Object.freeze(sourceRefs);
  return Object.freeze({
    artifact: Object.freeze({
      kind: 'link' as const,
      title: input.title,
      state: 'ready' as const,
      safeSummary: `${input.title} retrieved.`,
      sourceRefs,
      createdAt: input.evidence.verifiedAt,
    }),
    backing: Object.freeze({
      kind: 'uri' as const,
      uri: input.uri,
    }),
  });
}

function githubArtifactDrafts(input: {
  evidence: CanonicalPluginEvidence;
  registration: CanonicalPluginRegistration;
  result: Extract<ActionResult, { ok: true }>;
}): readonly JarvisArtifactDraft[] {
  if (input.registration.pluginId !== 'github') return Object.freeze([]);
  const data = providerRecord(input.result.data);
  const drafts: JarvisArtifactDraft[] = [];
  const add = (title: string, uri: string) => {
    if (drafts.some((draft) => draft.backing.kind === 'uri' && draft.backing.uri === uri)) {
      return;
    }
    drafts.push(githubLinkDraft({ evidence: input.evidence, title, uri }));
  };

  if (input.registration.toolName === 'identity') {
    const login = githubActor({ login: data.login });
    add(`GitHub profile ${login}`, `https://github.com/${login}`);
  } else if (input.registration.toolName === 'repository_context') {
    const fullName = githubFullName(data.fullName);
    add(`GitHub repository ${fullName}`, `https://github.com/${fullName}`);
  } else if (input.registration.toolName === 'recent_commits') {
    const fullName = githubFullName(data.fullName);
    for (const candidate of githubProviderArray(data.commits, GITHUB_COMMIT_LIMIT)) {
      const commit = providerRecord(candidate);
      const sha = githubCommitSha(commit.sha);
      add(`GitHub commit ${sha.slice(0, 7)}`, `https://github.com/${fullName}/commit/${sha}`);
    }
    if (drafts.length === 0) {
      add(`GitHub commits for ${fullName}`, `https://github.com/${fullName}/commits`);
    }
  } else if (input.registration.toolName === 'latest_release') {
    const fullName = githubFullName(data.fullName);
    const tagName = githubReleaseTag(data.tagName);
    add(
      `Latest GitHub release for ${fullName}`,
      `https://github.com/${fullName}/releases/tag/${encodeURIComponent(tagName)}`,
    );
  } else if (input.registration.toolName === 'workflows') {
    const fullName = githubFullName(data.fullName);
    for (const candidate of githubProviderArray(data.workflows, GITHUB_WORKFLOW_LIMIT)) {
      const workflow = providerRecord(candidate);
      const id = githubWorkflowId(workflow.id);
      add(`GitHub workflow ${id}`, `https://github.com/${fullName}/actions/workflows/${id}`);
    }
    if (drafts.length === 0) {
      add(`GitHub Actions for ${fullName}`, `https://github.com/${fullName}/actions`);
    }
  } else if (input.registration.toolName === 'issue_context') {
    const fullName = githubFullName(data.fullName);
    const number = githubCount(data.number);
    if (number <= 0) throw safeFailure('plugin_result_invalid');
    add(`GitHub issue ${fullName}#${number}`, `https://github.com/${fullName}/issues/${number}`);
  } else if (input.registration.toolName === 'pull_request_context') {
    const fullName = githubFullName(data.fullName);
    const number = githubCount(data.number);
    if (number <= 0) throw safeFailure('plugin_result_invalid');
    add(
      `GitHub pull request ${fullName}#${number}`,
      `https://github.com/${fullName}/pull/${number}`,
    );
  }

  if (drafts.length === 0) throw safeFailure('plugin_result_artifact_unavailable');
  return Object.freeze(drafts);
}

export function createAccountScopedPluginRuntime(input: {
  activeAccountId(): string | undefined;
  grants: PluginCredentialAccountGrantRepository;
  credentialAuthorization: JarvisExistingCredentialAuthorizationAuthority;
  credentialAdapter: ExistingPluginCredentialAdapter;
  connections: Pick<PluginStore, 'upsertConnection' | 'removeConnection'>;
  randomUUID: () => string;
  now: () => number;
  zapierGatewayFactory?: ZapierGatewayFactory;
  authorization?: PluginAuthorizationAuthority;
}): Readonly<{
  management: PluginManagementCapability;
  registeredTools: PreparedRegisteredPluginToolExecutor;
  canonicalArtifacts: CanonicalPluginArtifactCapability;
}> {
  type PendingCanonicalPluginResult = Readonly<{
    accountId: string;
    registration: CanonicalPluginRegistration;
    runId: string;
    requestId: string;
    attemptNumber: number;
    approvalId: string;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
    generation: ArtifactGeneration;
  }>;
  type CanonicalPluginResultRecord = Readonly<{
    evidence: CanonicalPluginEvidence;
    registration: CanonicalPluginRegistration;
    executor: RegisteredPluginToolExecutor;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
    generation: ArtifactGeneration;
  }>;
  type ArtifactGeneration = Readonly<{ runtime: object; account: object }>;
  const pendingCanonicalResults = new Map<object, PendingCanonicalPluginResult>();
  const canonicalResults = new Map<string, CanonicalPluginResultRecord>();
  const accountGenerations = new Map<string, object>();
  let runtimeGeneration: object = Object.freeze({});
  let permanentlyRevoked = false;
  const currentAccountGeneration = (accountId: string): object => {
    const current = accountGenerations.get(accountId);
    if (current) return current;
    const created = Object.freeze({});
    accountGenerations.set(accountId, created);
    return created;
  };
  const captureArtifactGeneration = (accountId: string): ArtifactGeneration | null =>
    !permanentlyRevoked && input.activeAccountId() === accountId
      ? Object.freeze({
          runtime: runtimeGeneration,
          account: currentAccountGeneration(accountId),
        })
      : null;
  const artifactGenerationIsCurrent = (
    accountId: string,
    generation: ArtifactGeneration,
  ): boolean =>
    !permanentlyRevoked &&
    input.activeAccountId() === accountId &&
    runtimeGeneration === generation.runtime &&
    currentAccountGeneration(accountId) === generation.account;
  const retainBounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
    map.set(key, value);
    while (map.size > 128) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  const revalidateAuthorizations = async (record: {
    accountId: string;
    manifest: PluginManifest;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
  }): Promise<boolean> => {
    if (input.activeAccountId() !== record.accountId) return false;
    const locators = locatorsFor(record.manifest);
    if (locators.length === 0) return record.authorizations.length === 0;
    if (record.authorizations.length !== locators.length) return false;
    try {
      return await withPluginCredentialLocatorLocks(locators, async (locks) => {
        if (input.activeAccountId() !== record.accountId) return false;
        const seen = new Set<string>();
        for (const authorization of record.authorizations) {
          const key = `${authorization.locator.pluginId}\u0000${authorization.locator.fieldId}`;
          if (
            authorization.accountId !== record.accountId ||
            authorization.locator.pluginId !== record.manifest.id ||
            seen.has(key) ||
            !locators.some(
              (locator) =>
                locator.pluginId === authorization.locator.pluginId &&
                locator.fieldId === authorization.locator.fieldId,
            )
          ) {
            return false;
          }
          seen.add(key);
          const decision = await input.credentialAuthorization.revalidateLocked({
            authorization,
            locks,
          });
          if (!decision.authorized) return false;
        }
        return seen.size === locators.length && input.activeAccountId() === record.accountId;
      });
    } catch {
      return false;
    }
  };

  const readCredentialsLocked = async (record: {
    accountId: string;
    manifest: PluginManifest;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
    locks: PluginCredentialLocatorLockSet;
  }): Promise<CredentialMap> => {
    assertActiveAccount(record.accountId, input.activeAccountId);
    const values: CredentialMap = {};
    for (const authorization of record.authorizations) {
      const before = await input.credentialAuthorization.revalidateLocked({
        authorization,
        locks: record.locks,
      });
      if (!before.authorized) throw safeFailure(before.reason);
      let value: string | undefined;
      try {
        value = await input.credentialAdapter.readExistingCredential(authorization.locator);
      } catch {
        throw safeFailure('credential_grant_unavailable');
      }
      const after = await input.credentialAuthorization.revalidateLocked({
        authorization,
        locks: record.locks,
      });
      if (!after.authorized) throw safeFailure(after.reason);
      if (value === undefined) throw safeFailure('credential_grant_unavailable');
      values[authorization.locator.fieldId] = value;
    }
    if (
      record.authorizations.length !== record.manifest.fields.length ||
      Object.keys(values).length !== record.manifest.fields.length
    ) {
      throw safeFailure('credential_grant_unavailable');
    }
    return values;
  };

  const canvaCredentialRotation = (record: {
    accountId: string;
    manifest: PluginManifest;
    authorizations: readonly JarvisExistingCredentialAuthorization[];
    locks: PluginCredentialLocatorLockSet;
    values: CredentialMap;
  }): CanvaCredentialRotation => {
    if (record.manifest.id !== 'canva') throw safeFailure('plugin_unavailable');
    return async (mutation) => {
      const { fieldId, expectedValue } = mutation;
      assertActiveAccount(record.accountId, input.activeAccountId);
      const authorization = record.authorizations.find(
        (candidate) =>
          candidate.locator.pluginId === record.manifest.id &&
          candidate.locator.fieldId === fieldId,
      );
      if (!authorization || record.values[fieldId] !== expectedValue) {
        throw safeFailure('prepared_credential_value_mismatch');
      }
      const before = await input.credentialAuthorization.revalidateLocked({
        authorization,
        locks: record.locks,
      });
      if (!before.authorized) throw safeFailure(before.reason);
      let current: string | undefined;
      try {
        current = await input.credentialAdapter.readExistingCredential(authorization.locator);
      } catch {
        throw safeFailure('credential_grant_unavailable');
      }
      if (current !== expectedValue) throw safeFailure('prepared_credential_value_mismatch');
      if (mutation.operation === 'invalidate') {
        await input.grants.removeExact({
          locks: record.locks,
          locator: authorization.locator,
          expected: {
            accountId: authorization.accountId,
            pluginId: authorization.locator.pluginId,
            fieldId: authorization.locator.fieldId,
            grantId: authorization.grantId,
            revision: authorization.revision,
          },
        });
        try {
          await input.credentialAdapter.deleteExistingCredential(authorization.locator);
        } catch {
          throw safeFailure('credential_delete_failed');
        }
        delete record.values[fieldId];
        return;
      }
      try {
        await input.credentialAdapter.writeExistingCredential(
          authorization.locator,
          mutation.nextValue,
        );
      } catch {
        throw safeFailure('credential_rotation_failed');
      }
      record.values[fieldId] = mutation.nextValue;
      const after = await input.credentialAuthorization.revalidateLocked({
        authorization,
        locks: record.locks,
      });
      if (!after.authorized) throw safeFailure(after.reason);
    };
  };

  const management: PluginManagementCapability = Object.freeze({
    async beginAuthorization({
      accountId,
      pluginId,
    }: {
      accountId: string;
      pluginId: string;
    }): Promise<PluginAuthorizationStartResult> {
      assertActiveAccount(accountId, input.activeAccountId);
      const manifest = manifestFor(pluginId);
      const adapter = PLUGIN_CONNECTION_ADAPTERS[manifest.id];
      if (
        !adapter ||
        !['native_oauth_pkce', 'hosted_oauth', 'device_authorization', 'app_installation'].includes(
          adapter.path,
        )
      ) {
        return {
          ok: false,
          error: 'This plugin uses the manual credential connection flow.',
          setupUrl: manifest.docsUrl,
        };
      }
      if (!input.authorization) {
        return {
          ok: false,
          error:
            'Provider authorization is not configured in this VibeSpace build. A registered provider application and callback are required.',
          setupUrl: adapter.documentationUrl,
        };
      }
      input.connections.upsertConnection({
        accountId,
        pluginId: manifest.id,
        state: 'connecting',
        enabled: false,
        enabledProjectIds: [],
        configuredFields: [],
        updatedAt: input.now(),
      });
      try {
        const result = await input.authorization.begin({
          accountId,
          pluginId: manifest.id,
          path: adapter.path as Parameters<PluginAuthorizationAuthority['begin']>[0]['path'],
          scopes: adapter.scopes,
        });
        assertActiveAccount(accountId, input.activeAccountId);
        if (!result.ok) {
          input.connections.upsertConnection({
            accountId,
            pluginId: manifest.id,
            state: 'error',
            enabled: false,
            enabledProjectIds: [],
            error: result.error,
            configuredFields: [],
            updatedAt: input.now(),
          });
          return result;
        }
        let authorizationUrl: string | undefined;
        if (result.authorizationUrl) {
          const url = new URL(result.authorizationUrl);
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash ||
            result.authorizationUrl.length > 8192 ||
            ['access_token', 'refresh_token', 'id_token', 'client_secret'].some((key) =>
              url.searchParams.has(key),
            )
          ) {
            throw safeFailure('oauth_authorization_url_invalid');
          }
          authorizationUrl = url.toString();
        }
        const userCode =
          result.userCode &&
          result.userCode.trim() === result.userCode &&
          result.userCode.length <= 128
            ? result.userCode
            : undefined;
        if (result.userCode && !userCode) throw safeFailure('oauth_user_code_invalid');
        const accountLabel =
          result.accountLabel && result.accountLabel.length <= 256
            ? result.accountLabel
            : undefined;
        const safeResult: PluginAuthorizationStartResult = Object.freeze({
          ok: true,
          state: result.state,
          ...(authorizationUrl ? { authorizationUrl } : {}),
          ...(userCode ? { userCode } : {}),
          ...(accountLabel ? { accountLabel } : {}),
        });
        input.connections.upsertConnection({
          accountId,
          pluginId: manifest.id,
          state: result.state,
          enabled: result.state === 'connected',
          enabledProjectIds: [],
          accountLabel,
          configuredFields: manifest.fields.map((field) => field.id),
          updatedAt: input.now(),
        });
        return safeResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider authorization failed.';
        input.connections.upsertConnection({
          accountId,
          pluginId: manifest.id,
          state: 'error',
          enabled: false,
          enabledProjectIds: [],
          error: message,
          configuredFields: [],
          updatedAt: input.now(),
        });
        return { ok: false, error: message, setupUrl: adapter.documentationUrl };
      }
    },
    async cancelAuthorization({ accountId, pluginId }: { accountId: string; pluginId: string }) {
      assertActiveAccount(accountId, input.activeAccountId);
      if (input.authorization) {
        await input.authorization.cancel({ accountId, pluginId });
      }
      assertActiveAccount(accountId, input.activeAccountId);
      input.connections.removeConnection(accountId, pluginId);
    },
    async saveCredential({
      accountId,
      pluginId,
      fieldId,
      value,
    }: {
      accountId: string;
      pluginId: string;
      fieldId: string;
      value: string;
    }) {
      assertActiveAccount(accountId, input.activeAccountId);
      const manifest = manifestFor(pluginId);
      const locator = locatorFor(manifest, fieldId);
      let normalizedValue = value.trim();
      if (!normalizedValue) throw safeFailure('credential_value_invalid');
      if (manifest.id === 'supabase' && fieldId === 'url') {
        normalizedValue = normalizeSupabaseProjectOrigin(normalizedValue);
      }
      if (
        manifest.id === 'supabase' &&
        fieldId === 'key' &&
        isPrivilegedSupabaseKey(normalizedValue)
      ) {
        throw safeFailure('supabase_privileged_key_rejected');
      }
      await withPluginCredentialLocatorLocks([locator], async (locks) => {
        assertActiveAccount(accountId, input.activeAccountId);
        input.connections.removeConnection(accountId, manifest.id);
        const current = await input.grants.getLocked({ locks, locator });
        if (current && current.accountId !== accountId) {
          input.connections.removeConnection(current.accountId, manifest.id);
        }
        const nextRevision = current && current.accountId === accountId ? current.revision + 1 : 1;
        if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) {
          throw safeFailure('credential_revision_invalid');
        }
        if (current) {
          await input.grants.removeExact({
            locks,
            locator,
            expected: grantIdentity(current),
          });
        }
        try {
          await input.credentialAdapter.writeExistingCredential(locator, normalizedValue);
        } catch {
          throw safeFailure('credential_write_failed');
        }
        assertActiveAccount(accountId, input.activeAccountId);
        const grantId = input.randomUUID();
        const grantedAt = input.now();
        if (
          !grantId ||
          grantId.trim() !== grantId ||
          grantId === current?.grantId ||
          !Number.isFinite(grantedAt)
        ) {
          throw safeFailure('credential_grant_invalid');
        }
        const freshGrant: PluginCredentialAccountGrantV1 = {
          schemaVersion: 1,
          accountId,
          pluginId: locator.pluginId,
          fieldId: locator.fieldId,
          grantId,
          revision: nextRevision,
          grantedAt,
          source: 'explicit_account_save',
        };
        try {
          await input.grants.replaceExact({
            locks,
            expected: { state: 'absent' },
            grant: freshGrant,
          });
        } catch {
          try {
            await input.grants.removeExact({
              locks,
              locator,
              expected: grantIdentity(freshGrant),
            });
          } catch {
            // An absent or concurrently rejected put is already fail-closed.
          }
          throw safeFailure('credential_grant_storage_failed');
        }
      });
    },
    async testConnection({ accountId, pluginId }: { accountId: string; pluginId: string }) {
      assertActiveAccount(accountId, input.activeAccountId);
      const manifest = manifestFor(pluginId);
      const locators = locatorsFor(manifest);
      if (manifest.id === 'canva') {
        let authorizations: readonly JarvisExistingCredentialAuthorization[];
        try {
          authorizations = await authorizeLocators({
            accountId,
            locators,
            authority: input.credentialAuthorization,
          });
          return await withPluginCredentialLocatorLocks(locators, async (locks) => {
            let result: PluginTestResult;
            try {
              const values = await readCredentialsLocked({
                accountId,
                manifest,
                authorizations,
                locks,
              });
              result = await testCanvaConnection({
                values,
                signal: AbortSignal.timeout(12_000),
                rotateCredential: canvaCredentialRotation({
                  accountId,
                  manifest,
                  authorizations,
                  locks,
                  values,
                }),
              });
            } catch (error) {
              result = {
                ok: false,
                error: error instanceof Error ? error.message : 'Plugin unavailable.',
              };
            }
            assertActiveAccount(accountId, input.activeAccountId);
            for (const authorization of authorizations) {
              const decision = await input.credentialAuthorization.revalidateLocked({
                authorization,
                locks,
              });
              if (!decision.authorized) throw safeFailure(decision.reason);
            }
            input.connections.upsertConnection({
              accountId,
              pluginId: manifest.id,
              state: result.ok ? 'connected' : 'error',
              enabled: result.ok,
              enabledProjectIds: [],
              accountLabel: result.accountLabel,
              lastTestedAt: input.now(),
              error: result.error,
              configuredFields: manifest.fields.map((field) => field.id),
              updatedAt: input.now(),
            });
            return result;
          });
        } catch (error) {
          input.connections.removeConnection(accountId, manifest.id);
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Plugin unavailable.',
          };
        }
      }
      let credentialRead: Awaited<ReturnType<typeof readAuthorizedCredentials>> | undefined;
      let result: PluginTestResult;
      try {
        credentialRead = await readAuthorizedCredentials({
          accountId,
          locators,
          activeAccountId: input.activeAccountId,
          authority: input.credentialAuthorization,
          adapter: input.credentialAdapter,
        });
        result = await testManifestConnection(
          manifest,
          credentialRead.values,
          AbortSignal.timeout(12_000),
          input.zapierGatewayFactory,
        );
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : 'Plugin unavailable.',
        };
      }
      const storeResult = () => {
        assertActiveAccount(accountId, input.activeAccountId);
        input.connections.upsertConnection({
          accountId,
          pluginId: manifest.id,
          state: result.ok ? 'connected' : 'error',
          enabled: result.ok,
          enabledProjectIds: [],
          accountLabel: result.accountLabel,
          lastTestedAt: input.now(),
          error: result.error,
          configuredFields: manifest.fields.map((field) => field.id),
          updatedAt: input.now(),
        });
      };
      if (credentialRead?.authorizations.length) {
        try {
          await withPluginCredentialLocatorLocks(locators, async (locks) => {
            assertActiveAccount(accountId, input.activeAccountId);
            for (const authorization of credentialRead!.authorizations) {
              const decision = await input.credentialAuthorization.revalidateLocked({
                authorization,
                locks,
              });
              if (!decision.authorized) throw safeFailure(decision.reason);
            }
            storeResult();
          });
        } catch (error) {
          input.connections.removeConnection(accountId, manifest.id);
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Plugin unavailable.',
          };
        }
      } else {
        storeResult();
      }
      return result;
    },
    async disconnect({ accountId, pluginId }: { accountId: string; pluginId: string }) {
      assertActiveAccount(accountId, input.activeAccountId);
      const manifest = manifestFor(pluginId);
      const locators = locatorsFor(manifest);
      if (locators.length === 0) {
        assertActiveAccount(accountId, input.activeAccountId);
        input.connections.removeConnection(accountId, manifest.id);
        return;
      }
      const authorizations = await authorizeLocators({
        accountId,
        locators,
        authority: input.credentialAuthorization,
      });
      await withPluginCredentialLocatorLocks(locators, async (locks) => {
        assertActiveAccount(accountId, input.activeAccountId);
        for (const authorization of authorizations) {
          const decision = await input.credentialAuthorization.revalidateLocked({
            authorization,
            locks,
          });
          if (!decision.authorized) throw safeFailure(decision.reason);
        }
        assertActiveAccount(accountId, input.activeAccountId);
        for (const authorization of authorizations) {
          assertActiveAccount(accountId, input.activeAccountId);
          await input.grants.removeExact({
            locks,
            locator: authorization.locator,
            expected: {
              accountId: authorization.accountId,
              pluginId: authorization.locator.pluginId,
              fieldId: authorization.locator.fieldId,
              grantId: authorization.grantId,
              revision: authorization.revision,
            },
          });
          try {
            await input.credentialAdapter.deleteExistingCredential(authorization.locator);
          } catch {
            throw safeFailure('credential_delete_failed');
          }
        }
        assertActiveAccount(accountId, input.activeAccountId);
        input.connections.removeConnection(accountId, manifest.id);
      });
    },
  });

  function validateRegisteredTool(inputValue: {
    accountId: string;
    registration: Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
  }): { manifest: PluginManifest; tool: PluginManifest['tools'][number] } {
    assertActiveAccount(inputValue.accountId, input.activeAccountId);
    if (inputValue.context.accountId !== inputValue.accountId)
      throw safeFailure('account_mismatch');
    if (!isRegisteredPluginToolExecutor(inputValue.registration)) {
      throw safeFailure('plugin_registration_unavailable');
    }
    if (!Object.isFrozen(inputValue.registration)) {
      throw safeFailure('plugin_registration_unavailable');
    }
    if (
      Object.prototype.hasOwnProperty.call(inputValue.params, 'pluginId') ||
      Object.prototype.hasOwnProperty.call(inputValue.params, 'toolName')
    ) {
      throw safeFailure('model_selected_plugin_target_rejected');
    }
    const manifest = manifestFor(inputValue.registration.pluginId);
    if (!isConnectableStatus(manifest.status)) throw safeFailure('plugin_unavailable');
    const tool = manifest.tools.find(
      (candidate) => candidate.name === inputValue.registration.toolName,
    );
    if (!tool) throw safeFailure('plugin_tool_unavailable');
    return { manifest, tool };
  }

  function runPreparedTool(inputValue: {
    manifest: PluginManifest;
    tool: PluginManifest['tools'][number];
    params: Readonly<Record<string, unknown>>;
    values: CredentialMap;
    signal: AbortSignal;
    idempotencyKey?: string;
    rotateCredential?: CanvaCredentialRotation;
  }): Promise<ActionResult> {
    const { manifest, tool, params, values, signal, idempotencyKey, rotateCredential } = inputValue;
    if (manifest.id === 'mock-connector' && tool.name === 'ping') {
      return Promise.resolve({
        ok: true,
        summary: 'Fixed plugin tool completed.',
        data: { ok: true, message: 'pong' },
      });
    }
    if (tool.name === 'list_tools') {
      return Promise.resolve({
        ok: true,
        summary: 'Fixed plugin tool completed.',
        data: {
          tools: manifest.tools.map(({ name, description, readOnly }) => ({
            name,
            description,
            readOnly,
          })),
        },
      });
    }
    if (manifest.id === 'github') {
      return runGithubTool({ toolName: tool.name, params, values, signal });
    }
    if (manifest.id === 'gmail') {
      return runGmailTool({ toolName: tool.name, params, values, signal });
    }
    if (manifest.id === 'google-drive') {
      return runGoogleDriveTool({
        toolName: tool.name,
        params,
        values,
        signal,
        idempotencyKey,
      });
    }
    if (manifest.id === 'canva') {
      if (!rotateCredential) throw safeFailure('credential_rotation_unavailable');
      return runCanvaTool({
        toolName: tool.name,
        params,
        values,
        signal,
        rotateCredential,
      });
    }
    if (manifest.id === 'zapier') {
      return runZapierTool({
        toolName: tool.name,
        params,
        values,
        signal,
        gatewayFactory: input.zapierGatewayFactory,
      });
    }
    return testManifestConnection(manifest, values, signal, input.zapierGatewayFactory).then(
      (result): ActionResult => {
        if (!result.ok) return { ok: false, error: result.error ?? 'Plugin connection failed.' };
        return {
          ok: true,
          summary: 'Fixed plugin tool completed.',
          data: { accountLabel: result.accountLabel, capabilityOnly: true },
        };
      },
    );
  }

  const registeredTools: PreparedRegisteredPluginToolExecutor = Object.freeze({
    async execute({
      accountId,
      registration,
      params,
      context,
    }: Parameters<RegisteredPluginToolExecutor['execute']>[0]): Promise<ActionResult> {
      const { manifest, tool } = validateRegisteredTool({
        accountId,
        registration,
        params,
        context,
      });
      if (!tool.readOnly) throw safeFailure('approval_bound_execution_required');
      if (manifest.id === 'canva') {
        const locators = locatorsFor(manifest);
        const authorizations = await authorizeLocators({
          accountId,
          locators,
          authority: input.credentialAuthorization,
        });
        return await withPluginCredentialLocatorLocks(locators, async (locks) => {
          const values = await readCredentialsLocked({
            accountId,
            manifest,
            authorizations,
            locks,
          });
          const result = canonicalPluginResult(
            await runPreparedTool({
              manifest,
              tool,
              params,
              values,
              signal: context.signal ?? AbortSignal.timeout(12_000),
              rotateCredential: canvaCredentialRotation({
                accountId,
                manifest,
                authorizations,
                locks,
                values,
              }),
            }),
          );
          assertActiveAccount(accountId, input.activeAccountId);
          for (const authorization of authorizations) {
            const decision = await input.credentialAuthorization.revalidateLocked({
              authorization,
              locks,
            });
            if (!decision.authorized) throw safeFailure(decision.reason);
          }
          return result;
        });
      }
      const { values } = await readAuthorizedCredentials({
        accountId,
        locators: locatorsFor(manifest),
        activeAccountId: input.activeAccountId,
        authority: input.credentialAuthorization,
        adapter: input.credentialAdapter,
      });
      return canonicalPluginResult(
        await runPreparedTool({
          manifest,
          tool,
          params,
          values,
          signal: context.signal ?? AbortSignal.timeout(12_000),
        }),
      );
    },
    async startPrepared({
      accountId,
      registration,
      params,
      context,
      credentialValues,
      credentialAuthorizations,
    }: Parameters<
      PreparedRegisteredPluginToolExecutor['startPrepared']
    >[0]): Promise<ActionResult> {
      const { manifest, tool } = validateRegisteredTool({
        accountId,
        registration,
        params,
        context,
      });
      if (!context.signal) throw safeFailure('effect_signal_unavailable');
      const effectSignal = context.signal;
      const declaredFields = new Set(manifest.fields.map((field) => field.id));
      const values: CredentialMap = {};
      for (const [fieldId, value] of Object.entries(credentialValues)) {
        if (!declaredFields.has(fieldId) || typeof value !== 'string') {
          throw safeFailure('prepared_credentials_invalid');
        }
        values[fieldId] = value;
      }
      if (!Array.isArray(credentialAuthorizations)) {
        throw safeFailure('prepared_credentials_invalid');
      }
      const authorizationKeys = new Set(
        credentialAuthorizations.map(
          (authorization) =>
            `${authorization.locator.pluginId}\u0000${authorization.locator.fieldId}`,
        ),
      );
      if (
        Object.keys(values).length !== declaredFields.size ||
        credentialAuthorizations.length !== manifest.fields.length ||
        authorizationKeys.size !== manifest.fields.length ||
        credentialAuthorizations.some(
          (authorization) =>
            authorization.accountId !== accountId ||
            authorization.locator.pluginId !== manifest.id ||
            !declaredFields.has(authorization.locator.fieldId),
        )
      ) {
        throw safeFailure('prepared_credentials_invalid');
      }
      const generation = captureArtifactGeneration(accountId);
      if (!generation) throw safeFailure('canonical_plugin_artifact_runtime_revoked');
      const finalize = (result: ActionResult): ActionResult => {
        if (!result.ok) return result;
        if (!artifactGenerationIsCurrent(accountId, generation)) {
          throw safeFailure('credential_grant_stale');
        }
        retainBounded(
          pendingCanonicalResults,
          result,
          Object.freeze({
            accountId,
            registration,
            runId: context.runId,
            requestId: context.requestId,
            attemptNumber: context.attemptNumber,
            approvalId: context.approvalId,
            authorizations: Object.freeze([...credentialAuthorizations]),
            generation,
          }),
        );
        return result;
      };
      const locators = locatorsFor(manifest);
      if (locators.length === 0) {
        assertActiveAccount(accountId, input.activeAccountId);
        return finalize(
          canonicalPluginResult(
            await runPreparedTool({
              manifest,
              tool,
              params,
              values,
              signal: effectSignal,
              idempotencyKey: JSON.stringify([
                context.runId,
                context.requestId,
                context.approvalId,
              ]),
            }),
          ),
        );
      }
      return await withPluginCredentialLocatorLocks(locators, async (locks) => {
        assertActiveAccount(accountId, input.activeAccountId);
        for (const authorization of credentialAuthorizations) {
          const decision = await input.credentialAuthorization.revalidateLocked({
            authorization,
            locks,
          });
          if (!decision.authorized) throw safeFailure(decision.reason);
          let currentValue: string | undefined;
          try {
            currentValue = await input.credentialAdapter.readExistingCredential(
              authorization.locator,
            );
          } catch {
            throw safeFailure('credential_grant_unavailable');
          }
          if (
            currentValue === undefined ||
            currentValue !== values[authorization.locator.fieldId]
          ) {
            throw safeFailure('prepared_credential_value_mismatch');
          }
        }
        const result = canonicalPluginResult(
          await runPreparedTool({
            manifest,
            tool,
            params,
            values,
            signal: effectSignal,
            idempotencyKey: JSON.stringify([context.runId, context.requestId, context.approvalId]),
            ...(manifest.id === 'canva'
              ? {
                  rotateCredential: canvaCredentialRotation({
                    accountId,
                    manifest,
                    authorizations: credentialAuthorizations,
                    locks,
                    values,
                  }),
                }
              : {}),
          }),
        );
        assertActiveAccount(accountId, input.activeAccountId);
        for (const authorization of credentialAuthorizations) {
          const decision = await input.credentialAuthorization.revalidateLocked({
            authorization,
            locks,
          });
          if (!decision.authorized) throw safeFailure(decision.reason);
        }
        return finalize(result);
      });
    },
  });

  canonicalRegisteredPluginExecutors.add(registeredTools);

  const authority = createCanonicalPluginEvidenceAuthority({
    executor: registeredTools,
    activeAccountId: input.activeAccountId,
    results: {
      async readCanonicalPluginResult(evidence) {
        const record = canonicalResults.get(evidence.resultRef);
        return record && artifactGenerationIsCurrent(evidence.accountId, record.generation)
          ? record
          : null;
      },
    },
    grants: {
      async revalidateCanonicalPluginGrant({ evidence, registration }) {
        const record = canonicalResults.get(evidence.resultRef);
        const manifest = getPluginManifest(registration.pluginId);
        if (
          !record ||
          !manifest ||
          record.evidence !== evidence ||
          record.registration !== registration ||
          !artifactGenerationIsCurrent(evidence.accountId, record.generation)
        ) {
          return false;
        }
        const current = await revalidateAuthorizations({
          accountId: evidence.accountId,
          manifest,
          authorizations: record.authorizations,
        });
        return current && artifactGenerationIsCurrent(evidence.accountId, record.generation);
      },
    },
  });
  const canonicalArtifacts: CanonicalPluginArtifactCapability = Object.freeze({
    authority,
    async consumeCanonicalResult({
      evidence,
      registration,
      result,
    }: Parameters<CanonicalPluginArtifactCapability['consumeCanonicalResult']>[0]) {
      const pending = pendingCanonicalResults.get(result);
      if (pending) pendingCanonicalResults.delete(result);
      if (
        !pending ||
        !validPluginEvidence(evidence) ||
        evidence.state !== 'succeeded' ||
        input.activeAccountId() !== evidence.accountId ||
        pending.accountId !== evidence.accountId ||
        pending.runId !== evidence.runId ||
        pending.requestId !== evidence.requestId ||
        pending.attemptNumber !== evidence.attemptNumber ||
        evidence.invocationId !== `approval:${pending.approvalId}` ||
        pending.registration !== registration ||
        registration.pluginId !== evidence.pluginId ||
        !artifactGenerationIsCurrent(evidence.accountId, pending.generation) ||
        canonicalResults.has(evidence.resultRef)
      ) {
        return null;
      }
      const manifest = getPluginManifest(registration.pluginId);
      if (
        !manifest ||
        !(await revalidateAuthorizations({
          accountId: evidence.accountId,
          manifest,
          authorizations: pending.authorizations,
        })) ||
        !artifactGenerationIsCurrent(evidence.accountId, pending.generation)
      ) {
        return null;
      }
      let drafts: readonly JarvisArtifactDraft[];
      try {
        drafts =
          registration.pluginId === 'gmail'
            ? gmailArtifactDrafts({ evidence, registration, result })
            : registration.pluginId === 'google-drive'
              ? googleDriveArtifactDrafts({ evidence, registration, result })
              : registration.pluginId === 'canva'
                ? canvaArtifactDrafts({ evidence, registration, result })
                : githubArtifactDrafts({ evidence, registration, result });
      } catch {
        return null;
      }
      const record = Object.freeze({
        evidence,
        registration,
        executor: registeredTools,
        authorizations: pending.authorizations,
        generation: pending.generation,
      });
      retainBounded(canonicalResults, evidence.resultRef, record);
      return drafts;
    },
    invalidateAccount(accountId: string) {
      accountGenerations.set(accountId, Object.freeze({}));
      for (const [result, pending] of pendingCanonicalResults) {
        if (pending.accountId === accountId) pendingCanonicalResults.delete(result);
      }
      for (const [resultRef, record] of canonicalResults) {
        if (record.evidence.accountId === accountId) canonicalResults.delete(resultRef);
      }
    },
    invalidateAll() {
      permanentlyRevoked = true;
      runtimeGeneration = Object.freeze({});
      accountGenerations.clear();
      pendingCanonicalResults.clear();
      canonicalResults.clear();
    },
  });

  return Object.freeze({ management, registeredTools, canonicalArtifacts });
}

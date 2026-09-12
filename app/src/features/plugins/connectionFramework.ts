import { PLUGIN_CATALOG } from './catalog';
import { PLUGIN_COMPATIBILITY_BY_ID } from './compatibilityMatrix';

export type NormalizedPluginConnectionState =
  | 'connect'
  | 'connecting'
  | 'awaiting_approval'
  | 'connected'
  | 'reauthorize'
  | 'expired'
  | 'error'
  | 'disconnecting';

export type PluginConnectionPath =
  | 'native_oauth_pkce'
  | 'hosted_oauth'
  | 'device_authorization'
  | 'app_installation'
  | 'official_connector'
  | 'manual_credential'
  | 'unsupported';

export interface PluginConnectionAdapter {
  readonly pluginId: string;
  readonly path: PluginConnectionPath;
  readonly authorizationUrl?: string;
  readonly documentationUrl: string;
  readonly scopes: readonly string[];
  readonly canConnect: boolean;
  readonly productionReady: boolean;
  readonly manualFallback: boolean;
  readonly prerequisites: readonly string[];
}

function adapterFor(pluginId: string): PluginConnectionAdapter {
  const plugin = PLUGIN_CATALOG.find((candidate) => candidate.id === pluginId);
  const compatibility = PLUGIN_COMPATIBILITY_BY_ID[pluginId];
  if (!plugin || !compatibility) throw new Error(`Unknown plugin '${pluginId}'.`);
  const path: PluginConnectionPath =
    plugin.connectionStrategy === 'device_authorization'
      ? 'device_authorization'
      : plugin.connectionStrategy === 'app_installation'
        ? 'app_installation'
        : plugin.connectionStrategy === 'hosted_oauth'
          ? 'hosted_oauth'
          : plugin.connectionStrategy === 'native_oauth_pkce'
            ? 'native_oauth_pkce'
            : compatibility.connectionClass === 'official_one_click'
              ? 'native_oauth_pkce'
              : compatibility.connectionClass === 'official_backend'
                ? 'hosted_oauth'
                : compatibility.connectionClass === 'official_connector'
                  ? 'official_connector'
                  : compatibility.connectionClass === 'manual_credential'
                    ? 'manual_credential'
                    : 'unsupported';
  return Object.freeze({
    pluginId,
    path,
    authorizationUrl: plugin.authorizationUrl,
    documentationUrl: compatibility.officialDocumentation,
    scopes: compatibility.requiredScopes,
    canConnect:
      path === 'manual_credential' || path === 'official_connector' || compatibility.oneClickReady,
    productionReady:
      path === 'manual_credential' || path === 'official_connector' || compatibility.oneClickReady,
    manualFallback: compatibility.coverageDisposition === 'shipped_manual',
    prerequisites: compatibility.externalPrerequisites,
  });
}

export const PLUGIN_CONNECTION_ADAPTERS: Readonly<Record<string, PluginConnectionAdapter>> =
  Object.freeze(
    Object.fromEntries(PLUGIN_CATALOG.map((plugin) => [plugin.id, adapterFor(plugin.id)])),
  );

export interface PkceRequest {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly challenge: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export async function createPkceRequest(
  cryptoApi: Pick<Crypto, 'getRandomValues' | 'subtle'> = crypto,
): Promise<PkceRequest> {
  const verifierBytes = cryptoApi.getRandomValues(new Uint8Array(48));
  const stateBytes = cryptoApi.getRandomValues(new Uint8Array(32));
  const nonceBytes = cryptoApi.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(verifierBytes);
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Object.freeze({
    state: base64Url(stateBytes),
    nonce: base64Url(nonceBytes),
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
  });
}

export function validateOAuthCallback(input: {
  callbackUrl: string;
  expectedRedirectUrl: string;
  expectedState: string;
}): Readonly<{ code: string }> {
  const callback = new URL(input.callbackUrl);
  const expected = new URL(input.expectedRedirectUrl);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname
  ) {
    throw new Error('OAuth redirect did not match the registered callback.');
  }
  if (callback.searchParams.get('state') !== input.expectedState) {
    throw new Error('OAuth state validation failed.');
  }
  if (
    callback.searchParams.has('access_token') ||
    callback.searchParams.has('id_token') ||
    callback.hash.includes('access_token=') ||
    callback.hash.includes('id_token=')
  ) {
    throw new Error('OAuth callback exposed token material instead of an authorization code.');
  }
  if (callback.searchParams.has('error')) throw new Error('OAuth authorization was declined.');
  const code = callback.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('OAuth callback did not include a valid code.');
  return Object.freeze({ code });
}

export interface PluginConsent {
  readonly pluginId: string;
  readonly service: string;
  readonly scopes: readonly string[];
  readonly capabilities: readonly string[];
  readonly highRiskScopes: readonly string[];
}

export function pluginConsent(pluginId: string): PluginConsent {
  const plugin = PLUGIN_CATALOG.find((candidate) => candidate.id === pluginId);
  const compatibility = PLUGIN_COMPATIBILITY_BY_ID[pluginId];
  if (!plugin || !compatibility) throw new Error(`Unknown plugin '${pluginId}'.`);
  return Object.freeze({
    pluginId,
    service: plugin.name,
    scopes: compatibility.requiredScopes,
    highRiskScopes: compatibility.highRiskScopes,
    capabilities: Object.freeze(plugin.tools.map((tool) => tool.description)),
  });
}

/**
 * Trusted adapters exchange/revoke grants outside the renderer. Their receipts
 * deliberately contain no token material.
 */
export interface TrustedOAuthAdapter {
  complete(input: {
    pluginId: string;
    code: string;
    verifier: string;
    nonce: string;
    requiredScopes: readonly string[];
    redirectUrl: string;
  }): Promise<Readonly<{ accountLabel?: string; expiresAt?: number }>>;
  revoke(pluginId: string): Promise<void>;
}

/** Native/backend boundary for grants. Renderer code receives receipts only. */
export interface TrustedPluginCredentialStore {
  saveGrant(input: {
    pluginId: string;
    accountId: string;
    credential: unknown;
  }): Promise<Readonly<{ accountLabel?: string; expiresAt?: number }>>;
  deleteGrant(pluginId: string, accountId: string): Promise<void>;
}

export interface SafeConnectionReceipt {
  readonly accountLabel?: string;
  readonly expiresAt?: number;
}

export interface TrustedDeviceAuthorizationAdapter {
  begin(pluginId: string): Promise<
    Readonly<{
      handle: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      pollIntervalMs: number;
    }>
  >;
  poll(
    handle: string,
  ): Promise<
    | Readonly<{ state: 'pending' }>
    | Readonly<{ state: 'connected'; receipt: SafeConnectionReceipt }>
    | Readonly<{ state: 'declined' | 'expired' }>
  >;
  cancel(handle: string): Promise<void>;
}

/** Cancellable device-code flow with bounded polling and no token surface. */
export class PluginDeviceAuthorizationSession {
  readonly pluginId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
  private readonly handle: string;
  private cancelled = false;

  private constructor(
    pluginId: string,
    result: Awaited<ReturnType<TrustedDeviceAuthorizationAdapter['begin']>>,
  ) {
    this.pluginId = pluginId;
    this.handle = result.handle;
    this.userCode = result.userCode;
    this.verificationUri = result.verificationUri;
    this.expiresAt = result.expiresAt;
    this.pollIntervalMs = Math.max(1_000, result.pollIntervalMs);
  }

  static async create(
    pluginId: string,
    adapter: TrustedDeviceAuthorizationAdapter,
  ): Promise<PluginDeviceAuthorizationSession> {
    const definition = PLUGIN_CONNECTION_ADAPTERS[pluginId];
    if (!definition) throw new Error(`Unknown plugin '${pluginId}'.`);
    return new PluginDeviceAuthorizationSession(pluginId, await adapter.begin(pluginId));
  }

  async poll(
    adapter: TrustedDeviceAuthorizationAdapter,
    now = Date.now(),
  ): Promise<Awaited<ReturnType<TrustedDeviceAuthorizationAdapter['poll']>>> {
    if (this.cancelled) throw new Error('Device authorization is no longer active.');
    if (now >= this.expiresAt) return Object.freeze({ state: 'expired' as const });
    return adapter.poll(this.handle);
  }

  async cancel(adapter: TrustedDeviceAuthorizationAdapter): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    await adapter.cancel(this.handle);
  }
}

export interface TrustedAppInstallationAdapter {
  begin(
    pluginId: string,
  ): Promise<Readonly<{ installUrl: string; handle: string; expiresAt: number }>>;
  complete(handle: string): Promise<SafeConnectionReceipt>;
  cancel(handle: string): Promise<void>;
}

export class PluginAppInstallationSession {
  private active = true;
  private constructor(
    readonly pluginId: string,
    readonly installUrl: string,
    readonly expiresAt: number,
    private readonly handle: string,
  ) {}

  static async create(pluginId: string, adapter: TrustedAppInstallationAdapter) {
    if (!PLUGIN_CONNECTION_ADAPTERS[pluginId]) throw new Error(`Unknown plugin '${pluginId}'.`);
    const started = await adapter.begin(pluginId);
    const url = new URL(started.installUrl);
    if (url.protocol !== 'https:') throw new Error('App installation must use HTTPS.');
    return new PluginAppInstallationSession(
      pluginId,
      url.toString(),
      started.expiresAt,
      started.handle,
    );
  }

  async complete(adapter: TrustedAppInstallationAdapter, now = Date.now()) {
    if (!this.active) throw new Error('App installation is no longer active.');
    this.active = false;
    if (now >= this.expiresAt) throw new Error('App installation timed out.');
    return adapter.complete(this.handle);
  }

  async cancel(adapter: TrustedAppInstallationAdapter) {
    if (!this.active) return;
    this.active = false;
    await adapter.cancel(this.handle);
  }
}

export class PluginOAuthSession {
  readonly pluginId: string;
  readonly redirectUrl: string;
  readonly pkce: PkceRequest;
  readonly createdAt: number;
  private completed = false;

  private constructor(input: {
    pluginId: string;
    redirectUrl: string;
    pkce: PkceRequest;
    createdAt: number;
  }) {
    this.pluginId = input.pluginId;
    this.redirectUrl = input.redirectUrl;
    this.pkce = input.pkce;
    this.createdAt = input.createdAt;
  }

  static async create(input: {
    pluginId: string;
    redirectUrl: string;
    now?: number;
    cryptoApi?: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  }): Promise<PluginOAuthSession> {
    const adapter = PLUGIN_CONNECTION_ADAPTERS[input.pluginId];
    if (!adapter || (adapter.path !== 'native_oauth_pkce' && adapter.path !== 'hosted_oauth')) {
      throw new Error('This plugin does not use the OAuth connection framework.');
    }
    const redirect = new URL(input.redirectUrl);
    if (
      redirect.protocol !== 'https:' &&
      redirect.hostname !== '127.0.0.1' &&
      redirect.hostname !== '[::1]'
    ) {
      throw new Error('OAuth callback must use HTTPS or an exact loopback address.');
    }
    return new PluginOAuthSession({
      pluginId: input.pluginId,
      redirectUrl: redirect.toString(),
      pkce: await createPkceRequest(input.cryptoApi),
      createdAt: input.now ?? Date.now(),
    });
  }

  async complete(input: {
    callbackUrl: string;
    trustedAdapter: TrustedOAuthAdapter;
    now?: number;
    timeoutMs?: number;
  }): Promise<Readonly<{ accountLabel?: string; expiresAt?: number }>> {
    if (this.completed) throw new Error('OAuth session is no longer active.');
    this.completed = true;
    if ((input.now ?? Date.now()) - this.createdAt > (input.timeoutMs ?? 10 * 60_000)) {
      throw new Error('OAuth authorization timed out.');
    }
    const { code } = validateOAuthCallback({
      callbackUrl: input.callbackUrl,
      expectedRedirectUrl: this.redirectUrl,
      expectedState: this.pkce.state,
    });
    return input.trustedAdapter.complete({
      pluginId: this.pluginId,
      code,
      verifier: this.pkce.verifier,
      nonce: this.pkce.nonce,
      requiredScopes: PLUGIN_CONNECTION_ADAPTERS[this.pluginId]?.scopes ?? [],
      redirectUrl: this.redirectUrl,
    });
  }

  cancel(): void {
    this.completed = true;
  }
}

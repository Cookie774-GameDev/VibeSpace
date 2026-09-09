import { nativeFetch } from '@/lib/nativeFetch';
import type { PluginAuthorizationAuthority, PluginAuthorizationStartResult } from './runtime';

/** Registered public application identifier; intentionally shipped, never a client secret. */
export const VIBESPACE_GITHUB_OAUTH_CLIENT_ID = 'Ov23li5E2zk5XnjmrKTE';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_VERIFICATION_URL = 'https://github.com/login/device';
const GITHUB_OAUTH_DOCUMENTATION_URL =
  'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps';

type RequestLike = (
  input: string,
  init?: RequestInit & Readonly<{ timeoutMs?: number }>,
) => Promise<Response>;

interface ConnectedCredential {
  accountId: string;
  pluginId: 'github';
  credential: string;
}

interface GitHubDeviceAuthorizationDependencies {
  clientId?: string;
  request?: RequestLike;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  onConnected(input: ConnectedCredential): Promise<void>;
  onFailed(input: { accountId: string; pluginId: 'github'; error: string }): Promise<void>;
}

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

function unavailable(): PluginAuthorizationStartResult {
  return {
    ok: false,
    error: 'GitHub authorization requires a registered VibeSpace OAuth client.',
    setupUrl: GITHUB_OAUTH_DOCUMENTATION_URL,
  };
}

function invalidResponse(): PluginAuthorizationStartResult {
  return {
    ok: false,
    error: 'GitHub returned an invalid authorization response.',
    setupUrl: GITHUB_OAUTH_DOCUMENTATION_URL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength)
    return undefined;
  return value;
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse | undefined {
  if (!isRecord(value)) return undefined;
  const deviceCode = boundedString(value.device_code, 512);
  const userCode = boundedString(value.user_code, 64);
  const verificationUri = boundedString(value.verification_uri, 256);
  const expiresInSeconds = value.expires_in;
  const intervalSeconds = value.interval;
  if (
    !deviceCode ||
    !userCode ||
    verificationUri !== GITHUB_VERIFICATION_URL ||
    typeof expiresInSeconds !== 'number' ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 3_600 ||
    typeof intervalSeconds !== 'number' ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < 1 ||
    intervalSeconds > 60
  ) {
    return undefined;
  }
  return { deviceCode, userCode, expiresInSeconds, intervalSeconds };
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) throw new Error('invalid_provider_response');
  return response.json();
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sessionKey(accountId: string, pluginId: string): string {
  return `${accountId}\u0000${pluginId}`;
}

export function createGitHubDeviceAuthorizationAuthority(
  dependencies: GitHubDeviceAuthorizationDependencies,
): PluginAuthorizationAuthority {
  const request: RequestLike = dependencies.request ?? ((url, init) => nativeFetch(url, init));
  const wait = dependencies.wait ?? defaultWait;
  const now = dependencies.now ?? Date.now;
  const activeSessions = new Map<string, AbortController>();

  const poll = async (input: {
    accountId: string;
    deviceCode: string;
    clientId: string;
    intervalSeconds: number;
    expiresAt: number;
    controller: AbortController;
  }): Promise<void> => {
    let intervalSeconds = input.intervalSeconds;
    try {
      while (!input.controller.signal.aborted && now() < input.expiresAt) {
        await wait(intervalSeconds * 1_000, input.controller.signal);
        if (input.controller.signal.aborted) return;
        const response = await request(GITHUB_ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: input.clientId,
            device_code: input.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }).toString(),
          signal: input.controller.signal,
          timeoutMs: 15_000,
        });
        if (!response.ok) throw new Error('provider_request_failed');
        const payload = await readJson(response);
        if (input.controller.signal.aborted) return;
        if (!isRecord(payload)) throw new Error('invalid_provider_response');
        const token = boundedString(payload.access_token, 1_024);
        if (token && payload.token_type === 'bearer') {
          await dependencies.onConnected({
            accountId: input.accountId,
            pluginId: 'github',
            credential: token,
          });
          return;
        }
        if (payload.error === 'authorization_pending') continue;
        if (payload.error === 'slow_down') {
          intervalSeconds = Math.min(intervalSeconds + 5, 60);
          continue;
        }
        if (payload.error === 'access_denied') throw new Error('GitHub authorization was denied.');
        if (payload.error === 'expired_token')
          throw new Error('GitHub authorization expired. Try again.');
        throw new Error('GitHub authorization failed. Try again.');
      }
      if (!input.controller.signal.aborted)
        throw new Error('GitHub authorization expired. Try again.');
    } catch (error) {
      if (input.controller.signal.aborted) return;
      const safeError =
        error instanceof Error && error.message.startsWith('GitHub authorization')
          ? error.message
          : 'GitHub authorization failed. Try again.';
      await dependencies.onFailed({
        accountId: input.accountId,
        pluginId: 'github',
        error: safeError,
      });
    } finally {
      const key = sessionKey(input.accountId, 'github');
      if (activeSessions.get(key) === input.controller) activeSessions.delete(key);
    }
  };

  return Object.freeze({
    async begin(
      input: Parameters<PluginAuthorizationAuthority['begin']>[0],
    ): Promise<PluginAuthorizationStartResult> {
      if (input.pluginId !== 'github' || input.path !== 'device_authorization') {
        return {
          ok: false,
          error: 'Provider authorization is not registered for this plugin.',
        };
      }
      const clientId = dependencies.clientId?.trim();
      if (!clientId || !/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) return unavailable();

      const key = sessionKey(input.accountId, input.pluginId);
      activeSessions.get(key)?.abort();
      const controller = new AbortController();
      activeSessions.set(key, controller);
      try {
        const response = await request(GITHUB_DEVICE_CODE_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: clientId,
            scope: input.scopes.join(' '),
          }).toString(),
          signal: controller.signal,
          timeoutMs: 15_000,
        });
        if (!response.ok) throw new Error('provider_request_failed');
        const device = parseDeviceCodeResponse(await readJson(response));
        if (controller.signal.aborted)
          return { ok: false, error: 'GitHub authorization was cancelled.' };
        if (!device) {
          if (activeSessions.get(key) === controller) activeSessions.delete(key);
          return invalidResponse();
        }
        void poll({
          accountId: input.accountId,
          deviceCode: device.deviceCode,
          clientId,
          intervalSeconds: device.intervalSeconds,
          expiresAt: now() + device.expiresInSeconds * 1_000,
          controller,
        });
        return {
          ok: true,
          state: 'awaiting_approval',
          authorizationUrl: GITHUB_VERIFICATION_URL,
          userCode: device.userCode,
        };
      } catch {
        if (activeSessions.get(key) === controller) activeSessions.delete(key);
        return invalidResponse();
      }
    },

    async cancel(input: Parameters<PluginAuthorizationAuthority['cancel']>[0]): Promise<void> {
      const key = sessionKey(input.accountId, input.pluginId);
      activeSessions.get(key)?.abort();
      activeSessions.delete(key);
    },
  });
}

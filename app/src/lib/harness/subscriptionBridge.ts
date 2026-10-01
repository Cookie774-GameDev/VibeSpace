import type {
  OpenCodeHttpClient,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthorization,
} from './openCodeClient';

export type OpenCodeSubscriptionClient = Pick<
  OpenCodeHttpClient,
  | 'providerAuthMethods'
  | 'providerStatus'
  | 'authorizeProvider'
  | 'callbackProvider'
  | 'configProviders'
>;

export interface OpenCodeSubscriptionRoute {
  providerId: string;
  displayName: string;
  methodIndex: number;
  label: string;
  prompts?: OpenCodeProviderAuthMethod['prompts'];
  providerAvailable: boolean;
}

export interface OpenCodeSubscriptionSnapshot {
  routes: readonly OpenCodeSubscriptionRoute[];
  anthropicPolicy: string;
}

export interface OpenCodeSubscriptionSelection {
  providerId: string;
  methodIndex: number;
  label: string;
}

export type OpenCodeSubscriptionResult =
  | { kind: 'connected'; instructions: string }
  | {
      kind: 'code_required';
      providerId: string;
      methodIndex: number;
      instructions: string;
    };

const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  gitlab: 'GitLab Duo',
  xai: 'xAI',
});

export const ANTHROPIC_SUBSCRIPTION_POLICY =
  'Claude Pro/Max subscription bridge is not offered here. Use an Anthropic API key or another legitimate provider route.';

function providerDisplayName(providerId: string): string {
  return (
    DISPLAY_NAMES[providerId] ??
    providerId
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(' ')
  );
}

function requireSafeAuthorizationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenCode returned an unsafe authorization URL.');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('OpenCode returned an unsafe authorization URL.');
  }
  return url.toString();
}

async function refreshProviderTruth(client: OpenCodeSubscriptionClient): Promise<void> {
  await client.providerStatus();
  await client.configProviders();
}

export async function discoverOpenCodeSubscriptions(
  client: OpenCodeSubscriptionClient,
): Promise<OpenCodeSubscriptionSnapshot> {
  const [methods, status] = await Promise.all([
    client.providerAuthMethods(),
    client.providerStatus(),
  ]);
  const connected = new Set(status.connected);
  const routes: OpenCodeSubscriptionRoute[] = [];

  for (const [providerId, providerMethods] of Object.entries(methods)) {
    if (providerId.toLowerCase() === 'anthropic') continue;
    providerMethods.forEach((method, methodIndex) => {
      if (method.type !== 'oauth') return;
      routes.push({
        providerId,
        displayName: providerDisplayName(providerId),
        methodIndex,
        label: method.label,
        ...(method.prompts ? { prompts: method.prompts } : {}),
        providerAvailable: connected.has(providerId),
      });
    });
  }
  routes.sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) || left.methodIndex - right.methodIndex,
  );
  return { routes, anthropicPolicy: ANTHROPIC_SUBSCRIPTION_POLICY };
}

async function finishCallback(
  client: OpenCodeSubscriptionClient,
  providerId: string,
  methodIndex: number,
  code?: string,
): Promise<boolean> {
  const completed = await client.callbackProvider(providerId, methodIndex, code);
  if (!completed) throw new Error('OpenCode could not complete provider authentication.');
  await refreshProviderTruth(client);
  return true;
}

export async function beginOpenCodeSubscription(
  client: OpenCodeSubscriptionClient,
  selection: OpenCodeSubscriptionSelection,
  openUrl: (url: string) => Promise<void>,
  inputs?: Readonly<Record<string, string>>,
): Promise<OpenCodeSubscriptionResult> {
  const authorization: OpenCodeProviderAuthorization = await client.authorizeProvider(
    selection.providerId,
    selection.methodIndex,
    inputs,
  );
  await openUrl(requireSafeAuthorizationUrl(authorization.url));
  if (authorization.method === 'code') {
    return {
      kind: 'code_required',
      providerId: selection.providerId,
      methodIndex: selection.methodIndex,
      instructions: authorization.instructions,
    };
  }
  await finishCallback(client, selection.providerId, selection.methodIndex);
  return { kind: 'connected', instructions: authorization.instructions };
}

export async function completeOpenCodeSubscription(
  client: OpenCodeSubscriptionClient,
  pending: Extract<OpenCodeSubscriptionResult, { kind: 'code_required' }>,
  rawCode: string,
): Promise<boolean> {
  const code = rawCode.trim();
  if (!code || code.length > 4_096 || code.includes('\u0000')) {
    throw new Error('Enter the authorization code returned by the provider.');
  }
  return finishCallback(client, pending.providerId, pending.methodIndex, code);
}

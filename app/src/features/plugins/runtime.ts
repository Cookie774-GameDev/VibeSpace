import { nativeFetch } from '@/lib/nativeFetch';
import { getPluginManifest } from './catalog';
import { getPluginCredential } from './credentials';
import type { PluginHttpTest, PluginManifest, PluginTestResult } from './types';
import { isConnectableStatus } from './types';

type CredentialMap = Record<string, string>;

async function credentialsFor(pluginId: string): Promise<CredentialMap> {
  const manifest = getPluginManifest(pluginId);
  if (!manifest) return {};
  const entries = await Promise.all(
    manifest.fields.map(
      async (field) => [field.id, await getPluginCredential(pluginId, field.id)] as const,
    ),
  );
  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
}

function readableError(status: number, body: string): string {
  const detail = body.trim().slice(0, 180);
  return detail
    ? `Connection rejected (${status}): ${detail}`
    : `Connection rejected with HTTP ${status}.`;
}

function required(values: CredentialMap, key: string, label: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function normalizeStoreDomain(raw: string): string {
  const store = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store)) {
    throw new Error('Use the permanent store domain, for example your-store.myshopify.com.');
  }
  return store;
}

function mailchimpDatacenter(apiKey: string): string {
  const suffix = apiKey.trim().split('-').pop();
  if (!suffix || !/^[a-z]{2}\d+$/i.test(suffix)) {
    throw new Error('Mailchimp API key must include a datacenter suffix, for example ...-us1.');
  }
  return suffix.toLowerCase();
}

function substitute(template: string, values: CredentialMap, manifest: PluginManifest): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key === 'store') return normalizeStoreDomain(required(values, 'store', 'Store domain'));
    if (key === 'basic_email_key') {
      const email = required(values, 'email', 'Account email');
      const apiKey = required(values, 'api_key', 'Management API key');
      return btoa(`${email}:${apiKey}`);
    }
    if (key === 'basic_auth') {
      const accountSid = required(values, 'account_sid', 'Account SID');
      const authToken = required(values, 'auth_token', 'Auth token');
      return btoa(`${accountSid}:${authToken}`);
    }
    if (key === 'stripe_basic') {
      const secretKey = required(values, 'secret_key', 'Secret key');
      return btoa(`${secretKey}:`);
    }
    if (key === 'datacenter') {
      return mailchimpDatacenter(required(values, 'api_key', 'API key'));
    }
    if (key === 'mongo_basic') {
      const publicKey = required(values, 'public_key', 'Public key');
      const privateKey = required(values, 'private_key', 'Private key');
      return btoa(`${publicKey}:${privateKey}`);
    }
    if (key === 'woo_basic') {
      const consumerKey = required(values, 'consumer_key', 'Consumer key');
      const consumerSecret = required(values, 'consumer_secret', 'Consumer secret');
      return btoa(`${consumerKey}:${consumerSecret}`);
    }
    if (key === 'chargebee_basic') {
      const apiKey = required(values, 'api_key', 'API key');
      return btoa(`${apiKey}:`);
    }
    if (key === 'wp_basic') {
      const username = required(values, 'username', 'Username');
      const appPassword = required(values, 'app_password', 'Application password');
      return btoa(`${username}:${appPassword}`);
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
      const [, prop, index] = match;
      const list = (current as Record<string, unknown>)[prop];
      return Array.isArray(list) ? list[Number(index)] : undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, data);
}

async function requestProbe(
  url: string,
  init: RequestInit,
  acceptEmpty?: boolean,
): Promise<{ data: Record<string, unknown>; hostname?: string }> {
  const response = await nativeFetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  const body = await response.text();
  if (!response.ok && !acceptEmpty) throw new Error(readableError(response.status, body));
  if (!body.trim()) {
    return { data: {}, hostname: safeHostname(url) };
  }
  try {
    return { data: JSON.parse(body) as Record<string, unknown>, hostname: safeHostname(url) };
  } catch {
    if (acceptEmpty && response.ok) return { data: {}, hostname: safeHostname(url) };
    throw new Error('Provider returned a non-JSON response.');
  }
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function runHttpTest(
  manifest: PluginManifest,
  values: CredentialMap,
  test: PluginHttpTest,
): Promise<PluginTestResult> {
  const url = substitute(test.url, values, manifest);
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(test.headers ?? {})) {
    headers[header] = substitute(value, values, manifest);
  }
  const init: RequestInit = {
    method: test.method ?? 'GET',
    headers,
  };
  if (test.body) init.body = substitute(test.body, values, manifest);

  const { data, hostname } = await requestProbe(url, init, test.acceptEmpty);

  if (Object.prototype.hasOwnProperty.call(data, 'ok') && data.ok !== true) {
    throw new Error(String(data.error ?? 'Provider rejected the credentials.'));
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
        ? 'Manual Setup Required: complete OAuth authorization in the provider console, then return and test again.'
        : 'Manual Setup Required: credentials saved. Complete provider setup using the official link, then test when automated validation is available.',
  };
}

export async function testPluginConnection(pluginId: string): Promise<PluginTestResult> {
  try {
    const manifest = getPluginManifest(pluginId);
    if (!manifest) return { ok: false, error: 'Unknown plugin.' };

    if (pluginId === 'mock-connector' || manifest.authType === 'none') {
      return { ok: true, accountLabel: 'Local test connector' };
    }

    const values = await credentialsFor(pluginId);
    for (const field of manifest.fields) {
      if (field.required && !values[field.id]?.trim()) {
        throw new Error(`${field.label} is required.`);
      }
    }

    if (manifest.httpTest) {
      return await runHttpTest(manifest, values, manifest.httpTest);
    }

    if (manifest.authType === 'oauth') {
      return { ok: true, accountLabel: manifest.provider };
    }

    if (
      manifest.status === 'needs_credentials' ||
      manifest.status === 'blocked' ||
      manifest.authType === 'service_account'
    ) {
      return manualSetupResult(manifest);
    }

    return { ok: false, error: 'This catalog entry does not have a live connector yet.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function callPluginTool(
  pluginId: string,
  toolName: string,
): Promise<Record<string, unknown>> {
  const manifest = getPluginManifest(pluginId);
  if (!manifest || !isConnectableStatus(manifest.status)) {
    throw new Error('Plugin is not available.');
  }
  if (manifest.status === 'needs_credentials' || manifest.status === 'blocked') {
    throw new Error('Plugin requires manual setup before tools can run.');
  }
  const tool = manifest.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown plugin tool: ${toolName}`);
  if (pluginId === 'mock-connector' && toolName === 'ping') {
    return { ok: true, pluginId, tool: toolName, message: 'pong' };
  }
  if (toolName === 'list_tools') {
    return {
      ok: true,
      tools: manifest.tools.map(({ name, description, readOnly }) => ({
        name,
        description,
        readOnly,
      })),
    };
  }
  const test = await testPluginConnection(pluginId);
  if (!test.ok) throw new Error(test.error ?? 'Plugin connection failed.');
  return {
    ok: true,
    pluginId,
    tool: toolName,
    accountLabel: test.accountLabel,
    capabilityOnly: true,
  };
}

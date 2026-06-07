import { nativeFetch } from '@/lib/nativeFetch';
import { getPluginManifest } from './catalog';
import { getPluginCredential } from './credentials';
import type { PluginTestResult } from './types';

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

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await nativeFetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(readableError(response.status, body));
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function required(values: CredentialMap, key: string, label: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

export async function testPluginConnection(pluginId: string): Promise<PluginTestResult> {
  try {
    const values = await credentialsFor(pluginId);
    switch (pluginId) {
      case 'mock-connector':
        return { ok: true, accountLabel: 'Local test connector' };
      case 'github': {
        const data = await requestJson('https://api.github.com/user', {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${required(values, 'token', 'Personal access token')}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        return { ok: true, accountLabel: String(data.login ?? 'GitHub account') };
      }
      case 'figma': {
        const data = await requestJson('https://api.figma.com/v1/me', {
          headers: { 'X-Figma-Token': required(values, 'token', 'Personal access token') },
        });
        return { ok: true, accountLabel: String(data.email ?? data.handle ?? 'Figma account') };
      }
      case 'supabase': {
        const url = required(values, 'url', 'Project URL').replace(/\/+$/, '');
        const key = required(values, 'key', 'Project API key');
        new URL(url);
        await requestJson(`${url}/rest/v1/`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        return { ok: true, accountLabel: new URL(url).hostname };
      }
      case 'shopify': {
        const rawStore = required(values, 'store', 'Store domain');
        const store = rawStore.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(store)) {
          throw new Error('Use the permanent store domain, for example your-store.myshopify.com.');
        }
        const data = await requestJson(`https://${store}/admin/api/2026-04/shop.json`, {
          headers: {
            'X-Shopify-Access-Token': required(values, 'token', 'Admin API access token'),
          },
        });
        const shop =
          data.shop && typeof data.shop === 'object' ? (data.shop as Record<string, unknown>) : {};
        return { ok: true, accountLabel: String(shop.name ?? store) };
      }
      case 'slack': {
        const token = required(values, 'token', 'Slack token');
        const data = await requestJson('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
        if (data.ok !== true) throw new Error(String(data.error ?? 'Slack rejected the token.'));
        return { ok: true, accountLabel: String(data.team ?? data.user ?? 'Slack workspace') };
      }
      default:
        return { ok: false, error: 'This catalog entry does not have a live connector yet.' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function callPluginTool(
  pluginId: string,
  toolName: string,
): Promise<Record<string, unknown>> {
  const manifest = getPluginManifest(pluginId);
  if (!manifest || manifest.status !== 'implemented') throw new Error('Plugin is not implemented.');
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

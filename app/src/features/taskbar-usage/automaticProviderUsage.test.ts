import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import { buildAutomaticProviderSnapshots } from './automaticProviderUsage';

function connection(
  id: string,
  providerId: string,
  mode: ProviderConnection['mode'],
): ProviderConnection {
  return {
    id,
    providerId,
    displayName: id,
    adapterId: id,
    mode,
    authSource: mode === 'external-cli' ? 'local-cli' : 'api-key',
    promptTransport: 'native-system',
    enabled: true,
    capabilities: {
      text: true,
      images: false,
      files: false,
      tools: false,
      modelSelection: false,
      structuredOutput: false,
      streaming: true,
      cancellation: true,
      resumeSession: false,
      systemPrompt: true,
      workingDirectory: false,
      usage: false,
      subscriptionQuota: false,
      localOnly: mode !== 'native-api',
    },
  };
}

describe('automatic provider usage discovery', () => {
  it('uses sanitized connection state and never needs or returns raw credentials', () => {
    const snapshots = buildAutomaticProviderSnapshots({
      connections: [
        connection('openai-api', 'openai', 'native-api'),
        connection('codex-cli', 'openai', 'external-cli'),
        connection('claude-cli', 'anthropic', 'external-cli'),
      ],
      connectedProviderIds: ['openai'],
      connectionMetadata: {
        'codex-cli': { installation: 'installed', auth: 'authenticated' },
        'claude-cli': { installation: 'not-installed', auth: 'unknown' },
      },
      localUsage: {
        openai: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 2,
          costUsd: 0.01,
          calls: 1,
          lastUsed: 100,
        },
      },
      connectionUsage: {
        'codex-cli': {
          inputTokens: 6,
          outputTokens: 3,
          cachedTokens: 1,
          costUsd: 0,
          calls: 1,
          lastUsed: 150,
        },
      },
      activity: { total: 2, byProvider: { 'codex-cli': 1, openai: 1 } },
      now: 200,
    });

    expect(snapshots.map(({ providerId }) => providerId)).toEqual(['openai-api', 'codex-cli']);
    expect(snapshots[0]).toMatchObject({
      providerFamilyId: 'openai',
      routeType: 'api_key',
      connectionState: 'connected',
      usageValue: 17,
      usageLimit: null,
      usagePercent: null,
      activeRequests: 1,
    });
    expect(snapshots[1]).toMatchObject({
      providerFamilyId: 'openai',
      routeType: 'cli_bridge',
      source: 'terminal-session',
      activeRequests: 1,
      usageValue: 10,
      localUsageValue: 10,
      usagePercent: null,
    });
    expect(JSON.stringify(snapshots)).not.toContain('api-key');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeHttpClient } from './openCodeClient';
import {
  beginOpenCodeSubscription,
  completeOpenCodeSubscription,
  discoverOpenCodeSubscriptions,
} from './subscriptionBridge';

type SubscriptionClient = Pick<
  OpenCodeHttpClient,
  | 'providerAuthMethods'
  | 'providerStatus'
  | 'authorizeProvider'
  | 'callbackProvider'
  | 'configProviders'
>;

function client(overrides: Partial<SubscriptionClient> = {}): SubscriptionClient {
  return {
    providerAuthMethods: async () => ({
      openai: [
        { type: 'api', label: 'API key' },
        { type: 'oauth', label: 'ChatGPT Plus/Pro' },
      ],
      'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
      xai: [{ type: 'oauth', label: 'SuperGrok Subscription' }],
      gitlab: [{ type: 'oauth', label: 'GitLab OAuth' }],
      anthropic: [{ type: 'oauth', label: 'Claude Pro/Max plugin' }],
      'future-official': [{ type: 'oauth', label: 'Official subscription' }],
    }),
    providerStatus: async () => ({ connected: ['github-copilot'] }),
    authorizeProvider: async () => ({
      url: 'https://auth.example.test/device',
      method: 'auto',
      instructions: 'Open the authorization page and approve.',
    }),
    callbackProvider: async () => true,
    configProviders: async () => ({ providers: [] }),
    ...overrides,
  };
}

describe('OpenCode subscription bridge', () => {
  it('discovers official OAuth methods dynamically and never offers Anthropic Pro/Max', async () => {
    const snapshot = await discoverOpenCodeSubscriptions(client());

    expect(snapshot.routes).toEqual([
      expect.objectContaining({
        providerId: 'future-official',
        methodIndex: 0,
        providerAvailable: false,
      }),
      expect.objectContaining({
        providerId: 'github-copilot',
        displayName: 'GitHub Copilot',
        providerAvailable: true,
      }),
      expect.objectContaining({ providerId: 'gitlab', displayName: 'GitLab Duo' }),
      expect.objectContaining({
        providerId: 'openai',
        methodIndex: 1,
        displayName: 'OpenAI',
      }),
      expect.objectContaining({ providerId: 'xai', displayName: 'xAI' }),
    ]);
    expect(snapshot.routes.some((route) => route.providerId === 'anthropic')).toBe(false);
    expect(snapshot.anthropicPolicy).toContain('not offered');
  });

  it('opens an OpenCode authorization URL, completes auto auth, and refreshes provider truth', async () => {
    const calls: string[] = [];
    const bridgeClient = client({
      authorizeProvider: async (providerId, method) => {
        calls.push(`authorize:${providerId}:${method}`);
        return {
          url: 'https://github.com/login/device',
          method: 'auto',
          instructions: 'Enter ABCD-EFGH.',
        };
      },
      callbackProvider: async (providerId, method) => {
        calls.push(`callback:${providerId}:${method}`);
        return true;
      },
      providerStatus: async () => {
        calls.push('status');
        return { connected: ['github-copilot'] };
      },
      configProviders: async () => {
        calls.push('models');
        return {};
      },
    });

    await expect(
      beginOpenCodeSubscription(
        bridgeClient,
        {
          providerId: 'github-copilot',
          methodIndex: 0,
          label: 'GitHub Copilot',
        },
        async (url) => {
          calls.push(`open:${url}`);
        },
      ),
    ).resolves.toEqual({
      kind: 'connected',
      instructions: 'Enter ABCD-EFGH.',
    });
    expect(calls).toEqual([
      'authorize:github-copilot:0',
      'open:https://github.com/login/device',
      'callback:github-copilot:0',
      'status',
      'models',
    ]);
  });

  it('waits for an explicit code when OpenCode requires one', async () => {
    const callbackProvider = vi.fn(async () => true);
    const bridgeClient = client({
      authorizeProvider: async () => ({
        url: 'https://auth.example.test/',
        method: 'code',
        instructions: 'Paste the returned code.',
      }),
      callbackProvider,
    });

    const pending = await beginOpenCodeSubscription(
      bridgeClient,
      { providerId: 'openai', methodIndex: 1, label: 'ChatGPT Plus/Pro' },
      async () => undefined,
    );
    expect(pending).toEqual({
      kind: 'code_required',
      providerId: 'openai',
      methodIndex: 1,
      instructions: 'Paste the returned code.',
    });
    if (pending.kind !== 'code_required') throw new Error('expected a code flow');
    expect(callbackProvider).not.toHaveBeenCalled();

    await expect(completeOpenCodeSubscription(bridgeClient, pending, ' auth-code ')).resolves.toBe(
      true,
    );
    expect(callbackProvider).toHaveBeenCalledWith('openai', 1, 'auth-code');
  });

  it('rejects unsafe authorization URLs without exposing their contents', async () => {
    const unsafe = 'javascript:steal-secret-token';
    const bridgeClient = client({
      authorizeProvider: async () => ({
        url: unsafe,
        method: 'auto',
        instructions: 'approve',
      }),
    });

    await expect(
      beginOpenCodeSubscription(
        bridgeClient,
        { providerId: 'openai', methodIndex: 1, label: 'ChatGPT Plus/Pro' },
        async () => undefined,
      ),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toBe('OpenCode returned an unsafe authorization URL.');
      expect(error.message).not.toContain('secret-token');
      return true;
    });
  });
});

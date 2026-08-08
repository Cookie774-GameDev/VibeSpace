import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderConnection } from './adapters/types';
import { runExternalConnection } from './router';
import { providerActivityTracker } from '@/features/taskbar-usage/activityTracker';

const connection: ProviderConnection = {
  id: 'activity-cli',
  providerId: 'openai',
  displayName: 'Activity CLI',
  adapterId: 'activity-adapter',
  mode: 'external-cli',
  authSource: 'local-cli',
  promptTransport: 'prefixed-preamble',
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
    localOnly: true,
  },
};

describe('router taskbar usage lifecycle', () => {
  it('registers a real active request until the provider stream completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredProvider = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter: ProviderAdapter = {
      id: connection.adapterId,
      detect: async () => ({ status: 'available' }),
      probeAuth: async () => ({ status: 'authenticated' }),
      async *send() {
        entered();
        await gate;
        yield { type: 'text', delta: 'done' };
        yield { type: 'done' };
      },
    };

    const pending = runExternalConnection({
      connection,
      adapter,
      requestId: 'activity-request',
      prompt: 'hello',
    });
    await enteredProvider;
    const activeWhilePending = providerActivityTracker.snapshot().byProvider[connection.id];
    release();
    await pending;
    expect(activeWhilePending).toBe(1);
    expect(providerActivityTracker.snapshot().total).toBe(0);
  });
});

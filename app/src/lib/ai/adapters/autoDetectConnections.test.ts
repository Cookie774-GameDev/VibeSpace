import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderConnection } from './types';
import type { ConnectionMetadata } from '../connectionState';
import {
  createExternalConnectionAutoDetector,
  detectExternalConnectionStates,
} from './autoDetectConnections';

function connection(id: string, adapterId = `${id}-adapter`): Readonly<ProviderConnection> {
  return Object.freeze({
    id,
    adapterId,
    providerId: 'openai',
    displayName: id,
    mode: 'external-cli',
    authSource: 'test-session',
    capabilities: Object.freeze({
      text: true,
      images: false,
      files: false,
      tools: false,
      modelSelection: true,
      structuredOutput: true,
      streaming: true,
      cancellation: true,
      resumeSession: false,
      systemPrompt: false,
      workingDirectory: true,
      usage: true,
      subscriptionQuota: false,
      localOnly: false,
    }),
    promptTransport: 'prefixed-preamble',
    enabled: true,
  });
}

function dependencies(
  input: {
    connections?: readonly Readonly<ProviderConnection>[];
    adapters?: Readonly<Record<string, ProviderAdapter>>;
    current?: ConnectionMetadata;
    readMetadataRevision?: (connectionId: string) => number;
    write?: (metadata: ConnectionMetadata) => ConnectionMetadata;
    markSessionChecked?: (connectionIds: readonly string[]) => void;
    now?: number;
  } = {},
) {
  return {
    connections: input.connections ?? [connection('openai-codex')],
    adapters: input.adapters ?? {},
    readMetadata: () => input.current ?? {},
    readMetadataRevision: input.readMetadataRevision ?? (() => 0),
    writeMetadata: input.write ?? vi.fn((value: ConnectionMetadata) => value),
    markSessionChecked: input.markSessionChecked ?? vi.fn(),
    now: () => input.now ?? 123,
  };
}

describe('automatic external CLI connection detection', () => {
  it('uses only read-only detect and auth probes and publishes authenticated Codex state', async () => {
    const detect = vi.fn(async () => ({
      status: 'available' as const,
      executablePath: 'C:\\Tools\\codex.exe',
      version: 'codex-cli 9.9.9',
      detail: 'must not persist',
    }));
    const probeAuth = vi.fn(async () => ({
      status: 'authenticated' as const,
      accountLabel: 'private@example.com',
      detail: 'must not persist',
    }));
    const send = vi.fn();
    const write = vi.fn((value: ConnectionMetadata) => value);
    const markSessionChecked = vi.fn();
    const result = await detectExternalConnectionStates(
      dependencies({
        adapters: {
          'openai-codex-adapter': {
            id: 'openai-codex-adapter',
            detect,
            probeAuth,
            send,
          },
        },
        write,
        markSessionChecked,
      }),
    );

    expect(detect).toHaveBeenCalledOnce();
    expect(probeAuth).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        executablePath: 'C:\\Tools\\codex.exe',
        version: 'codex-cli 9.9.9',
        lastCheckedAt: 123,
      },
    });
    expect(JSON.stringify(write.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(write.mock.calls)).not.toContain('must not persist');
    expect(markSessionChecked).toHaveBeenCalledWith(['openai-codex']);
  });

  it('preserves disabled connections without touching their adapters', async () => {
    const detect = vi.fn();
    const probeAuth = vi.fn();
    const current: ConnectionMetadata = {
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        disabled: true,
        lastCheckedAt: 5,
      },
    };

    await expect(
      detectExternalConnectionStates(
        dependencies({
          adapters: {
            'openai-codex-adapter': { id: 'openai-codex-adapter', detect, probeAuth },
          },
          current,
        }),
      ),
    ).resolves.toEqual(current);
    expect(detect).not.toHaveBeenCalled();
    expect(probeAuth).not.toHaveBeenCalled();
  });

  it('lets a concurrent user disable win over an in-flight background scan', async () => {
    let release: (() => void) | undefined;
    const detect = vi.fn(
      () =>
        new Promise<{
          status: 'available';
          executablePath: string;
        }>((resolve) => {
          release = () =>
            resolve({
              status: 'available',
              executablePath: 'C:\\Tools\\codex.exe',
            });
        }),
    );
    let readCount = 0;
    const disabled: ConnectionMetadata = {
      'openai-codex': {
        installation: 'unknown',
        auth: 'unknown',
        disabled: true,
      },
    };
    const write = vi.fn((value: ConnectionMetadata) => value);
    const scan = detectExternalConnectionStates({
      ...dependencies({
        adapters: {
          'openai-codex-adapter': { id: 'openai-codex-adapter', detect },
        },
        write,
      }),
      readMetadata: () => (readCount++ === 0 ? {} : disabled),
    });

    release?.();
    await expect(scan).resolves.toEqual(disabled);
    expect(write).toHaveBeenCalledWith(disabled);
  });

  it('uses compare-and-swap merging so Forget and equal-time user updates win', async () => {
    let release: (() => void) | undefined;
    const detect = vi.fn(
      () =>
        new Promise<{ status: 'available' }>((resolve) => {
          release = () => resolve({ status: 'available' });
        }),
    );
    const baseline: ConnectionMetadata = {
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        lastCheckedAt: 123,
      },
    };
    const updatedAtSameTime: ConnectionMetadata = {
      'openai-codex': {
        installation: 'installed',
        auth: 'unauthenticated',
        lastCheckedAt: 123,
      },
    };

    for (const concurrent of [{}, updatedAtSameTime]) {
      let readCount = 0;
      const write = vi.fn((value: ConnectionMetadata) => value);
      const scan = detectExternalConnectionStates({
        ...dependencies({
          adapters: {
            'openai-codex-adapter': { id: 'openai-codex-adapter', detect },
          },
          write,
        }),
        readMetadata: () => (readCount++ === 0 ? baseline : concurrent),
      });
      release?.();

      await expect(scan).resolves.toEqual(concurrent);
      expect(write).toHaveBeenLastCalledWith(concurrent);
    }
  });

  it('does not apply or authorize a stale scan after an ABA user mutation', async () => {
    let release: (() => void) | undefined;
    const detect = vi.fn(
      () =>
        new Promise<{ status: 'available' }>((resolve) => {
          release = () => resolve({ status: 'available' });
        }),
    );
    let revision = 0;
    const write = vi.fn((value: ConnectionMetadata) => value);
    const markSessionChecked = vi.fn();
    const scan = detectExternalConnectionStates({
      ...dependencies({
        adapters: {
          'openai-codex-adapter': { id: 'openai-codex-adapter', detect },
        },
        write,
        markSessionChecked,
      }),
      readMetadata: () => ({}),
      readMetadataRevision: () => revision,
    });

    revision = 2; // Disable then Forget returns metadata to the absent baseline.
    release?.();

    await expect(scan).resolves.toEqual({});
    expect(write).toHaveBeenCalledWith({});
    expect(markSessionChecked).not.toHaveBeenCalled();
  });

  it('records requires-attention detection as unknown rather than not installed', async () => {
    await expect(
      detectExternalConnectionStates(
        dependencies({
          adapters: {
            'openai-codex-adapter': {
              id: 'openai-codex-adapter',
              detect: vi.fn(async () => ({ status: 'requires_attention' as const })),
            },
          },
        }),
      ),
    ).resolves.toEqual({
      'openai-codex': {
        installation: 'unknown',
        auth: 'unknown',
        lastCheckedAt: 123,
      },
    });
  });

  it('sanitizes probe failures into an unavailable generic record', async () => {
    const secret = 'sensitive-provider-detail-without-credentials';
    const write = vi.fn((value: ConnectionMetadata) => value);
    const result = await detectExternalConnectionStates(
      dependencies({
        adapters: {
          'openai-codex-adapter': {
            id: 'openai-codex-adapter',
            detect: vi.fn(async () => {
              throw new Error(secret);
            }),
          },
        },
        write,
      }),
    );

    expect(result).toEqual({
      'openai-codex': {
        installation: 'unknown',
        auth: 'unknown',
        lastCheckedAt: 123,
      },
    });
    expect(JSON.stringify(write.mock.calls)).not.toContain(secret);
  });

  it('shares an in-flight scan, caches briefly, and supports post-login invalidation', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const detect = vi.fn(() => {
      calls += 1;
      if (calls > 1) return Promise.resolve({ status: 'unavailable' as const });
      return new Promise<{ status: 'unavailable' }>((resolve) => {
          release = () => resolve({ status: 'unavailable' });
        });
    });
    let now = 1_000;
    const detector = createExternalConnectionAutoDetector(
      {
        ...dependencies({
        adapters: {
          'openai-codex-adapter': { id: 'openai-codex-adapter', detect },
        },
        }),
        now: () => now,
      },
      60_000,
    );

    const first = detector.ensure();
    const second = detector.ensure();
    expect(second).toBe(first);
    expect(detect).toHaveBeenCalledOnce();
    release?.();
    await first;
    await detector.ensure();
    expect(detect).toHaveBeenCalledOnce();

    detector.invalidate();
    await detector.ensure();
    expect(detect).toHaveBeenCalledTimes(2);

    now += 60_001;
    await detector.ensure();
    expect(detect).toHaveBeenCalledTimes(3);
  });
});

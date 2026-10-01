import { describe, expect, it, vi } from 'vitest';
import {
  OPEN_IN_TERMINAL_PROVIDERS,
  buildLaunchPlan,
  composeStartupCommands,
  createOpenInTerminalRuntime,
  loadPersistedRun,
  savePersistedRun,
  type OpenTerminalSession,
} from './openInTerminal';

const sessions = (count: number): OpenTerminalSession[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `terminal-${index + 1}`,
    status: index % 2 === 0 ? 'running' : 'detached',
    lastActiveAt: index % 2 === 0 ? 10_000 : 1,
  }));

describe('Open in Terminal planning', () => {
  it('defines exactly ten stable represented providers including required integrations', () => {
    expect(OPEN_IN_TERMINAL_PROVIDERS).toHaveLength(10);
    expect(new Set(OPEN_IN_TERMINAL_PROVIDERS.map((provider) => provider.id)).size).toBe(10);
    expect(OPEN_IN_TERMINAL_PROVIDERS.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['opencode', 'codex', 'claude']),
    );
  });

  it('counts active and idle project terminals and opens only the missing desired capacity', () => {
    const plan = buildLaunchPlan({
      desiredTotal: 10,
      sessions: sessions(2),
      now: 10_000,
      providerId: 'opencode',
      providerCommand: 'opencode',
      directory: '',
      followUp: '',
      platform: 'windows',
    });

    expect(plan.inventory).toMatchObject({ total: 2, active: 1, idle: 1 });
    expect(plan.launchCount).toBe(8);
    expect(plan.preservedSessionIds).toEqual(['terminal-1', 'terminal-2']);
  });

  it('writes a safely quoted directory change before provider and optional prompt', () => {
    expect(
      composeStartupCommands({
        platform: 'windows',
        directory: "C:\\Users\\Viper's Work\\VibeSpace",
        providerCommand: 'opencode',
        followUp: 'Inspect the failing tests.',
      }),
    ).toEqual([
      "Set-Location -LiteralPath 'C:\\Users\\Viper''s Work\\VibeSpace'",
      'opencode',
      'Inspect the failing tests.',
    ]);

    expect(
      composeStartupCommands({
        platform: 'unix',
        directory: "/work/user's repo",
        providerCommand: 'codex',
        followUp: '',
      }),
    ).toEqual(["cd -- '/work/user'\"'\"'s repo'", 'codex']);
    expect(
      composeStartupCommands({
        platform: 'windows',
        directory: '',
        providerCommand: 'C:\\Program Files\\Agent\\agent.exe',
        providerIsPath: true,
        followUp: '',
      }),
    ).toEqual(["& 'C:\\Program Files\\Agent\\agent.exe'"]);
  });

  it('rejects unsafe commands and out-of-range desired totals', () => {
    expect(() =>
      buildLaunchPlan({
        desiredTotal: 11,
        sessions: [],
        now: 0,
        providerId: 'custom',
        providerCommand: 'tool; remove-everything',
        directory: '',
        followUp: '',
        platform: 'windows',
      }),
    ).toThrow();
  });
});

describe('Open in Terminal runtime', () => {
  it('reinspects capacity at approval, validates the directory, and queues each safe pane', async () => {
    const queue = vi.fn((request) => `launch-${request.label}`);
    const runtime = createOpenInTerminalRuntime({
      listProjectSessions: vi.fn(async () => sessions(2)),
      validateDirectory: vi.fn(async () => 'C:\\Work Tree'),
      scanExecutables: vi.fn(async () => ({
        executables: [
          {
            executableId: 'exe-opencode',
            requestedName: 'opencode',
            executablePath: 'C:\\tools\\opencode.exe',
          },
        ],
      })),
      queue,
      cancelQueued: vi.fn(() => true),
      cancelRunning: vi.fn(async () => undefined),
      readExecution: vi.fn(() => undefined),
      markQueued: vi.fn(),
      navigateToTerminals: vi.fn(),
      now: () => 10_000,
      platform: 'windows',
    });

    await expect(runtime.detect()).resolves.toMatchObject({
      available: [expect.objectContaining({ id: 'opencode' })],
    });
    const launched = await runtime.launch({
      desiredTotal: 10,
      providerId: 'opencode',
      providerCommand: 'opencode',
      directory: 'C:\\Work Tree',
      followUp: '',
    });

    expect(launched.plan.launchCount).toBe(8);
    expect(queue).toHaveBeenCalledTimes(8);
    expect(queue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        startupCommands: ["Set-Location -LiteralPath 'C:\\Work Tree'", 'opencode'],
        preserveExisting: true,
      }),
    );
  });

  it('reports unavailable providers, partial queue failures, retryable failures, and cancellation', async () => {
    let call = 0;
    const cancelQueued = vi.fn(() => true);
    const runtime = createOpenInTerminalRuntime({
      listProjectSessions: vi.fn(async () => []),
      validateDirectory: vi.fn(async (path) => path),
      scanExecutables: vi.fn(async (request) => ({
        executables: request.customPath
          ? [
              {
                executableId: 'custom-exe',
                executablePath: request.customPath,
              },
            ]
          : [],
      })),
      queue: vi.fn(() => {
        call += 1;
        if (call === 2) throw new Error('queue unavailable');
        return `launch-${call}`;
      }),
      cancelQueued,
      cancelRunning: vi.fn(async () => undefined),
      readExecution: vi.fn(() => undefined),
      markQueued: vi.fn(),
      navigateToTerminals: vi.fn(),
      now: () => 10_000,
      platform: 'windows',
    });

    await expect(runtime.detect()).resolves.toMatchObject({
      available: [],
      unavailable: expect.arrayContaining([expect.objectContaining({ id: 'opencode' })]),
    });
    const result = await runtime.launch({
      desiredTotal: 3,
      providerId: 'custom',
      providerCommand: 'C:\\Tools\\custom.exe',
      directory: '',
      followUp: '',
    });
    expect(result.executionIds).toEqual(['launch-1', 'launch-3']);
    expect(result.failures).toHaveLength(1);

    await runtime.cancel(result.executionIds);
    expect(cancelQueued).toHaveBeenCalledTimes(2);
  });

  it('persists a bounded recovery receipt without relaunching after restart', () => {
    const values = new Map<string, string>();
    const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const receipt = {
      schemaVersion: 1 as const,
      state: 'launching' as const,
      desiredTotal: 4,
      providerId: 'codex',
      executionIds: ['launch-1'],
      updatedAt: 100,
    };

    savePersistedRun(receipt, storage);
    expect(loadPersistedRun(storage)).toEqual(receipt);
    values.set('vibespace.open-in-terminal.run.v1', '{"schemaVersion":2}');
    expect(loadPersistedRun(storage)).toBeNull();
  });

  it('stops queueing when cancellation is requested and does not navigate', async () => {
    let cancelled = false;
    const navigateToTerminals = vi.fn();
    const runtime = createOpenInTerminalRuntime({
      listProjectSessions: vi.fn(async () => []),
      validateDirectory: vi.fn(async (path) => path),
      scanExecutables: vi.fn(async () => ({ executables: [] })),
      queue: vi.fn(() => 'launch-1'),
      cancelQueued: vi.fn(() => true),
      cancelRunning: vi.fn(async () => undefined),
      readExecution: vi.fn(() => undefined),
      markQueued: vi.fn(),
      navigateToTerminals,
      now: () => 10_000,
      platform: 'windows',
    });

    const result = await runtime.launch(
      {
        desiredTotal: 4,
        providerId: 'codex',
        providerCommand: 'codex',
        directory: '',
        followUp: '',
      },
      {
        shouldCancel: () => cancelled,
        onProgress: () => {
          cancelled = true;
        },
      },
    );

    expect(result).toMatchObject({ cancelled: true, executionIds: ['launch-1'] });
    expect(navigateToTerminals).not.toHaveBeenCalled();
  });
});

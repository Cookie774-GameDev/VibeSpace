import * as React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accountListeners = vi.hoisted(() => {
  const events: string[] = [];
  const pendingStops = new Map<string, Promise<void>>();
  const factory = (name: string) =>
    vi.fn((bindings: { getAccountId: () => string }) => {
      const accountId = bindings.getAccountId();
      events.push(`start:${name}:${accountId}`);
      return () => {
        events.push(`stop:${name}:${accountId}`);
        return pendingStops.get(`${name}:${accountId}`);
      };
    });
  return {
    events,
    learning: factory('learning'),
    allAboutMe: factory('all-about-me'),
    deferStop(name: string, accountId: string) {
      let resolve: (() => void) | undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      pendingStops.set(`${name}:${accountId}`, promise);
      return () => resolve?.();
    },
    reset() {
      events.length = 0;
      pendingStops.clear();
    },
  };
});

const bootStorage = vi.hoisted(() => {
  const emptyCollection = new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        if (property === 'toArray') return async () => [];
        if (property === 'count') return async () => 0;
        if (property === 'first' || property === 'get') return async () => undefined;
        return () => emptyCollection;
      },
    },
  );
  let db: Record<string, unknown>;
  db = new Proxy<Record<string, unknown>>(
    {
      isOpen: () => true,
      close: () => undefined,
      open: async () => db,
      transaction: async (...args: unknown[]) => {
        const callback = args.at(-1);
        return typeof callback === 'function' ? callback() : undefined;
      },
    },
    {
      get: (target, property) => target[String(property)] ?? emptyCollection,
    },
  );
  return {
    db,
    openDb: vi.fn(async () => db),
    listAgents: vi.fn(async () => [] as unknown[]),
    seedIfEmpty: vi.fn(async () => ({ seeded: false })),
  };
});

const runtime = vi.hoisted(() => ({
  start: vi.fn((_bindings: { getAgentForChat: (chatId: string) => Promise<unknown> }) => vi.fn()),
}));

const kernelHost = vi.hoisted(() => ({
  openLiveEvidenceAccount: vi.fn(async (accountId: string) =>
    Object.freeze({
      accountId,
      read: Object.freeze({
        accountId,
        snapshot: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
      }),
      assertCurrent: vi.fn(),
      dispose: vi.fn(),
    }),
  ),
  getCommandCenterDependencies: vi.fn(() =>
    Object.freeze({
      kernel: {
        requestCancellation: vi.fn(async () => {
          throw new Error('not exercised by persistence coordinator tests');
        }),
      },
      scheduledTransportRetry: {
        retry: vi.fn(async () => {
          throw new Error('not exercised by persistence coordinator tests');
        }),
      },
      scheduledLogicalRetry: {
        retry: vi.fn(async () => {
          throw new Error('not exercised by persistence coordinator tests');
        }),
      },
    }),
  ),
}));

const persistence = vi.hoisted(() => {
  type Receipt = Readonly<{ accountId: string; generation: number; state: 'ready' }>;
  type State =
    | { status: 'activating'; accountId: string }
    | { status: 'ready'; accountId: string; profileId: string }
    | { status: 'degraded'; accountId?: string; category: string; retry: () => Promise<void> };
  type Input = {
    db: unknown;
    readIdentity: () => { accountId: string; source: string } | null;
    subscribeIdentity: (listener: () => void) => () => void;
  };
  type Instance = ReturnType<typeof makeInstance>;
  const instances: Instance[] = [];

  function makeInstance(input: Input) {
    let state: State = { status: 'activating', accountId: 'pending' };
    let receipt: Receipt | null = null;
    const listeners = new Set<() => void>();
    const stop = vi.fn();
    const unsubscribeState = vi.fn();
    const start = vi.fn(() => stop);
    const instance = {
      input,
      start,
      stop,
      unsubscribeState,
      retry: vi.fn(async () => undefined),
      getState: () => state,
      getReadyReceipt: () => receipt,
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribeState();
        };
      }),
      publish(nextState: State, nextReceipt: Receipt | null) {
        state = nextState;
        receipt = nextReceipt;
        for (const listener of [...listeners]) listener();
      },
    };
    return instance;
  }

  const create = vi.fn((input: Input) => {
    const instance = makeInstance(input);
    instances.push(instance);
    return instance;
  });

  return {
    create,
    instances,
    reset() {
      instances.length = 0;
      create.mockClear();
    },
  };
});

vi.mock('@/features/auth', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/features/jarvis-memory/learningListener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/jarvis-memory/learningListener')>();
  return { ...actual, startJarvisLearningListener: accountListeners.learning };
});

vi.mock('@/features/all-about-me/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/all-about-me/persistence')>();
  return { ...actual, startAllAboutMePersistence: accountListeners.allAboutMe };
});

vi.mock('@/lib/supabase/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/env')>();
  return {
    ...actual,
    readSupabaseEnv: () => ({}),
    isSupabaseConfigured: () => false,
  };
});

vi.mock('@/lib/ai/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/runtime')>();
  return {
    ...actual,
    startRuntimeListener: runtime.start,
    openJarvisLiveEvidenceAccount: kernelHost.openLiveEvidenceAccount,
    getInstalledJarvisCommandCenterHostDependencies: kernelHost.getCommandCenterDependencies,
  };
});

vi.mock('@/lib/jarvis/persistenceCoordinator', () => ({
  createJarvisPersistenceCoordinator: persistence.create,
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    db: bootStorage.db,
    openDb: bootStorage.openDb,
    agentRepo: { ...actual.agentRepo, list: bootStorage.listAgents },
    chatRepo: { ...actual.chatRepo, getById: vi.fn(async () => undefined) },
  };
});

vi.mock('@/lib/db/seed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/seed')>();
  return { ...actual, seedIfEmpty: bootStorage.seedIfEmpty };
});

vi.mock('@/features/pets', () => ({ PetHost: () => null }));
vi.mock('@/features/whats-new', () => ({
  WhatsNewHost: () => null,
  useWhatsNew: () => ({
    currentVersion: 'test-version',
    lastSeenVersion: 'test-version',
    hasUpdate: false,
    markSeen: vi.fn(),
  }),
}));

import { App } from './App';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { Agent } from '@/types';

const originalAuth = useAuthStore.getState();
const originalUi = useUIStore.getState();
const originalAgents = useAgentStore.getState();

function prepare(identity = { cloudSession: null, localUserId: 'local-account' }): void {
  useAuthStore.setState({
    ...identity,
    apiKeys: { mock: 'test-model-access' },
    offlineMode: false,
    workspaceId: null,
    projectId: null,
  });
  useUIStore.setState({
    onboardingComplete: true,
    productTutorialStatus: 'completed',
    route: 'benchmarks',
    ambientActive: false,
    inspectorOpen: false,
    activeChatId: null,
    paletteOpen: false,
    settingsOpen: false,
    voiceModalOpen: false,
    launcherOpen: false,
    assistantOpen: false,
    whatsNewOpen: false,
    newsPanelOpen: false,
    callModalOpen: false,
    wellnessActive: false,
    actionsPaletteOpen: false,
    lastSeenWhatsNewVersion: '1.5.0',
  });
  useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
}

function agent(slug: string, builtin: boolean, id: string): Agent {
  return {
    id: id as Agent['id'],
    slug,
    name: id,
    description: '',
    system_prompt: '',
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: [],
    memory_scope: 'workspace',
    capabilities: [],
    builtin,
    created_at: 1,
    updated_at: 1,
  };
}

async function mountedInstance() {
  await waitFor(() => expect(persistence.create).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  const instance = persistence.instances[0];
  if (!instance) throw new Error('Expected mounted persistence coordinator.');
  return instance;
}

describe('App JARVIS persistence coordinator mount', { timeout: 20_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.jarvisRuntimeListenerReady;
    vi.clearAllMocks();
    persistence.reset();
    accountListeners.reset();
    bootStorage.openDb.mockReset();
    bootStorage.openDb.mockResolvedValue(bootStorage.db);
    bootStorage.listAgents.mockReset();
    bootStorage.listAgents.mockResolvedValue([]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    document.body.removeAttribute('data-scroll-locked');
    document.body.style.removeProperty('pointer-events');
    prepare();
  });

  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.jarvisRuntimeListenerReady;
    vi.restoreAllMocks();
    useAuthStore.setState(originalAuth, true);
    useUIStore.setState(originalUi, true);
    useAgentStore.setState(originalAgents, true);
  });

  it('withholds the workspace until the real Jarvis send listener is installed', async () => {
    let resolveAgents!: (agents: unknown[]) => void;
    bootStorage.listAgents.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveAgents = resolve;
        }),
    );

    const mounted = render(<App />);
    await waitFor(() => expect(bootStorage.listAgents).toHaveBeenCalledOnce());

    expect(runtime.start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.jarvisRuntimeListenerReady).toBeUndefined();
    expect(mounted.container.querySelector('[data-monochrome-surface="app-shell"]')).toBeNull();

    await act(async () => {
      resolveAgents([]);
      await Promise.resolve();
    });

    await waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    expect(document.documentElement.dataset.jarvisRuntimeListenerReady).toBe('true');
    await waitFor(() =>
      expect(
        mounted.container.querySelector('[data-monochrome-surface="app-shell"]'),
      ).not.toBeNull(),
    );

    mounted.unmount();
    expect(document.documentElement.dataset.jarvisRuntimeListenerReady).toBeUndefined();
  });

  it('constructs one coordinator after database open and gates listeners until ready', async () => {
    const mounted = render(<App />);
    const instance = await mountedInstance();

    expect(bootStorage.openDb.mock.invocationCallOrder[0]).toBeLessThan(
      persistence.create.mock.invocationCallOrder[0]!,
    );
    expect(instance.input.db).toBe(bootStorage.db);
    expect(instance.start).toHaveBeenCalledOnce();
    expect(accountListeners.learning).not.toHaveBeenCalled();

    act(() => {
      instance.publish(
        { status: 'ready', accountId: 'local-account', profileId: 'profile-local' },
        { accountId: 'local-account', generation: 1, state: 'ready' },
      );
    });
    await waitFor(() => expect(accountListeners.learning).toHaveBeenCalledOnce());
    expect(accountListeners.allAboutMe).toHaveBeenCalledOnce();

    mounted.unmount();
    expect(instance.unsubscribeState).toHaveBeenCalledOnce();
    expect(instance.stop).toHaveBeenCalledOnce();
  });

  it('keeps V2 runtime available while degraded and starts writes only after explicit retry', async () => {
    render(<App />);
    const instance = await mountedInstance();
    const retry = vi.fn(async () => {
      instance.publish(
        { status: 'ready', accountId: 'local-account', profileId: 'profile-local' },
        { accountId: 'local-account', generation: 2, state: 'ready' },
      );
    });

    act(() => {
      instance.publish(
        {
          status: 'degraded',
          accountId: 'local-account',
          category: 'migration_failed',
          retry,
        },
        null,
      );
    });
    await waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    expect(accountListeners.learning).not.toHaveBeenCalled();

    const state = instance.getState();
    if (state.status !== 'degraded') throw new Error('Expected degraded state.');
    await act(async () => state.retry());
    await waitFor(() => expect(accountListeners.learning).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('waits for A teardown before starting a ready B generation', async () => {
    render(<App />);
    const instance = await mountedInstance();
    act(() => {
      instance.publish(
        { status: 'ready', accountId: 'local-account', profileId: 'profile-a' },
        { accountId: 'local-account', generation: 1, state: 'ready' },
      );
    });
    await waitFor(() => expect(accountListeners.learning).toHaveBeenCalledOnce());
    const finishLearning = accountListeners.deferStop('learning', 'local-account');
    const finishProfile = accountListeners.deferStop('all-about-me', 'local-account');

    act(() => {
      useAuthStore.setState({
        cloudSession: {
          user_id: 'cloud-account-b',
          email: 'b@example.test',
          expires_at: 4_102_444_800,
        },
      });
      instance.publish({ status: 'activating', accountId: 'cloud-account-b' }, null);
      instance.publish(
        { status: 'ready', accountId: 'cloud-account-b', profileId: 'profile-b' },
        { accountId: 'cloud-account-b', generation: 2, state: 'ready' },
      );
    });

    await waitFor(() => expect(accountListeners.events).toContain('stop:learning:local-account'));
    expect(accountListeners.events).not.toContain('start:learning:cloud-account-b');

    await act(async () => {
      finishLearning();
      finishProfile();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(accountListeners.events).toContain('start:learning:cloud-account-b'),
    );
  });

  it('never chooses a user-created jarvis slug collision as the default agent', async () => {
    const collision = agent('jarvis', false, 'collision');
    const protectedJarvis = agent('jarvis', true, 'protected-jarvis');
    bootStorage.listAgents.mockResolvedValueOnce([collision, protectedJarvis]);

    render(<App />);
    const instance = await mountedInstance();
    act(() => {
      instance.publish(
        { status: 'ready', accountId: 'local-account', profileId: 'profile-local' },
        { accountId: 'local-account', generation: 1, state: 'ready' },
      );
    });
    await waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());
    const runtimeBindings = runtime.start.mock.calls[0]![0];

    await expect(runtimeBindings.getAgentForChat('missing-chat')).resolves.toBe(protectedJarvis);
  });

  it('starts no coordinator or account writes when database open fails', async () => {
    bootStorage.openDb.mockRejectedValueOnce(new Error('database unavailable'));

    render(<App />);
    await waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());

    expect(persistence.create).not.toHaveBeenCalled();
    expect(accountListeners.learning).not.toHaveBeenCalled();
  });
});

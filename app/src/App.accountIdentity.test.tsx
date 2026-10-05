import {
  accountAuthorityReadiness,
  createAccountAuthorityPublisher,
} from '@/lib/accountAuthorityReadiness';
import { getLocalAccountReadyReceipt } from '@/lib/localAccountReadiness';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accountListeners = vi.hoisted(() => {
  type Bindings = {
    getAccountId: () => string;
  };

  const events: string[] = [];
  const deferredStops = new Map<string, Promise<void>>();
  const factory = (name: string) =>
    vi.fn((bindings: Bindings) => {
      const accountId = bindings.getAccountId();
      events.push(`start:${name}:${accountId}`);
      return () => {
        events.push(`stop:${name}:${accountId}`);
        const pending = deferredStops.get(`${name}:${accountId}`);
        if (pending) {
          return pending.then(() => {
            events.push(`flush:${name}:${accountId}`);
          });
        }
      };
    });

  return {
    events,
    learning: factory('learning'),
    allAboutMe: factory('all-about-me'),
    deferStop: (name: string, accountId: string) => {
      let resolve: (() => void) | undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      deferredStops.set(`${name}:${accountId}`, promise);
      return () => resolve?.();
    },
    reset: () => {
      events.length = 0;
      deferredStops.clear();
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
        if (
          property === 'add' ||
          property === 'put' ||
          property === 'update' ||
          property === 'delete' ||
          property === 'clear' ||
          property === 'each'
        ) {
          return async () => undefined;
        }
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
    listAgents: vi.fn(async () => []),
    seedIfEmpty: vi.fn(async () => ({ seeded: false })),
  };
});

const cloudSync = vi.hoisted(() => {
  const loopStops = [] as Array<ReturnType<typeof vi.fn>>;
  const processCloudPull = vi.fn(async (): Promise<void> => undefined);
  const processSyncQueue = vi.fn(async (): Promise<void> => undefined);
  return {
    loopStops,
    processCloudPull,
    processSyncQueue,
    pruneSyncQueue: vi.fn(async (): Promise<void> => undefined),
    retrySyncErrors: vi.fn(async (): Promise<void> => undefined),
    startSyncLoop: vi.fn((_authority?: { userId: string; signal: AbortSignal }) => {
      const stop = vi.fn(async (): Promise<void> => undefined);
      loopStops.push(stop);
      void processSyncQueue().then(() => processCloudPull());
      return stop;
    }),
  };
});

const launchPromo = vi.hoisted(() => ({
  claim: vi.fn(async () => undefined),
}));

const cloudBoot = vi.hoisted(() => {
  type Session = {
    user?: {
      id?: string;
      email?: string;
    };
    expires_at?: number;
  } | null;
  type SessionResult = {
    data: {
      session: Session;
    };
    error?: unknown;
  };

  let configured = false;
  let configurationError: unknown;
  let getSessionImpl = async (): Promise<SessionResult> => ({
    data: { session: null },
  });
  const authListeners = new Set<(_event: string, session: Session) => void>();
  const getSession = vi.fn(() => getSessionImpl());
  const onAuthStateChange = vi.fn((listener: (_event: string, session: Session) => void) => {
    authListeners.add(listener);
    return {
      data: {
        subscription: {
          unsubscribe: vi.fn(() => {
            authListeners.delete(listener);
          }),
        },
      },
    };
  });
  const maybeSingle = vi.fn(
    async (): Promise<{ data: { tier: string } | null; error: unknown | null }> => ({
      data: null,
      error: null,
    }),
  );
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle,
      }),
    }),
  }));

  return {
    client: {
      auth: {
        getSession,
        onAuthStateChange,
      },
      from,
    },
    configured: () => {
      if (configurationError) throw configurationError;
      return configured;
    },
    setConfigured: (value: boolean) => {
      configured = value;
    },
    failConfigurationCheck: (error: unknown) => {
      configurationError = error;
    },
    deferSession: () => {
      let resolve: ((value: SessionResult) => void) | undefined;
      let reject: ((error: unknown) => void) | undefined;
      const promise = new Promise<SessionResult>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      getSessionImpl = () => promise;
      return {
        resolve: (session: Session) => resolve?.({ data: { session } }),
        reject: (error: unknown) => reject?.(error),
        fail: (error: unknown) => resolve?.({ data: { session: null }, error }),
      };
    },
    emitAuth: (session: Session, event = 'SIGNED_IN') => {
      for (const listener of [...authListeners]) listener(event, session);
    },
    getSession,
    maybeSingle,
    onAuthStateChange,
    reset: () => {
      configured = false;
      configurationError = undefined;
      getSessionImpl = async () => ({ data: { session: null } });
      authListeners.clear();
      maybeSingle.mockReset();
      maybeSingle.mockResolvedValue({ data: null, error: null });
    },
  };
});

const bootListeners = vi.hoisted(() => ({
  runtime: vi.fn(() => () => undefined),
}));

const scheduledCalls = vi.hoisted(() => ({
  start: vi.fn(() => () => undefined),
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
          throw new Error('not exercised by account identity tests');
        }),
      },
      scheduledTransportRetry: {
        retry: vi.fn(async () => {
          throw new Error('not exercised by account identity tests');
        }),
      },
      scheduledLogicalRetry: {
        retry: vi.fn(async () => {
          throw new Error('not exercised by account identity tests');
        }),
      },
    }),
  ),
}));

const queueAuthority = vi.hoisted(() => {
  type Lease = Readonly<{ userId: string; generation: number }>;
  let generation = 0;
  let active: Lease | undefined;
  const events: string[] = [];
  const activate = vi.fn((userId: string): Lease => {
    const lease = Object.freeze({ userId, generation: ++generation });
    active = lease;
    events.push(`queue:activate:${userId}`);
    return lease;
  });
  const release = vi.fn((lease: Lease) => {
    events.push(`queue:release:${lease.userId}`);
    if (active === lease) active = undefined;
  });
  return {
    activate,
    events,
    release,
    currentUserId: () => active?.userId,
    reset: () => {
      active = undefined;
      events.length = 0;
      activate.mockClear();
      release.mockClear();
    },
  };
});

const protectedBootObservers = vi.hoisted(() => {
  const authGateRenders: Array<{ cloudUserId: string | null; plan: string }> = [];
  return {
    authGateRenders,
    reset: () => {
      authGateRenders.length = 0;
    },
  };
});

const appPersistence = vi.hoisted(() => {
  const create = vi.fn(
    (input: {
      readIdentity: () => { accountId: string } | null;
      subscribeIdentity: (listener: () => void) => () => void;
    }) => {
      let generation = 0;
      let receipt: Readonly<{ accountId: string; generation: number; state: 'ready' }> | null =
        null;
      let state: unknown = { status: 'degraded', category: 'identity_not_ready' };
      const listeners = new Set<() => void>();
      let stopIdentity: (() => void) | undefined;
      let stopped = false;
      const activate = () => {
        if (stopped) return;
        const identity = input.readIdentity();
        generation += 1;
        receipt = identity
          ? Object.freeze({ accountId: identity.accountId, generation, state: 'ready' as const })
          : null;
        state = identity
          ? {
              status: 'ready',
              accountId: identity.accountId,
              profileId: `profile-${identity.accountId}`,
            }
          : { status: 'degraded', category: 'identity_not_ready' };
        for (const listener of [...listeners]) listener();
      };
      return {
        start: () => {
          stopIdentity = input.subscribeIdentity(activate);
          activate();
          return () => {
            if (stopped) return;
            stopped = true;
            receipt = null;
            stopIdentity?.();
          };
        },
        retry: async () => activate(),
        getState: () => state,
        getReadyReceipt: () => receipt,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
  );
  return {
    create,
    reset: () => create.mockClear(),
  };
});

vi.mock('@/features/jarvis-memory/learningListener', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/jarvis-memory/learningListener')>();
  return {
    ...actual,
    startJarvisLearningListener: accountListeners.learning,
  };
});

vi.mock('@/features/all-about-me/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/all-about-me/persistence')>();
  return {
    ...actual,
    startAllAboutMePersistence: accountListeners.allAboutMe,
  };
});

vi.mock('@/lib/supabase/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/env')>();
  return {
    ...actual,
    readSupabaseEnv: () => ({}),
    isSupabaseConfigured: () => cloudBoot.configured(),
  };
});

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => cloudBoot.client,
  isCloudSyncConfigured: () => cloudBoot.configured(),
}));

vi.mock('@/lib/sync', () => ({
  processCloudPull: cloudSync.processCloudPull,
  processSyncQueue: cloudSync.processSyncQueue,
  pruneSyncQueue: cloudSync.pruneSyncQueue,
  retrySyncErrors: cloudSync.retrySyncErrors,
  startSyncLoop: cloudSync.startSyncLoop,
}));

vi.mock('@/lib/cloudSyncQueueOwner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cloudSyncQueueOwner')>();
  return {
    ...actual,
    activateSyncQueueCloudAuthority: queueAuthority.activate,
    releaseSyncQueueCloudAuthority: queueAuthority.release,
  };
});

vi.mock('@/features/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth')>();
  const ReactModule = await import('react');
  const { useAuthStore: authStore } = await import('@/stores/auth');
  return {
    ...actual,
    AuthGate: function ObservedAuthGate(props: Parameters<typeof actual.AuthGate>[0]) {
      const auth = authStore.getState();
      protectedBootObservers.authGateRenders.push({
        cloudUserId: auth.cloudSession?.user_id ?? null,
        plan: auth.plan,
      });
      return ReactModule.createElement(actual.AuthGate, props);
    },
  };
});

vi.mock('@/lib/launchPromo', () => ({
  claimLaunchPromo: launchPromo.claim,
}));

vi.mock('@/lib/ai/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/runtime')>();
  return {
    ...actual,
    startRuntimeListener: bootListeners.runtime,
    openJarvisLiveEvidenceAccount: kernelHost.openLiveEvidenceAccount,
    getInstalledJarvisCommandCenterHostDependencies: kernelHost.getCommandCenterDependencies,
  };
});

vi.mock('@/lib/jarvis/persistenceCoordinator', () => ({
  createJarvisPersistenceCoordinator: appPersistence.create,
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    db: bootStorage.db,
    openDb: bootStorage.openDb,
    agentRepo: {
      ...actual.agentRepo,
      list: bootStorage.listAgents,
    },
  };
});

vi.mock('@/lib/db/seed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/seed')>();
  return {
    ...actual,
    seedIfEmpty: bootStorage.seedIfEmpty,
  };
});

vi.mock('@/features/pets', () => ({
  PetHost: () => null,
}));

// This independent background runner reads Supabase to gate cloud refresh.
// Its signed-out behavior is covered by scheduledCallRunner.test.ts; keep the
// deferred session in this fixture exclusive to App's account authority boot.
vi.mock('@/features/call/thirdParty/scheduledCallRunner', () => ({
  startScheduledCallRunner: scheduledCalls.start,
}));

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
import { useAllAboutMeStore } from '@/features/all-about-me/store';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { useJarvisTaskRunStore } from '@/features/jarvis-runs/taskRunStore';
import type { JarvisTaskRunProjection } from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';
import { useAgentStore } from '@/stores/agents';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';

const originalAuth = useAuthStore.getState();
const originalUi = useUIStore.getState();
const originalAgents = useAgentStore.getState();

const cloudSession = (userId: string) => ({
  user_id: userId,
  email: 'account-identity-test@example.test',
  expires_at: 4_102_444_800,
});

const supabaseSession = (userId: string) => ({
  user: {
    id: userId,
    email: 'account-identity-test@example.test',
  },
  expires_at: 4_102_444_800,
});

function prepareAppIdentity(
  identity: Pick<ReturnType<typeof useAuthStore.getState>, 'cloudSession' | 'localUserId'>,
): void {
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
  useAgentStore.setState({
    agents: {},
    runStates: {},
    verbs: {},
    tokens: {},
  });
}

const ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS = { timeout: 15_000 } as const;
const ACCOUNT_SCOPE_BOOT_TEST_TIMEOUT = 90_000;

async function waitForAccountScopeBoot(): Promise<void> {
  await waitFor(
    () => expect(bootListeners.runtime).toHaveBeenCalledTimes(1),
    ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

function seedCanonicalTaskProjection(scope: string, runId: string, goal: string): void {
  const projection: JarvisTaskRunProjection = {
    canonical: true,
    runId,
    chatId: 'chat-account-isolation',
    status: 'running',
    goal,
    userVisibleSummary: 'Canonical task projection',
    progress: 50,
    activeAgents: [],
    activeTerminals: [],
    updatedAt: '2026-07-19T08:00:00.000Z',
    cancellable: true,
    transportRetryAvailable: false,
  };
  const store = useJarvisTaskRunStore.getState();
  store.setAccountScope(scope);
  store.replaceCanonicalForAccount(scope, [projection], {});
}

async function expectEveryListenerStartedWith(accountId: string, callIndex = 0): Promise<void> {
  await waitFor(() => {
    for (const listener of [accountListeners.learning, accountListeners.allAboutMe]) {
      expect(listener.mock.calls[callIndex]?.[0].getAccountId()).toBe(accountId);
    }
  }, ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS);
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
  };
}

function accountIdentityBootSuite(): void {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    bootStorage.listAgents.mockReset();
    bootStorage.listAgents.mockResolvedValue([]);
    cloudSync.loopStops.length = 0;
    accountListeners.reset();
    cloudBoot.reset();
    queueAuthority.reset();
    protectedBootObservers.reset();
    appPersistence.reset();
    useJarvisLearningStore.getState().clearForTests();
    useAllAboutMeStore.setState(useAllAboutMeStore.getInitialState(), true);
    useJarvisTaskRunStore.getState().clearForTests();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    document.body.removeAttribute('data-scroll-locked');
    document.body.style.removeProperty('pointer-events');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    useAuthStore.setState(originalAuth, true);
    useUIStore.setState(originalUi, true);
    useAgentStore.setState(originalAgents, true);
    useJarvisLearningStore.getState().clearForTests();
    useAllAboutMeStore.setState(useAllAboutMeStore.getInitialState(), true);
    useJarvisTaskRunStore.getState().clearForTests();
  });

  it.each(['initial', 'lifecycle'] as const)(
    'review: %s SDK result cannot bless reentrant same-account store replacement',
    async (path) => {
      cloudBoot.setConfigured(true);
      const session = cloudBoot.deferSession();
      prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
      render(<App />);
      await waitForAccountScopeBoot();
      if (path === 'lifecycle') {
        await act(async () => {
          session.resolve(supabaseSession('cloud-user-a'));
        });
        await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
      }
      let replaced = false;
      const stop = useAuthStore.subscribe((next, previous) => {
        if (
          !replaced &&
          next.cloudSession !== previous.cloudSession &&
          next.cloudSession?.user_id === 'cloud-user-a'
        ) {
          replaced = true;
          useAuthStore.setState({ cloudSession: cloudSession('cloud-user-a') });
        }
      });
      try {
        await act(async () => {
          if (path === 'initial') session.resolve(supabaseSession('cloud-user-a'));
          else cloudBoot.emitAuth(supabaseSession('cloud-user-a'), 'TOKEN_REFRESHED');
        });
        expect(replaced).toBe(true);
        expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
      } finally {
        stop();
      }
    },
  );

  it('review: reentrant cloud/store ABA cannot bless the replacement object', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    let replaced = false;
    const stop = useAuthStore.subscribe((next, previous) => {
      if (
        !replaced &&
        next.cloudSession !== previous.cloudSession &&
        next.cloudSession?.user_id === 'cloud-user-a'
      ) {
        replaced = true;
        useAuthStore.setState({ cloudSession: cloudSession('cloud-user-b') });
        useAuthStore.setState({ cloudSession: cloudSession('cloud-user-a') });
      }
    });
    try {
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
      });
      expect(replaced).toBe(true);
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    } finally {
      stop();
    }
  });

  it('review: restoring the exact SDK projection after a nested replacement does not restore its observation', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    let replaced = false;
    const stop = useAuthStore.subscribe((next, previous) => {
      if (
        !replaced &&
        next.cloudSession !== previous.cloudSession &&
        next.cloudSession?.user_id === 'cloud-user-a'
      ) {
        replaced = true;
        const originalProjection = next.cloudSession;
        useAuthStore.setState({ cloudSession: cloudSession('cloud-user-a') });
        useAuthStore.setState({ cloudSession: originalProjection });
      }
    });
    try {
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
      });
      expect(replaced).toBe(true);
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    } finally {
      stop();
    }
  });

  it('publishes only accepted initial SDK observations', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    await waitFor(() =>
      expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
        state: 'cloud',
        source: 'supabase-sdk-cache',
        accountId: 'cloud-user-a',
      }),
    );
  });

  it.each(['SIGNED_IN', 'TOKEN_REFRESHED'])(
    'advances same-account observation on %s and leaves ordinary UI changes stable',
    async (event) => {
      cloudBoot.setConfigured(true);
      const session = cloudBoot.deferSession();
      prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
      render(<App />);
      await waitForAccountScopeBoot();
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
      });
      await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
      const initial = accountAuthorityReadiness.getSnapshot();
      act(() => {
        useUIStore.getState().setRoute('account');
        useAuthStore.setState({ plan: 'pro' });
      });
      expect(accountAuthorityReadiness.getSnapshot()).toBe(initial);
      act(() => {
        cloudBoot.emitAuth(supabaseSession('cloud-user-a'), event);
      });
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
      await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
      expect(accountAuthorityReadiness.getSnapshot().generation).toBeGreaterThan(
        initial.generation,
      );
      expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1);
    },
  );

  it('revokes metadata on unverified same-account store replacement and does not restore it from account equality', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('cloud-user-a') });
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    await act(async () => {
      await Promise.resolve();
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    await act(async () => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-a'));
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud');
  });

  it('rejects initial recovery completion after unverified store ABA', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('unverified-cloud') });
      useAuthStore.setState({ cloudSession: null });
    });
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
  });

  it('keeps cloud account ABA unready until old teardown and ignores its intermediate account', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalled());
    const initial = accountAuthorityReadiness.getSnapshot();
    const teardown = deferredValue<void>();
    cloudSync.loopStops.at(-1)!.mockImplementation(() => teardown.promise);
    const seen: string[] = [];
    const stop = accountAuthorityReadiness.subscribe(() => {
      const value = accountAuthorityReadiness.getSnapshot();
      if (value.state === 'cloud') seen.push(value.accountId);
    });
    try {
      await act(async () => {
        cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
        cloudBoot.emitAuth(supabaseSession('cloud-user-a'));
      });
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
      await act(async () => {
        teardown.resolve();
        await teardown.promise;
      });
      await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
      expect(seen).toEqual(['cloud-user-a']);
      expect(accountAuthorityReadiness.getSnapshot().generation).toBeGreaterThan(
        initial.generation,
      );
    } finally {
      stop();
      teardown.resolve();
    }
  });

  it('revokes after terminal refresh failure SIGNED_OUT and waits for real local readiness', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalled());
    const old = accountAuthorityReadiness.getSnapshot();
    const teardown = deferredValue<void>();
    cloudSync.loopStops.at(-1)!.mockImplementation(() => teardown.promise);
    try {
      await act(async () => {
        cloudBoot.emitAuth(null, 'SIGNED_OUT');
      });
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
      expect(accountAuthorityReadiness.getSnapshot().generation).toBeGreaterThan(old.generation);
      await act(async () => {
        teardown.resolve();
        await teardown.promise;
      });
      await waitFor(() =>
        expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
          state: 'local',
          accountId: 'stable-local-user',
          persistenceGeneration: getLocalAccountReadyReceipt()?.persistenceGeneration,
          localReadinessGeneration: getLocalAccountReadyReceipt()?.generation,
        }),
      );
    } finally {
      teardown.resolve();
    }
  });

  it('never publishes a malformed refresh observation or interprets its null as confirmed sign-out', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
    });
    await waitFor(() => expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud'));
    await act(async () => {
      cloudBoot.emitAuth(null, 'TOKEN_REFRESHED');
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
  });

  it('unmount and late verification cannot revoke a replacement publisher', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    const first = render(<App />);
    await waitForAccountScopeBoot();
    const replacement = createAccountAuthorityPublisher();
    try {
      await replacement
        .beginTransition()
        .settleCloud({
          accountId: 'replacement',
          teardown: Promise.resolve(),
          isCurrent: () => true,
        });
      const current = accountAuthorityReadiness.getSnapshot();
      first.unmount();
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
      });
      expect(accountAuthorityReadiness.getSnapshot()).toBe(current);
    } finally {
      replacement.dispose();
    }
  });

  it('reserves deterministic test-timeout headroom beyond the longest boot wait', () => {
    expect(ACCOUNT_SCOPE_BOOT_TEST_TIMEOUT).toBeGreaterThanOrEqual(
      ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS.timeout * 6,
    );
  });

  it('keeps every account listener closed until configured Supabase confirms signed-out state', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: cloudSession('persisted-cloud-user'),
      localUserId: 'stable-local-user',
    });

    render(<App />);
    try {
      await waitForAccountScopeBoot();

      expect(scheduledCalls.start).toHaveBeenCalledTimes(1);
      expect(cloudBoot.getSession).toHaveBeenCalledTimes(1);
      expect(accountListeners.learning).not.toHaveBeenCalled();
      expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
      expect(bootListeners.runtime).toHaveBeenCalledTimes(1);
      expect(document.querySelector('main[aria-label="Workspace"]')).not.toBeNull();
    } finally {
      await act(async () => {
        session.resolve(null);
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(1);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    });
    await expectEveryListenerStartedWith('stable-local-user');
  });

  it('quarantines persisted cloud auth during commit before protected children can render', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: cloudSession('persisted-cloud-user'),
      localUserId: 'stable-local-user',
    });
    useAuthStore.setState({ plan: 'apex' });

    let commitStarted = false;
    const quarantineCommitPhases: boolean[] = [];
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (state.cloudSession === null && state.plan === 'free') {
        quarantineCommitPhases.push(commitStarted);
      }
    });

    function CommitPhaseBoundary({ children }: { children: React.ReactNode }) {
      React.useInsertionEffect(() => {
        commitStarted = true;
      }, []);
      return children;
    }

    try {
      try {
        render(
          <CommitPhaseBoundary>
            <App />
          </CommitPhaseBoundary>,
        );
      } finally {
        unsubscribe();
      }

      expect(quarantineCommitPhases).toEqual([true]);
      expect(useAuthStore.getState()).toMatchObject({
        cloudSession: null,
        plan: 'free',
      });
      expect(protectedBootObservers.authGateRenders.length).toBeGreaterThan(0);
      expect(protectedBootObservers.authGateRenders).toEqual(
        protectedBootObservers.authGateRenders.map(() => ({
          cloudUserId: null,
          plan: 'free',
        })),
      );
      expect(queueAuthority.currentUserId()).toBeUndefined();
      expect(accountListeners.learning).not.toHaveBeenCalled();
      expect(accountListeners.allAboutMe).not.toHaveBeenCalled();

      await waitFor(
        () => expect(cloudBoot.getSession).toHaveBeenCalledTimes(1),
        ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
      );
      expect(useAuthStore.getState()).toMatchObject({
        cloudSession: null,
        plan: 'free',
      });
      expect(queueAuthority.currentUserId()).toBeUndefined();
      expect(accountListeners.learning).not.toHaveBeenCalled();
      expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        session.resolve(null);
        await Promise.resolve();
      });
    }
  });

  it.each(['dictation', 'pet-overlay', 'pet-mini-panel'])(
    'does not quarantine persisted cloud state in the %s auxiliary view',
    (view) => {
      window.history.replaceState({}, '', `/?view=${view}`);
      prepareAppIdentity({
        cloudSession: cloudSession('persisted-cloud-user'),
        localUserId: 'stable-local-user',
      });
      useAuthStore.setState({ plan: 'apex' });

      render(<App />);

      expect(useAuthStore.getState()).toMatchObject({
        cloudSession: { user_id: 'persisted-cloud-user' },
        plan: 'apex',
      });
      expect(protectedBootObservers.authGateRenders).toEqual([]);
    },
  );

  it('starts the exact cloud scope only after configured Supabase resolves it', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();

    expect(queueAuthority.currentUserId()).toBeUndefined();
    expect(accountListeners.learning).not.toHaveBeenCalled();
    expect(accountListeners.allAboutMe).not.toHaveBeenCalled();

    await act(async () => {
      session.resolve(supabaseSession('confirmed-cloud-user'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(1);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    });
    await expectEveryListenerStartedWith('confirmed-cloud-user');
    expect(queueAuthority.currentUserId()).toBe('confirmed-cloud-user');
  });

  it('replaces queue authority before auth-store subscribers observe the new account', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    const mounted = render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(queueAuthority.currentUserId()).toBe('cloud-user-a'));

    queueAuthority.events.length = 0;
    const unsubscribe = useAuthStore.subscribe((state) => {
      queueAuthority.events.push(`store:${state.cloudSession?.user_id ?? 'signed-out'}`);
    });
    try {
      act(() => {
        cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
      });
      expect(queueAuthority.events.slice(0, 3)).toEqual([
        'queue:release:cloud-user-a',
        'queue:activate:cloud-user-b',
        'store:cloud-user-b',
      ]);
      expect(queueAuthority.currentUserId()).toBe('cloud-user-b');
    } finally {
      unsubscribe();
      mounted.unmount();
    }

    expect(queueAuthority.currentUserId()).toBeUndefined();
  });

  it('releases verified queue authority on unverified local auth divergence', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(queueAuthority.currentUserId()).toBe('cloud-user-a'));

    act(() => {
      useAuthStore.setState({ cloudSession: null });
    });
    expect(queueAuthority.currentUserId()).toBeUndefined();

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('cloud-user-b') });
    });
    expect(queueAuthority.currentUserId()).toBeUndefined();

    act(() => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
    });
    expect(queueAuthority.currentUserId()).toBe('cloud-user-b');
  });

  it('revokes local auth divergence before the rest of boot finishes', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    const agentList = deferredValue<never[]>();
    bootStorage.listAgents.mockImplementationOnce(() => agentList.promise);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    try {
      await waitFor(
        () => expect(cloudBoot.getSession).toHaveBeenCalledTimes(1),
        ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
      );
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
        await Promise.resolve();
      });
      await waitFor(() => expect(queueAuthority.currentUserId()).toBe('cloud-user-a'));
      expect(bootStorage.listAgents).toHaveBeenCalledTimes(1);

      act(() => {
        useAuthStore.setState({ cloudSession: null });
      });
      expect(queueAuthority.currentUserId()).toBeUndefined();
    } finally {
      await act(async () => {
        session.resolve(supabaseSession('cloud-user-a'));
        agentList.resolve([]);
        await Promise.resolve();
      });
    }
  });

  it('starts one cloud sync loop only after valid normalized initial authority', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();

    const callsBeforeAuthority = {
      retry: cloudSync.retrySyncErrors.mock.calls.length,
      queue: cloudSync.processSyncQueue.mock.calls.length,
      pull: cloudSync.processCloudPull.mock.calls.length,
      prune: cloudSync.pruneSyncQueue.mock.calls.length,
      start: cloudSync.startSyncLoop.mock.calls.length,
    };

    await act(async () => {
      session.resolve(supabaseSession('  confirmed-cloud-user  '));
      await Promise.resolve();
    });

    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    expect(callsBeforeAuthority).toEqual({
      retry: 0,
      queue: 0,
      pull: 0,
      prune: 0,
      start: 0,
    });
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.processSyncQueue).toHaveBeenCalledTimes(1);
    expect(cloudSync.processCloudPull).toHaveBeenCalledTimes(1);
    expect(cloudSync.pruneSyncQueue).toHaveBeenCalledTimes(1);
    expect(cloudSync.loopStops).toHaveLength(1);
    await expectEveryListenerStartedWith('confirmed-cloud-user');
  });

  it('keeps an initial present Supabase session with an empty user id fail-closed', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();

    await act(async () => {
      session.resolve(supabaseSession(''));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(accountListeners.learning).not.toHaveBeenCalled();
    expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
    expect(useAuthStore.getState().cloudSession).toMatchObject({ user_id: '' });
    expect(cloudBoot.client.from).not.toHaveBeenCalled();
    expect(launchPromo.claim).not.toHaveBeenCalled();
    expect(cloudSync.retrySyncErrors).not.toHaveBeenCalled();
    expect(cloudSync.processSyncQueue).not.toHaveBeenCalled();
    expect(cloudSync.processCloudPull).not.toHaveBeenCalled();
    expect(cloudSync.pruneSyncQueue).not.toHaveBeenCalled();
    expect(cloudSync.startSyncLoop).not.toHaveBeenCalled();
    expect(queueAuthority.currentUserId()).toBeUndefined();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
  });

  it('tears down local scope for a live present Supabase session with a missing user id', async () => {
    cloudBoot.setConfigured(true);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');

    act(() => {
      cloudBoot.emitAuth({
        user: { email: 'missing-id@example.test' },
        expires_at: 4_102_444_800,
      });
    });

    expect(accountListeners.events.slice(-2)).toEqual([
      'stop:learning:stable-local-user',
      'stop:all-about-me:stable-local-user',
    ]);
    expect(accountListeners.learning).toHaveBeenCalledTimes(1);
    expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().cloudSession).toMatchObject({ user_id: '' });
  });

  it('skips cloud profile, promo, and sync work for a live whitespace-only user id', async () => {
    cloudBoot.setConfigured(true);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');
    const callsBeforeMalformedSession = {
      profile: cloudBoot.client.from.mock.calls.length,
      promo: launchPromo.claim.mock.calls.length,
      retry: cloudSync.retrySyncErrors.mock.calls.length,
      queue: cloudSync.processSyncQueue.mock.calls.length,
      pull: cloudSync.processCloudPull.mock.calls.length,
    };

    await act(async () => {
      cloudBoot.emitAuth(supabaseSession('   '));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect({
      profile: cloudBoot.client.from.mock.calls.length,
      promo: launchPromo.claim.mock.calls.length,
      retry: cloudSync.retrySyncErrors.mock.calls.length,
      queue: cloudSync.processSyncQueue.mock.calls.length,
      pull: cloudSync.processCloudPull.mock.calls.length,
    }).toEqual(callsBeforeMalformedSession);
    expect(useAuthStore.getState().cloudSession).toMatchObject({ user_id: '' });
    expect(queueAuthority.currentUserId()).toBeUndefined();
  });

  it.each([
    ['signed-out', null],
    ['malformed', supabaseSession('   ')],
  ] as const)(
    'stops the active cloud sync loop once for a live %s session',
    async (_label, nextSession) => {
      cloudBoot.setConfigured(true);
      const session = cloudBoot.deferSession();
      prepareAppIdentity({
        cloudSession: null,
        localUserId: 'stable-local-user',
      });

      render(<App />);
      await waitForAccountScopeBoot();
      await act(async () => {
        session.resolve(supabaseSession('cloud-user'));
        await Promise.resolve();
      });
      await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
      const stopLoop = cloudSync.loopStops[0]!;

      let sameTurnStopCalls = 0;
      act(() => {
        cloudBoot.emitAuth(nextSession);
        sameTurnStopCalls = stopLoop.mock.calls.length;
      });

      expect(sameTurnStopCalls).toBe(1);
      expect(queueAuthority.currentUserId()).toBeUndefined();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(stopLoop).toHaveBeenCalledTimes(1);
      expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1);
    },
  );

  it('restarts cloud sync after a later valid sign-in without duplicate concurrent loops', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    const firstStop = cloudSync.loopStops[0]!;

    act(() => {
      cloudBoot.emitAuth(null);
    });
    expect(firstStop).toHaveBeenCalledTimes(1);

    act(() => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2));
    const secondStop = cloudSync.loopStops[1]!;

    await act(async () => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();
  });

  it('waits for the previous loop to quiesce before starting the next cloud authority', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    const firstAuthority = cloudSync.startSyncLoop.mock.calls[0]?.[0];
    const firstStop = cloudSync.loopStops[0]!;
    const pendingStop = deferredValue<void>();
    firstStop.mockImplementationOnce(() => pendingStop.promise);

    act(() => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
    });

    expect(firstAuthority?.signal.aborted).toBe(true);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.pruneSyncQueue).toHaveBeenCalledTimes(1);
    expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingStop.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2));
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(2);
    expect(cloudSync.pruneSyncQueue).toHaveBeenCalledTimes(2);
    expect(cloudSync.startSyncLoop.mock.calls[1]?.[0]).toMatchObject({
      userId: 'cloud-user-b',
    });
  });

  it('lets only the latest authority start while an older loop is quiescing', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    const pendingStop = deferredValue<void>();
    cloudSync.loopStops[0]!.mockImplementationOnce(() => pendingStop.promise);

    act(() => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-b'));
      cloudBoot.emitAuth(supabaseSession('cloud-user-c'));
    });

    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingStop.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2));
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(2);
    expect(cloudSync.startSyncLoop.mock.calls[1]?.[0]).toMatchObject({
      userId: 'cloud-user-c',
    });
    expect(cloudSync.startSyncLoop.mock.calls.flatMap((call) => call[0]?.userId)).not.toContain(
      'cloud-user-b',
    );
  });

  it('does not duplicate startup when the same authority is reported while retry is pending', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    const pendingRetry = deferredValue<void>();
    cloudSync.retrySyncErrors.mockImplementationOnce(() => pendingRetry.promise);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1));

    act(() => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-a'));
    });
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.pruneSyncQueue).not.toHaveBeenCalled();
    expect(cloudSync.startSyncLoop).not.toHaveBeenCalled();

    await act(async () => {
      pendingRetry.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.pruneSyncQueue).toHaveBeenCalledTimes(1);
    expect(cloudSync.startSyncLoop.mock.calls[0]?.[0]).toMatchObject({
      userId: 'cloud-user-a',
    });
  });

  it('keeps a remount behind the previous cloud loop quiescence barrier', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    const firstMount = render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      session.resolve(supabaseSession('cloud-user-a'));
      await Promise.resolve();
    });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1));
    const firstAuthority = cloudSync.startSyncLoop.mock.calls[0]?.[0];
    const pendingStop = deferredValue<void>();
    cloudSync.loopStops[0]!.mockImplementationOnce(() => pendingStop.promise);

    firstMount.unmount();
    render(<App />);
    await waitFor(
      () => expect(bootListeners.runtime).toHaveBeenCalledTimes(2),
      ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(firstAuthority?.signal.aborted).toBe(true);
    expect(cloudSync.loopStops[0]).toHaveBeenCalledTimes(1);
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1);
    expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingStop.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2));
    expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(2);
    expect(cloudSync.startSyncLoop.mock.calls[1]?.[0]).toMatchObject({
      userId: 'cloud-user-a',
    });
  });

  it('does not continue delayed valid sync startup after authority becomes malformed', async () => {
    cloudBoot.setConfigured(true);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();
    cloudSync.retrySyncErrors.mockClear();
    cloudSync.processSyncQueue.mockClear();
    cloudSync.processCloudPull.mockClear();
    cloudSync.pruneSyncQueue.mockClear();
    cloudSync.startSyncLoop.mockClear();
    const pendingRetry = deferredValue<void>();
    cloudSync.retrySyncErrors.mockImplementationOnce(() => pendingRetry.promise);

    act(() => {
      cloudBoot.emitAuth(supabaseSession('stale-cloud-user'));
    });
    await waitFor(() => expect(cloudSync.retrySyncErrors).toHaveBeenCalledTimes(1));

    act(() => {
      cloudBoot.emitAuth(supabaseSession('   '));
    });
    await act(async () => {
      pendingRetry.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cloudSync.processSyncQueue).not.toHaveBeenCalled();
    expect(cloudSync.processCloudPull).not.toHaveBeenCalled();
    expect(cloudSync.pruneSyncQueue).not.toHaveBeenCalled();
    expect(cloudSync.startSyncLoop).not.toHaveBeenCalled();
  });

  it.each(['event-first', 'error-first'] as const)('never grants local readiness from INITIAL_SESSION/null plus getSession error (%s)', async (ordering) => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      if (ordering === 'event-first') cloudBoot.emitAuth(null, 'INITIAL_SESSION');
      session.fail(new Error('initial read failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (ordering === 'error-first') cloudBoot.emitAuth(null, 'INITIAL_SESSION');
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    expect(accountListeners.learning).not.toHaveBeenCalled();
    expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
  });

  it('ignores a late INITIAL_SESSION/null after newer verified cloud authority', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => {
      cloudBoot.emitAuth(supabaseSession('cloud-user-new'));
      cloudBoot.emitAuth(null, 'INITIAL_SESSION');
      session.resolve(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('cloud-user-new');
    expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
      state: 'cloud',
      accountId: 'cloud-user-new',
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
  });

  it('publishes local recovery readiness only after the prior cloud loop settles', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => { session.resolve(supabaseSession('cloud-user-a')); });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalled());
    const teardown = deferredValue<void>();
    cloudSync.loopStops.at(-1)!.mockImplementation(() => teardown.promise);
    await act(async () => { cloudBoot.emitAuth(null, 'SIGNED_OUT'); });
    expect(getLocalAccountReadyReceipt()).toBeNull();
    await act(async () => { teardown.resolve(); await teardown.promise; });
    await waitFor(() => expect(getLocalAccountReadyReceipt()?.accountId).toBe('stable-local-user'));
  });

  it('independent review: a cloud/local/cloud ABA cannot publish stale local readiness after teardown', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => { session.resolve(supabaseSession('cloud-user-a')); });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalled());
    const teardown = deferredValue<void>();
    cloudSync.loopStops.at(-1)!.mockImplementation(() => teardown.promise);
    await act(async () => {
      cloudBoot.emitAuth(null, 'SIGNED_OUT');
      cloudBoot.emitAuth(supabaseSession('cloud-user-a'), 'SIGNED_IN');
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
    await act(async () => { teardown.resolve(); await teardown.promise; });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalledTimes(2));
    expect(getLocalAccountReadyReceipt()).toBeNull();
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('cloud-user-a');
    await act(async () => { cloudBoot.emitAuth(null, 'SIGNED_OUT'); });
    await waitFor(() => expect(getLocalAccountReadyReceipt()?.accountId).toBe('stable-local-user'));
  });

  it('independent review: local owner ABA while a teardown is pending cannot restore the old receipt', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({ cloudSession: null, localUserId: 'stable-local-user' });
    render(<App />);
    await waitForAccountScopeBoot();
    await act(async () => { session.resolve(supabaseSession('cloud-user-a')); });
    await waitFor(() => expect(cloudSync.startSyncLoop).toHaveBeenCalled());
    const teardown = deferredValue<void>();
    cloudSync.loopStops.at(-1)!.mockImplementation(() => teardown.promise);
    await act(async () => {
      cloudBoot.emitAuth(null, 'SIGNED_OUT');
      useAuthStore.setState({ localUserId: 'other-local-user' });
      useAuthStore.setState({ localUserId: 'stable-local-user' });
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
    await act(async () => { teardown.resolve(); await teardown.promise; });
    await waitFor(() => expect(getLocalAccountReadyReceipt()?.accountId).toBe('stable-local-user'));
    expect(getLocalAccountReadyReceipt()?.persistenceGeneration).toBeGreaterThan(0);
    expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
      state: 'local',
      accountId: 'stable-local-user',
      localReadinessGeneration: getLocalAccountReadyReceipt()?.generation,
    });
  });

  it('remains fail-closed when configured Supabase session recovery rejects', async () => {
    cloudBoot.setConfigured(true);
    const session = cloudBoot.deferSession();
    prepareAppIdentity({
      cloudSession: cloudSession('persisted-cloud-user'),
      localUserId: 'stable-local-user',
    });
    useAuthStore.setState({ plan: 'pro' });

    render(<App />);
    await waitForAccountScopeBoot();

    await act(async () => {
      session.reject(new Error('session unavailable'));
      await Promise.resolve();
    });

    expect(accountListeners.learning).not.toHaveBeenCalled();
    expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
    expect(bootListeners.runtime).toHaveBeenCalledTimes(1);
    expect(document.querySelector('main[aria-label="Workspace"]')).not.toBeNull();
    expect(queueAuthority.currentUserId()).toBeUndefined();
    expect(useAuthStore.getState()).toMatchObject({
      cloudSession: null,
      plan: 'free',
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
  });

  it('remains fail-closed when Supabase configuration detection fails', async () => {
    cloudBoot.failConfigurationCheck(new Error('configuration unavailable'));
    prepareAppIdentity({
      cloudSession: cloudSession('persisted-cloud-user'),
      localUserId: 'stable-local-user',
    });
    useAuthStore.setState({ plan: 'pro' });

    render(<App />);
    await waitForAccountScopeBoot();

    expect(accountListeners.learning).not.toHaveBeenCalled();
    expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
    expect(bootListeners.runtime).toHaveBeenCalledTimes(1);
    expect(document.querySelector('main[aria-label="Workspace"]')).not.toBeNull();
    expect(queueAuthority.currentUserId()).toBeUndefined();
    expect(useAuthStore.getState()).toMatchObject({
      cloudSession: null,
      plan: 'free',
    });
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
  });

  it.each([
    ['blank', '   '],
    ['unverified', 'unverified-cloud-user'],
  ] as const)(
    'starts no scoped listener when a %s cloud id is present at the Phase 4 boot boundary',
    async (_label, userId) => {
      const divergentCloudSession = cloudSession(userId);
      prepareAppIdentity({
        cloudSession: divergentCloudSession,
        localUserId: 'stable-local-user',
      });
      useJarvisLearningStore.getState().setAccount('previous-private-account');
      useJarvisLearningStore.getState().remember({
        value: 'Previous private learning',
        category: 'personal',
        source: { kind: 'explicit' },
      });
      useAllAboutMeStore.getState().setAccountScope('previous-private-account');
      useAllAboutMeStore.getState().setMarkdown('# All About Me\n\nPrevious private profile');
      seedCanonicalTaskProjection(
        'previous-private-scope',
        'previous-private-run',
        'Previous private task',
      );
      const stopPhaseBoundary = useAgentStore.subscribe((state, previous) => {
        if (Object.keys(previous.agents).length === 0 && Object.keys(state.agents).length > 0) {
          useAuthStore.setState({ cloudSession: divergentCloudSession });
        }
      });

      try {
        render(<App />);
        await waitForAccountScopeBoot();

        await waitFor(() => {
          expect(document.querySelector('main[aria-label="Workspace"]')).not.toBeNull();
        });
        expect(accountListeners.learning).not.toHaveBeenCalled();
        expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
        expect(kernelHost.openLiveEvidenceAccount).not.toHaveBeenCalled();
        expect(queueAuthority.currentUserId()).toBeUndefined();
        expect(useAuthStore.getState().localUserId).toBe('stable-local-user');
        expect(useJarvisLearningStore.getState()).toMatchObject({
          activeAccountId: '',
          profiles: {},
          history: {},
        });
        expect(useAllAboutMeStore.getState()).toMatchObject({
          accountScope: '',
          markdown: '',
        });
        expect(useJarvisTaskRunStore.getState()).toMatchObject({
          accountScope: '',
          runs: {},
        });
        expect(
          JSON.stringify({
            learning: useJarvisLearningStore.getState(),
            profile: useAllAboutMeStore.getState(),
          }),
        ).not.toContain('local-unassigned');
      } finally {
        stopPhaseBoundary();
      }
    },
  );

  it('quarantines private state in the same turn a live blank cloud id tears down the scope', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    const finishLearningFlush = accountListeners.deferStop('learning', 'stable-local-user');
    const finishProfileFlush = accountListeners.deferStop('all-about-me', 'stable-local-user');

    render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');
    useJarvisLearningStore.getState().setAccount('stable-local-user');
    useJarvisLearningStore.getState().remember({
      value: 'Stable user private learning',
      category: 'personal',
      source: { kind: 'explicit' },
    });
    useAllAboutMeStore.getState().setAccountScope('stable-local-user');
    useAllAboutMeStore.getState().setMarkdown('# All About Me\n\nStable user profile');
    seedCanonicalTaskProjection(
      'stable-local-scope',
      'stable-local-run',
      'Stable local private task',
    );

    let sameTurnState:
      | {
          learningAccountId: string;
          learningProfileIds: string[];
          profileScope: string;
          profileMarkdown: string;
          taskScope: string;
          taskRunIds: string[];
        }
      | undefined;
    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('   ') });
      sameTurnState = {
        learningAccountId: useJarvisLearningStore.getState().activeAccountId,
        learningProfileIds: Object.keys(useJarvisLearningStore.getState().profiles),
        profileScope: useAllAboutMeStore.getState().accountScope,
        profileMarkdown: useAllAboutMeStore.getState().markdown,
        taskScope: useJarvisTaskRunStore.getState().accountScope,
        taskRunIds: Object.keys(useJarvisTaskRunStore.getState().runs),
      };
    });

    await waitFor(() => {
      expect(accountListeners.events.slice(-2)).toEqual([
        'stop:learning:stable-local-user',
        'stop:all-about-me:stable-local-user',
      ]);
    });
    await act(async () => {
      finishLearningFlush();
      finishProfileFlush();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.querySelector('main[aria-label="Workspace"]')).not.toBeNull();
    });
    expect(accountListeners.learning).toHaveBeenCalledTimes(1);
    expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().localUserId).toBe('stable-local-user');
    expect(useJarvisLearningStore.getState()).toMatchObject({
      activeAccountId: '',
      profiles: {},
      history: {},
    });
    expect(useAllAboutMeStore.getState()).toMatchObject({
      accountScope: '',
      markdown: '',
    });
    expect(useJarvisTaskRunStore.getState()).toMatchObject({
      accountScope: '',
      runs: {},
    });
    expect(sameTurnState).toEqual({
      learningAccountId: '',
      learningProfileIds: [],
      profileScope: '',
      profileMarkdown: '',
      taskScope: '',
      taskRunIds: [],
    });
  });

  it('starts every scoped listener with the exact signed-out local account id', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'signed-out-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();

    await expectEveryListenerStartedWith('signed-out-local-user');
  });

  it('starts every scoped listener with the exact authenticated cloud account id', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    render(<App />);
    await waitForAccountScopeBoot();

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('cloud-user') });
    });

    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(2);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(2);
    });

    await expectEveryListenerStartedWith('cloud-user', 1);
    expect(useAuthStore.getState().localUserId).toBe('stable-local-user');
  });

  it('waits for pending learning and All About Me flushes before starting a new account', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    const finishLearningFlush = accountListeners.deferStop('learning', 'stable-local-user');
    const finishProfileFlush = accountListeners.deferStop('all-about-me', 'stable-local-user');

    render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');
    useJarvisLearningStore.getState().setAccount('stable-local-user');
    useJarvisLearningStore.getState().remember({
      value: 'Private learning pending flush',
      category: 'personal',
      source: { kind: 'explicit' },
    });
    useAllAboutMeStore.getState().setAccountScope('stable-local-user');
    useAllAboutMeStore.getState().setMarkdown('# All About Me\n\nPrivate pending profile');
    seedCanonicalTaskProjection(
      'stable-local-scope',
      'pending-private-run',
      'Pending private task',
    );

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('cloud-user') });
    });
    await waitFor(() => {
      expect(accountListeners.events.slice(-2)).toEqual([
        'stop:learning:stable-local-user',
        'stop:all-about-me:stable-local-user',
      ]);
    });
    expect(accountListeners.learning).toHaveBeenCalledTimes(1);
    expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    expect(useJarvisLearningStore.getState().profiles).toEqual({});
    expect(useAllAboutMeStore.getState()).toMatchObject({
      accountScope: '',
      markdown: '',
    });
    expect(useJarvisTaskRunStore.getState()).toMatchObject({
      accountScope: '',
      runs: {},
    });

    await act(async () => {
      finishLearningFlush();
      await Promise.resolve();
    });
    expect(accountListeners.events).toContain('flush:learning:stable-local-user');
    expect(accountListeners.learning).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishProfileFlush();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(2);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(2);
    });
    await expectEveryListenerStartedWith('cloud-user', 1);
  });

  it('invalidates a pending valid switch when identity becomes malformed during teardown', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    const finishLearningFlush = accountListeners.deferStop('learning', 'stable-local-user');
    const finishProfileFlush = accountListeners.deferStop('all-about-me', 'stable-local-user');

    render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('stale-cloud-target') });
    });
    await waitFor(() => {});

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('   ') });
    });
    await act(async () => {
      finishLearningFlush();
      finishProfileFlush();
      await Promise.resolve();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(accountListeners.learning).toHaveBeenCalledTimes(1);
    expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    expect(accountListeners.events).not.toContain('start:learning:stale-cloud-target');
    expect(useJarvisLearningStore.getState().profiles).toEqual({});
    expect(useAllAboutMeStore.getState().markdown).toBe('');
    expect(useJarvisTaskRunStore.getState().runs).toEqual({});
  });

  it('keeps a StrictMode-style remount behind the previous account flush', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    const firstMount = render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');
    const finishLearningFlush = accountListeners.deferStop('learning', 'stable-local-user');
    const finishProfileFlush = accountListeners.deferStop('all-about-me', 'stable-local-user');

    firstMount.unmount();
    render(<App />);
    await waitFor(
      () => expect(bootListeners.runtime).toHaveBeenCalledTimes(2),
      ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
    );

    try {
      expect(accountListeners.learning).toHaveBeenCalledTimes(1);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        finishLearningFlush();
        finishProfileFlush();
        await Promise.resolve();
      });
    }
    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(2);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(2);
    });
  });

  it('tears down every old scope before starting the new account and preserves the local id', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });

    const { unmount } = render(<App />);
    await waitForAccountScopeBoot();
    await expectEveryListenerStartedWith('stable-local-user');
    const initialApiKeys = useAuthStore.getState().apiKeys;

    act(() => {
      useAuthStore.setState({ cloudSession: cloudSession('cloud-user') });
    });

    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(2);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(2);
    });

    expect(accountListeners.events).toEqual([
      'start:learning:stable-local-user',
      'start:all-about-me:stable-local-user',
      'stop:learning:stable-local-user',
      'stop:all-about-me:stable-local-user',
      'start:learning:cloud-user',
      'start:all-about-me:cloud-user',
    ]);
    await expectEveryListenerStartedWith('cloud-user', 1);
    expect(useAuthStore.getState().localUserId).toBe('stable-local-user');
    expect(useAuthStore.getState().apiKeys).toBe(initialApiKeys);
    expect(useAuthStore.getState().apiKeys).toEqual({ mock: 'test-model-access' });

    act(() => {
      useAuthStore.setState({ cloudSession: null });
    });

    await waitFor(() => {
      expect(accountListeners.learning).toHaveBeenCalledTimes(3);
      expect(accountListeners.allAboutMe).toHaveBeenCalledTimes(3);
    });

    expect(accountListeners.events.slice(6)).toEqual([
      'stop:learning:cloud-user',
      'stop:all-about-me:cloud-user',
      'start:learning:stable-local-user',
      'start:all-about-me:stable-local-user',
    ]);
    expect(useAuthStore.getState().localUserId).toBe('stable-local-user');
    expect(useAuthStore.getState().apiKeys).toBe(initialApiKeys);
    expect(useAuthStore.getState().apiKeys).toEqual({ mock: 'test-model-access' });

    unmount();
    expect(accountListeners.events.slice(-2)).toEqual([
      'stop:learning:stable-local-user',
      'stop:all-about-me:stable-local-user',
    ]);
  });

  it('does not register listeners when an awaited agent boot resolves after unmount', async () => {
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    const agentList = deferredValue<never[]>();
    bootStorage.listAgents.mockImplementationOnce(() => agentList.promise);

    const mounted = render(<App />);
    try {
      await waitFor(
        () => expect(bootStorage.listAgents).toHaveBeenCalledTimes(1),
        ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
      );

      mounted.unmount();
      await act(async () => {
        agentList.resolve([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(accountListeners.learning).not.toHaveBeenCalled();
      expect(accountListeners.allAboutMe).not.toHaveBeenCalled();
      expect(bootListeners.runtime).not.toHaveBeenCalled();
      expect(useAgentStore.getState().agents).toEqual({});
    } finally {
      mounted.unmount();
      await act(async () => {
        agentList.resolve([]);
        await Promise.resolve();
      });
    }
  });

  it('ignores a delayed subscription tier from a former cloud account', async () => {
    cloudBoot.setConfigured(true);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    useAuthStore.setState({ plan: 'free' });
    const accountAPlan = deferredValue<{
      data: { tier: string } | null;
      error: null;
    }>();
    const accountBPlan = deferredValue<{
      data: { tier: string } | null;
      error: null;
    }>();
    cloudBoot.maybeSingle
      .mockImplementationOnce(() => accountAPlan.promise)
      .mockImplementationOnce(() => accountBPlan.promise);

    render(<App />);
    await waitForAccountScopeBoot();
    expect(cloudBoot.onAuthStateChange).toHaveBeenCalledTimes(1);

    act(() => cloudBoot.emitAuth(supabaseSession('cloud-user-a')));
    await waitFor(() => expect(cloudBoot.maybeSingle).toHaveBeenCalledTimes(1));

    act(() => cloudBoot.emitAuth(supabaseSession('cloud-user-b')));
    await waitFor(() => expect(cloudBoot.maybeSingle).toHaveBeenCalledTimes(2));

    await act(async () => {
      accountBPlan.resolve({ data: { tier: 'pro' }, error: null });
      await accountBPlan.promise;
    });
    await waitFor(() => expect(useAuthStore.getState().plan).toBe('pro'));

    await act(async () => {
      accountAPlan.resolve({ data: { tier: 'apex' }, error: null });
      await accountAPlan.promise;
    });

    expect(useAuthStore.getState().cloudSession?.user_id).toBe('cloud-user-b');
    expect(useAuthStore.getState().plan).toBe('pro');
  }, 10_000);

  it('fails closed to the free tier while a new or signed-out authority has no verified profile', async () => {
    cloudBoot.setConfigured(true);
    prepareAppIdentity({
      cloudSession: null,
      localUserId: 'stable-local-user',
    });
    useAuthStore.setState({ plan: 'apex' });
    const accountBPlan = deferredValue<{
      data: { tier: string } | null;
      error: null;
    }>();
    cloudBoot.maybeSingle
      .mockResolvedValueOnce({ data: { tier: 'pro' }, error: null })
      .mockImplementationOnce(() => accountBPlan.promise);

    render(<App />);
    await waitFor(
      () => expect(cloudBoot.onAuthStateChange).toHaveBeenCalledTimes(1),
      ACCOUNT_SCOPE_BOOT_WAIT_OPTIONS,
    );

    act(() => cloudBoot.emitAuth(supabaseSession('cloud-user-a')));
    await waitFor(() => expect(useAuthStore.getState().plan).toBe('pro'));

    act(() => cloudBoot.emitAuth(supabaseSession('cloud-user-b')));
    expect(useAuthStore.getState().plan).toBe('free');
    expect(queueAuthority.currentUserId()).toBe('cloud-user-b');

    act(() => cloudBoot.emitAuth(null));
    expect(useAuthStore.getState().plan).toBe('free');
  });
}

describe(
  'App canonical account identity boot',
  { timeout: ACCOUNT_SCOPE_BOOT_TEST_TIMEOUT },
  accountIdentityBootSuite,
);

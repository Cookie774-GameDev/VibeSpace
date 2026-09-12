export interface HarnessScope {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  workingDirectory?: string;
}

export interface OpenCodeRuntimeHandle {
  generation: string;
  dispose(): Promise<void>;
}

export interface OpenCodeRuntimeSupervisor {
  start(scope: HarnessScope): Promise<OpenCodeRuntimeHandle>;
}

export interface OpenCodeSessionClient {
  createSession(input: { scope: HarnessScope; title?: string }): Promise<{ id: string }>;
  getSession?(sessionId: string): Promise<{ id: string } | null>;
  abort(sessionId: string): Promise<void>;
}

export interface OpenCodeClientFactory {
  connect(handle: OpenCodeRuntimeHandle): Promise<OpenCodeSessionClient>;
}

export interface PersistedSessionMapping {
  sessionId: string;
  runtimeGeneration: string;
}

export interface OpenCodeSessionRegistry {
  load(scopeKey: string, chatId: string): Promise<PersistedSessionMapping | null>;
  save(scopeKey: string, chatId: string, mapping: PersistedSessionMapping): Promise<void>;
  remove(scopeKey: string, chatId: string): Promise<void>;
}

interface RuntimeEntry {
  scope: HarnessScope;
  handle: OpenCodeRuntimeHandle;
  client: OpenCodeSessionClient;
  lastUsedAt: number;
  sessions: Map<string, string>;
  sessionStarting: Map<string, Promise<string>>;
  disposed: boolean;
}

function cleanScopePart(value: string | undefined, required = false): string {
  const clean = value?.trim() ?? '';
  if ((required && !clean) || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error('invalid_harness_scope');
  }
  return clean;
}

export function openCodeScopeKey(scope: Readonly<HarnessScope>): string {
  return JSON.stringify([
    cleanScopePart(scope.accountId, true),
    cleanScopePart(scope.workspaceId),
    cleanScopePart(scope.projectId),
    cleanScopePart(scope.worktreeId),
    cleanScopePart(scope.workingDirectory),
  ]);
}

function legacyOpenCodeScopeKeys(scope: Readonly<HarnessScope>): readonly string[] {
  return [
    JSON.stringify([
      cleanScopePart(scope.accountId, true),
      cleanScopePart(scope.projectId),
      cleanScopePart(scope.workingDirectory),
    ]),
  ];
}

/**
 * Owns warm OpenCode runtime scopes. A chat maps to a session, never a process.
 * Readiness and per-chat session creation are single-flight. Disposal is
 * generation-safe so a late server start cannot leak after a scope/app shutdown.
 */
export class OpenCodeSessionPool {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly starting = new Map<string, Promise<RuntimeEntry>>();
  private readonly scopeEpoch = new Map<string, number>();
  private readonly chatRequests = new Map<
    string,
    Promise<{
      client: OpenCodeSessionClient;
      sessionId: string;
      runtimeGeneration: string;
    }>
  >();
  private globalEpoch = 0;

  constructor(
    private readonly supervisor: OpenCodeRuntimeSupervisor,
    private readonly clientFactory: OpenCodeClientFactory,
    private readonly options: {
      maxWarmScopes?: number;
      now?: () => number;
      registry?: OpenCodeSessionRegistry;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private epochFor(key: string): number {
    return this.scopeEpoch.get(key) ?? 0;
  }

  private async createEntry(scope: HarnessScope): Promise<RuntimeEntry> {
    const handle = await this.supervisor.start(scope);
    try {
      const client = await this.clientFactory.connect(handle);
      return {
        scope: { ...scope },
        handle,
        client,
        lastUsedAt: this.now(),
        sessions: new Map(),
        sessionStarting: new Map(),
        disposed: false,
      };
    } catch (error) {
      await handle.dispose().catch(() => undefined);
      throw error;
    }
  }

  async ensureReady(scope: HarnessScope): Promise<RuntimeEntry> {
    const key = openCodeScopeKey(scope);
    const existing = this.entries.get(key);
    if (existing && !existing.disposed) {
      existing.lastUsedAt = this.now();
      return existing;
    }
    const activeStart = this.starting.get(key);
    if (activeStart) return activeStart;

    const scopeEpoch = this.epochFor(key);
    const globalEpoch = this.globalEpoch;
    const start = this.createEntry(scope)
      .then(async (entry) => {
        if (scopeEpoch !== this.epochFor(key) || globalEpoch !== this.globalEpoch) {
          entry.disposed = true;
          await entry.handle.dispose().catch(() => undefined);
          throw new Error('HARNESS_SCOPE_DISPOSED_DURING_START');
        }
        this.entries.set(key, entry);
        await this.enforceLimit(key);
        return entry;
      })
      .finally(() => {
        if (this.starting.get(key) === start) this.starting.delete(key);
      });
    this.starting.set(key, start);
    return start;
  }

  private async disposeEntry(key: string, entry: RuntimeEntry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    this.entries.delete(key);
    entry.sessions.clear();
    entry.sessionStarting.clear();
    await entry.handle.dispose();
  }

  private async enforceLimit(protectedKey: string): Promise<void> {
    const maxWarmScopes = Math.max(1, this.options.maxWarmScopes ?? 1);
    while (this.entries.size > maxWarmScopes) {
      const candidate = [...this.entries.entries()]
        .filter(([key, entry]) => key !== protectedKey && !entry.disposed)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!candidate) return;
      await this.disposeEntry(candidate[0], candidate[1]);
    }
  }

  private async createOrRestoreSession(
    key: string,
    entry: RuntimeEntry,
    chatId: string,
    title?: string,
  ): Promise<string> {
    if (entry.disposed) throw new Error('HARNESS_SCOPE_DISPOSED');
    const registry = this.options.registry;
    let persistedKey = key;
    let persisted = (await registry?.load(key, chatId)) ?? null;
    if (!persisted && registry) {
      for (const legacyKey of legacyOpenCodeScopeKeys(entry.scope)) {
        if (legacyKey === key) continue;
        const candidate = await registry.load(legacyKey, chatId);
        if (candidate) {
          persisted = candidate;
          persistedKey = legacyKey;
          break;
        }
      }
    }
    if (entry.disposed) throw new Error('HARNESS_SCOPE_DISPOSED');
    if (persisted?.runtimeGeneration === entry.handle.generation) {
      const valid = entry.client.getSession
        ? await entry.client.getSession(persisted.sessionId).catch(() => null)
        : { id: persisted.sessionId };
      if (valid?.id === persisted.sessionId) {
        if (entry.disposed) throw new Error('HARNESS_SCOPE_DISPOSED');
        entry.sessions.set(chatId, persisted.sessionId);
        if (registry && persistedKey !== key) {
          await registry.save(key, chatId, persisted).catch(() => undefined);
        }
        return persisted.sessionId;
      }
    }
    const created = await entry.client.createSession({ scope: entry.scope, title });
    if (!created.id.trim()) throw new Error('HARNESS_SESSION_ID_MISSING');
    if (entry.disposed) {
      await entry.client.abort(created.id).catch(() => undefined);
      throw new Error('HARNESS_SCOPE_DISPOSED');
    }
    entry.sessions.set(chatId, created.id);
    await this.options.registry?.save(key, chatId, {
      sessionId: created.id,
      runtimeGeneration: entry.handle.generation,
    });
    return created.id;
  }

  /** Public, bounded access to the warm scope client without exposing internal entry state. */
  async clientForScope(scope: HarnessScope): Promise<{
    client: OpenCodeSessionClient;
    runtimeGeneration: string;
  }> {
    const entry = await this.ensureReady(scope);
    if (entry.disposed) throw new Error('HARNESS_SCOPE_DISPOSED');
    entry.lastUsedAt = this.now();
    return { client: entry.client, runtimeGeneration: entry.handle.generation };
  }

  async sessionForChat(scope: HarnessScope, chatId: string, title?: string): Promise<{
    client: OpenCodeSessionClient;
    sessionId: string;
    runtimeGeneration: string;
  }> {
    const cleanChatId = cleanScopePart(chatId, true);
    const key = openCodeScopeKey(scope);
    const requestKey = `${key}\u0000${cleanChatId}`;
    let request = this.chatRequests.get(requestKey);
    if (!request) {
      request = (async () => {
        const entry = await this.ensureReady(scope);
        if (entry.disposed) throw new Error('HARNESS_SCOPE_DISPOSED');
        let sessionId = entry.sessions.get(cleanChatId);
        if (!sessionId) {
          let creating = entry.sessionStarting.get(cleanChatId);
          if (!creating) {
            creating = this.createOrRestoreSession(key, entry, cleanChatId, title)
              .finally(() => entry.sessionStarting.delete(cleanChatId));
            entry.sessionStarting.set(cleanChatId, creating);
          }
          sessionId = await creating;
        }
        entry.lastUsedAt = this.now();
        return { client: entry.client, sessionId, runtimeGeneration: entry.handle.generation };
      })().finally(() => {
        if (this.chatRequests.get(requestKey) === request) this.chatRequests.delete(requestKey);
      });
      this.chatRequests.set(requestKey, request);
    }
    return request;
  }

  async cancelChat(scope: HarnessScope, chatId: string): Promise<void> {
    const cleanChatId = cleanScopePart(chatId, true);
    const key = openCodeScopeKey(scope);
    const inFlight = this.chatRequests.get(`${key}\u0000${cleanChatId}`);
    if (inFlight) {
      const session = await inFlight.catch(() => undefined);
      if (session) await session.client.abort(session.sessionId);
      return;
    }
    const entry = this.entries.get(key);
    if (!entry || entry.disposed) return;
    const sessionId = entry.sessions.get(cleanChatId);
    if (!sessionId) return;
    await entry.client.abort(sessionId);
  }

  /** Crash/recovery path: invalidate one generation without touching visible chat history. */
  async invalidateScope(scope: HarnessScope): Promise<void> {
    await this.disposeScope(scope);
  }

  async forgetChat(scope: HarnessScope, chatId: string): Promise<void> {
    const key = openCodeScopeKey(scope);
    this.entries.get(key)?.sessions.delete(chatId.trim());
    await this.options.registry?.remove(key, chatId.trim());
  }

  async disposeScope(scope: HarnessScope): Promise<void> {
    const key = openCodeScopeKey(scope);
    this.scopeEpoch.set(key, this.epochFor(key) + 1);
    const entry = this.entries.get(key);
    if (entry) await this.disposeEntry(key, entry);
    // Do not dispose a resolving start twice; its captured epoch forces self-disposal.
    await this.starting.get(key)?.catch(() => undefined);
  }

  async disposeAll(): Promise<void> {
    this.globalEpoch += 1;
    for (const key of new Set([...this.entries.keys(), ...this.starting.keys()])) {
      this.scopeEpoch.set(key, this.epochFor(key) + 1);
    }
    const entries = [...this.entries.entries()];
    await Promise.allSettled(entries.map(([key, entry]) => this.disposeEntry(key, entry)));
    await Promise.allSettled([...this.starting.values()]);
    this.entries.clear();
    this.starting.clear();
  }

  get warmScopeCount(): number {
    return [...this.entries.values()].filter((entry) => !entry.disposed).length;
  }
}

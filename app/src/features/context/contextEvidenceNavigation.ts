import { db, type JarvisDexie, type SettingsRow } from '@/lib/db';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import {
  getStoredProjectRoot,
  ROOT_PREFIX,
  projectStorageKey,
} from '@/features/files/projectFiles';
import type { ChatId, MessageId, ProjectId } from '@/types/common';
import { contextSelectionSettingKey } from './migration';
import {
  createContextEvidenceLinkStore,
  type ContextEvidenceLinkScope,
} from './contextEvidenceLinks';
import type {
  createProductionContextEvidenceRevalidator,
  RevalidatedContextEvidenceTarget,
} from './contextRlmProduction';
import type { ContextSelectionGuard } from './contextPersistence';

export type ContextEvidenceRevalidator = ReturnType<
  typeof createProductionContextEvidenceRevalidator
>;
export class ContextEvidenceNavigationError extends Error {
  constructor(readonly code: 'unavailable' | 'revoked') {
    super(`context_evidence_navigation_${code}`);
  }
}
export function isContextEvidenceUri(uri: string | undefined): boolean {
  return typeof uri === 'string' && /^vibespace:(?:\/\/)?context(?:\/|$)/iu.test(uri);
}
export type ContextEvidenceNavigationTicket = Readonly<{
  target: RevalidatedContextEvidenceTarget;
  guard: ContextSelectionGuard;
  assertCurrent(): void;
  complete(): void;
  fail(): void;
}>;
export interface ContextEvidenceNavigationOptions {
  database?: JarvisDexie;
  revalidate?: ContextEvidenceRevalidator;
  timeoutMs?: number;
}

function captureScope(chatId: string): ContextEvidenceLinkScope | undefined {
  const auth = useAuthStore.getState(),
    account = resolveAccountIdentity(auth);
  if (
    !account ||
    !auth.workspaceId ||
    !auth.projectId ||
    useUIStore.getState().activeChatId !== chatId
  )
    return undefined;
  const worktreeId = getStoredProjectRoot(auth.projectId).trim();
  return Object.freeze({
    accountId: account.accountId,
    accountSource: account.source,
    workspaceId: String(auth.workspaceId),
    projectId: String(auth.projectId),
    chatId,
    ...(worktreeId ? { worktreeId } : {}),
  });
}
const identityPart = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

/** The queue is private, one-use and bound to an explicit current UI click. */
export function createContextEvidenceNavigation(options: ContextEvidenceNavigationOptions = {}) {
  const database = options.database ?? db;
  const backing = createContextEvidenceLinkStore(database);
  const revalidate: ContextEvidenceRevalidator =
    options.revalidate ??
    (async (input) => {
      input.signal.throwIfAborted();
      input.assertCurrent();
      const production = await import('./contextRlmProduction');
      input.signal.throwIfAborted();
      input.assertCurrent();
      return production.createProductionContextEvidenceRevalidator()(input);
    });
  const timeoutMs = Math.max(1, Math.min(30_000, options.timeoutMs ?? 30_000));
  const listeners = new Set<() => void>();
  let disposed = false;
  let epoch = 0;
  type Operation = {
    epoch: number;
    scope: ContextEvidenceLinkScope;
    controller: AbortController;
    settled: boolean;
    consumed: boolean;
    expectedRoute: ReturnType<typeof useUIStore.getState>['route'];
    switchingRoute: boolean;
    ticket?: ContextEvidenceNavigationTicket;
    cleanup: () => void;
    resolve: () => void;
    reject: (error: ContextEvidenceNavigationError) => void;
  };
  let active: Operation | undefined;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const finish = (operation: Operation, error?: ContextEvidenceNavigationError) => {
    if (operation.settled) return;
    operation.settled = true;
    operation.cleanup();
    if (active === operation) active = undefined;
    operation.controller.abort();
    if (error) operation.reject(error);
    else operation.resolve();
    notify();
  };
  const cancel = () => {
    epoch++;
    if (active) finish(active, new ContextEvidenceNavigationError('revoked'));
  };
  const check = (operation: Operation) => {
    operation.controller.signal.throwIfAborted();
    if (
      disposed ||
      active !== operation ||
      operation.settled ||
      operation.epoch !== epoch ||
      JSON.stringify(captureScope(operation.scope.chatId)) !== JSON.stringify(operation.scope) ||
      useUIStore.getState().route !==
        (operation.switchingRoute ? 'context' : operation.expectedRoute)
    )
      throw new ContextEvidenceNavigationError('revoked');
  };
  async function readOwnedMessage(operation: Operation, messageId: string, uri: string) {
    check(operation);
    const { scope } = operation;
    const [message, chat, project] = await database.transaction(
      'r',
      [database.messages, database.chats, database.projects],
      () =>
        Promise.all([
          database.messages.get(messageId as MessageId),
          database.chats.get(scope.chatId as ChatId),
          database.projects.get(scope.projectId as ProjectId),
        ]),
    );
    check(operation);
    if (
      !message ||
      message.role !== 'assistant' ||
      String(message.chat_id) !== scope.chatId ||
      !chat ||
      chat.archived ||
      String(chat.workspace_id) !== scope.workspaceId ||
      String(chat.project_id ?? '') !== scope.projectId ||
      !project ||
      String(project.workspace_id) !== scope.workspaceId
    ) {
      throw new ContextEvidenceNavigationError('unavailable');
    }
    const sources = message.parts.filter(
      (part) =>
        part.kind === 'jarvis_source_ref' &&
        part.source.uri === uri &&
        part.source.kind === 'context_node' &&
        part.source.trust === 'app_verified' &&
        part.source.sensitivity !== 'restricted' &&
        part.source.sensitivity !== 'secret',
    );
    if (sources.length !== 1 || sources[0]?.kind !== 'jarvis_source_ref')
      throw new ContextEvidenceNavigationError('unavailable');
    return { fingerprint: JSON.stringify([message, chat, project]), source: sources[0].source };
  }
  return Object.freeze({
    open(rawInput: Readonly<{ chatId: string; messageId: string; uri: string }>): Promise<void> {
      cancel();
      const input = Object.freeze({ ...rawInput });
      if (
        disposed ||
        !identityPart(input.chatId) ||
        !identityPart(input.messageId) ||
        typeof input.uri !== 'string' ||
        input.uri.length > 2048 ||
        !input.uri.startsWith('vibespace:context/evidence/')
      )
        return Promise.reject(new ContextEvidenceNavigationError('unavailable'));
      const scope = captureScope(input.chatId);
      if (!scope) return Promise.reject(new ContextEvidenceNavigationError('unavailable'));
      let resolve!: () => void, reject!: (error: ContextEvidenceNavigationError) => void;
      const completion = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const operation: Operation = {
        epoch,
        scope,
        controller: new AbortController(),
        settled: false,
        consumed: false,
        expectedRoute: useUIStore.getState().route,
        switchingRoute: false,
        cleanup: () => {},
        resolve,
        reject,
      };
      active = operation;
      const changed = () => {
        try {
          check(operation);
        } catch {
          finish(operation, new ContextEvidenceNavigationError('revoked'));
        }
      };
      const storageChanged = (event: StorageEvent) => {
        // A delayed storage event still revokes a root transition that has
        // already returned to its old value in another window.
        if (
          event.key === null ||
          (event.key === projectStorageKey(ROOT_PREFIX, scope.projectId) &&
            event.oldValue !== event.newValue)
        ) {
          finish(operation, new ContextEvidenceNavigationError('revoked'));
          return;
        }
        changed();
      };
      const stopAuth = useAuthStore.subscribe(changed),
        stopUi = useUIStore.subscribe(changed);
      const timeout = setTimeout(
        () => finish(operation, new ContextEvidenceNavigationError('unavailable')),
        timeoutMs,
      );
      if (typeof window !== 'undefined') {
        window.addEventListener('jarvis:files:root-changed', changed);
        window.addEventListener('storage', storageChanged);
      }
      operation.cleanup = () => {
        clearTimeout(timeout);
        stopAuth();
        stopUi();
        if (typeof window !== 'undefined') {
          window.removeEventListener('jarvis:files:root-changed', changed);
          window.removeEventListener('storage', storageChanged);
        }
      };
      void (async () => {
        const owned = await readOwnedMessage(operation, input.messageId, input.uri);
        const record = await backing.lookup(scope, input.uri);
        check(operation);
        if (!record || record.target.pointer.id !== owned.source.id)
          throw new ContextEvidenceNavigationError('unavailable');
        const expectedSelection: SettingsRow | undefined = await database.settings.get(
          contextSelectionSettingKey(scope.accountId, scope.projectId),
        );
        check(operation);
        const before = await database.context_maps.get(record.target.mapId);
        check(operation);
        if (
          !before ||
          before.accountId !== scope.accountId ||
          before.projectId !== scope.projectId ||
          before.status !== 'active'
        )
          throw new ContextEvidenceNavigationError('unavailable');
        const target = await revalidate({
          scope,
          target: record.target,
          signal: operation.controller.signal,
          assertCurrent: () => check(operation),
        });
        check(operation);
        const after = await database.context_maps.get(record.target.mapId);
        check(operation);
        if (
          !target ||
          JSON.stringify(before) !== JSON.stringify(after) ||
          target.accountId !== scope.accountId ||
          target.projectId !== scope.projectId ||
          target.mapId !== record.target.mapId ||
          target.entityId !== record.target.entityId ||
          target.path !== record.target.sourcePath ||
          target.mapUpdatedAt !== before.updatedAt
        )
          throw new ContextEvidenceNavigationError('unavailable');
        const latest = await readOwnedMessage(operation, input.messageId, input.uri);
        check(operation);
        if (latest.fingerprint !== owned.fingerprint)
          throw new ContextEvidenceNavigationError('unavailable');
        const guard: ContextSelectionGuard = Object.freeze({
          signal: operation.controller.signal,
          assertCurrent: () => check(operation),
          expectedSelection:
            expectedSelection === undefined ? undefined : structuredClone(expectedSelection),
          expectedMapUpdatedAt: before.updatedAt,
          expectedKnowledgeRevision: before.knowledgeRevision,
          validateOwnership: async (actualDatabase: JarvisDexie) => {
            if (actualDatabase !== database) return false;
            const latestOwner = await readOwnedMessage(operation, input.messageId, input.uri);
            check(operation);
            return latestOwner.fingerprint === owned.fingerprint;
          },
        });
        operation.ticket = Object.freeze({
          target: Object.freeze({ ...target }),
          guard,
          assertCurrent: () => check(operation),
          complete: () => {
            check(operation);
            finish(operation);
          },
          fail: () => finish(operation, new ContextEvidenceNavigationError('unavailable')),
        });
        // Publish before routing so the mounted Context page can take the exact
        // pending ticket. Only this operation's own route transition is allowed.
        operation.switchingRoute = true;
        useUIStore.getState().setRoute('context');
        operation.expectedRoute = 'context';
        operation.switchingRoute = false;
        check(operation);
        notify();
      })().catch((error) =>
        finish(
          operation,
          error instanceof ContextEvidenceNavigationError
            ? error
            : new ContextEvidenceNavigationError(
                operation.controller.signal.aborted ? 'revoked' : 'unavailable',
              ),
        ),
      );
      return completion;
    },
    take(projectId: string | null): ContextEvidenceNavigationTicket | undefined {
      const operation = active;
      if (!operation?.ticket || operation.consumed || operation.scope.projectId !== projectId)
        return undefined;
      try {
        check(operation);
      } catch {
        finish(operation, new ContextEvidenceNavigationError('revoked'));
        return undefined;
      }
      operation.consumed = true;
      return operation.ticket;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      listeners.clear();
    },
  });
}
export const contextEvidenceNavigation = createContextEvidenceNavigation();

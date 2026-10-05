import { db, openDb } from '@/lib/db/database';
import { newProjectId, newWorkspaceId } from '@/lib/ids';
import {
  getLocalAccountReadyReceipt,
  type LocalAccountReadyReceipt,
} from '@/lib/localAccountReadiness';
import {
  activateLocalWorkspaceRecovery,
  getLocalWorkspaceRecoveryRevision,
  readLocalWorkspaceRecoveryStorage,
  useAuthStore,
  type LocalWorkspaceRecoveryScope,
} from '@/stores/auth';

type Receipt = {
  version: 1;
  source: LocalWorkspaceRecoveryScope;
  target: LocalWorkspaceRecoveryScope;
  createdAt: number;
};
type Authority = {
  scope: LocalWorkspaceRecoveryScope;
  revision: number;
  readiness: LocalAccountReadyReceipt;
};
export type LocalWorkspaceRecoveryPreview = Readonly<{
  kind: 'create' | 'resume';
  accountId: string;
}>;
const previews = new WeakMap<LocalWorkspaceRecoveryPreview, Authority>();
const keyFor = (accountId: string) => `local-workspace-recovery:v1:${accountId}`;
const sameScope = (left: LocalWorkspaceRecoveryScope, right: LocalWorkspaceRecoveryScope) =>
  left.localUserId === right.localUserId &&
  left.workspaceId === right.workspaceId &&
  left.projectId === right.projectId;
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value === value.trim();

function captureAuthority(): Authority {
  const auth = useAuthStore.getState();
  const readiness = getLocalAccountReadyReceipt();
  if (
    auth.cloudSession !== null ||
    !nonempty(auth.localUserId) ||
    !nonempty(auth.workspaceId) ||
    !nonempty(auth.projectId) ||
    readiness?.accountId !== auth.localUserId
  ) {
    throw new Error(
      'Recovery requires a settled, signed-out local profile. Wait for startup, then check again.',
    );
  }
  return {
    scope: {
      localUserId: auth.localUserId,
      workspaceId: auth.workspaceId,
      projectId: auth.projectId,
    },
    revision: getLocalWorkspaceRecoveryRevision(),
    readiness,
  };
}
function assertAuthority(authority: Authority): void {
  const current = captureAuthority();
  if (
    !sameScope(current.scope, authority.scope) ||
    current.revision !== authority.revision ||
    current.readiness !== authority.readiness
  ) {
    throw new Error('Local account or workspace changed. Check recovery again.');
  }
}
function parseReceipt(value: unknown, accountId: string): Receipt {
  const receipt = value as Receipt | undefined;
  const validScope = (scope: LocalWorkspaceRecoveryScope | undefined) =>
    scope &&
    scope.localUserId === accountId &&
    nonempty(scope.workspaceId) &&
    nonempty(scope.projectId);
  if (
    receipt?.version !== 1 ||
    !validScope(receipt.source) ||
    !validScope(receipt.target) ||
    receipt.source.workspaceId === receipt.target.workspaceId ||
    receipt.source.projectId === receipt.target.projectId ||
    !Number.isFinite(receipt.createdAt)
  ) {
    throw new Error('The saved recovery record cannot be verified. Existing data was preserved.');
  }
  return receipt;
}
async function inspect(authority: Authority): Promise<Receipt | null> {
  const saved = await db.settings.get(keyFor(authority.scope.localUserId));
  assertAuthority(authority);
  const total = await db.workspaces.count();
  assertAuthority(authority);
  if (!saved) {
    if (total !== 0)
      throw new Error('A workspace already exists on this device. Recovery will not replace it.');
    readLocalWorkspaceRecoveryStorage(authority.scope);
    assertAuthority(authority);
    return null;
  }
  const receipt = parseReceipt(saved.value, authority.scope.localUserId);
  if (!sameScope(authority.scope, receipt.source) && !sameScope(authority.scope, receipt.target)) {
    throw new Error('This recovery belongs to a different workspace selection.');
  }
  const workspace = await db.workspaces.get(receipt.target.workspaceId);
  assertAuthority(authority);
  const project = await db.projects.get(receipt.target.projectId);
  assertAuthority(authority);
  if (
    total !== 1 ||
    workspace?.owner_id !== receipt.target.localUserId ||
    project?.workspace_id !== receipt.target.workspaceId
  ) {
    throw new Error(
      'The saved recovery workspace cannot be verified. Existing data was preserved.',
    );
  }
  readLocalWorkspaceRecoveryStorage(authority.scope, receipt.target);
  assertAuthority(authority);
  return receipt;
}

/** Read-only and explicit. Never runs from startup or the seed path. */
export async function previewLocalWorkspaceRecovery(): Promise<LocalWorkspaceRecoveryPreview> {
  const authority = captureAuthority();
  await openDb();
  assertAuthority(authority);
  const receipt = await db.transaction('r', db.workspaces, db.projects, db.settings, () =>
    inspect(authority),
  );
  assertAuthority(authority);
  const preview = Object.freeze({
    kind: receipt ? ('resume' as const) : ('create' as const),
    accountId: authority.scope.localUserId,
  });
  previews.set(preview, authority);
  return preview;
}

/** Called only after the Account UI's separate confirmation. */
export async function recoverLocalWorkspace(
  preview: LocalWorkspaceRecoveryPreview,
): Promise<{ scope: LocalWorkspaceRecoveryScope; revision: number }> {
  const authority = previews.get(preview);
  if (!authority) throw new Error('Check local workspace recovery before confirming.');
  previews.delete(preview);
  assertAuthority(authority);
  const receipt = await db.transaction('rw', db.workspaces, db.projects, db.settings, async () => {
    const existing = await inspect(authority);
    assertAuthority(authority);
    if (existing) return existing;
    const workspaceId = newWorkspaceId();
    const projectId = newProjectId();
    if (workspaceId === authority.scope.workspaceId || projectId === authority.scope.projectId) {
      throw new Error('Could not allocate fresh recovery IDs. Check again.');
    }
    const createdAt = Date.now();
    const next: Receipt = {
      version: 1,
      source: authority.scope,
      target: { localUserId: authority.scope.localUserId, workspaceId, projectId },
      createdAt,
    };
    await db.workspaces.add({
      id: workspaceId,
      name: 'Personal',
      owner_id: authority.scope.localUserId,
      created_at: createdAt,
      updated_at: createdAt,
    });
    assertAuthority(authority);
    await db.projects.add({
      id: projectId,
      workspace_id: workspaceId,
      name: 'Inbox',
      color_hue: 210,
      created_at: createdAt,
      updated_at: createdAt,
    });
    assertAuthority(authority);
    await db.settings.add({
      key: keyFor(authority.scope.localUserId),
      value: next,
      updated_at: createdAt,
    });
    assertAuthority(authority);
    return next;
  });
  // A loss of authority after commit leaves an atomic durable pair and receipt,
  // never a guessed rollback that might delete newly-used data or restore old auth.
  assertAuthority(authority);
  activateLocalWorkspaceRecovery({
    source: authority.scope,
    target: receipt.target,
    revision: authority.revision,
    isCurrent: () => {
      assertAuthority(authority);
      return true;
    },
  });
  return { scope: receipt.target, revision: getLocalWorkspaceRecoveryRevision() };
}

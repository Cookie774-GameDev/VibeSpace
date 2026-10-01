import type { JarvisDexie } from '@/lib/db';
import type { BrowserChatPermissionProfileRow } from '@/lib/db/schema';
import {
  deserializePermissionProfile,
  serializePermissionProfile,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

export type BrowserChatPermissionProfileScope = {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly projectId: string;
};

type Clock = () => number;
type IdFactory = () => string;

const SAFE_SCOPE = /^[A-Za-z0-9_.:@/-]{1,256}$/u;

function normalizeScope(
  input: BrowserChatPermissionProfileScope,
): BrowserChatPermissionProfileScope {
  const accountId = input.accountId.trim();
  const workspaceId = input.workspaceId.trim();
  const projectId = input.projectId.trim();
  if (!SAFE_SCOPE.test(accountId) || !SAFE_SCOPE.test(workspaceId) || !SAFE_SCOPE.test(projectId)) {
    throw new Error('browser_chat_permission_profile_scope_invalid');
  }
  return { accountId, workspaceId, projectId };
}

function validateProfileForScope(
  profile: BrowserChatPermissionProfile,
  scope: BrowserChatPermissionProfileScope,
  updatedAt: number,
): BrowserChatPermissionProfile {
  if (profile.accountId !== scope.accountId || profile.workspaceId !== scope.workspaceId) {
    throw new Error('browser_chat_permission_profile_scope_mismatch');
  }
  return deserializePermissionProfile(
    serializePermissionProfile({
      ...profile,
      updatedAt,
    }),
  );
}

export function createBrowserChatPermissionProfileRepository(
  database: JarvisDexie,
  clock: Clock = Date.now,
  idFactory: IdFactory = () => crypto.randomUUID(),
) {
  async function findRow(
    scope: BrowserChatPermissionProfileScope,
  ): Promise<BrowserChatPermissionProfileRow | undefined> {
    return database.browser_chat_permission_profiles
      .where('[accountId+workspaceId+projectId]')
      .equals([scope.accountId, scope.workspaceId, scope.projectId])
      .first();
  }

  return {
    async get(
      scopeInput: BrowserChatPermissionProfileScope,
    ): Promise<BrowserChatPermissionProfile | undefined> {
      const scope = normalizeScope(scopeInput);
      const row = await findRow(scope);
      if (!row) return undefined;
      try {
        return validateProfileForScope(
          deserializePermissionProfile(row.serializedProfile),
          scope,
          row.updatedAt,
        );
      } catch {
        return undefined;
      }
    },

    async save(
      scopeInput: BrowserChatPermissionProfileScope,
      profileInput: BrowserChatPermissionProfile,
    ): Promise<BrowserChatPermissionProfileRow> {
      const scope = normalizeScope(scopeInput);
      const timestamp = clock();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error('browser_chat_permission_profile_timestamp_invalid');
      }
      const profile = validateProfileForScope(profileInput, scope, timestamp);
      return database.transaction('rw', database.browser_chat_permission_profiles, async () => {
        const current = await findRow(scope);
        const id = current?.id ?? idFactory().trim();
        if (!SAFE_SCOPE.test(id)) {
          throw new Error('browser_chat_permission_profile_id_invalid');
        }
        const row: BrowserChatPermissionProfileRow = {
          id,
          ...scope,
          plan: profile.plan,
          serializedProfile: serializePermissionProfile(profile),
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        await database.browser_chat_permission_profiles.put(row);
        return row;
      });
    },

    async remove(scopeInput: BrowserChatPermissionProfileScope): Promise<boolean> {
      const scope = normalizeScope(scopeInput);
      return database.transaction('rw', database.browser_chat_permission_profiles, async () => {
        const row = await findRow(scope);
        if (!row) return false;
        await database.browser_chat_permission_profiles.delete(row.id);
        return true;
      });
    },
  };
}

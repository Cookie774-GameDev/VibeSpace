import type { JarvisDexie } from '@/lib/db';
import type {
  BrowserChatBindingRow,
  BrowserChatProvider,
  ProviderProjectLinkRow,
} from '@/lib/db/schema';
import { validateProviderNavigationUrl, type ProviderNavigationKind } from './providerNavigation';

export type BrowserChatScope = {
  readonly accountId: string;
  readonly workspaceId: string;
};

export type BrowserChatBindingCreateInput = BrowserChatScope & {
  readonly projectId?: string;
  readonly chatId: string;
  readonly provider: BrowserChatProvider;
  readonly providerProfileKey: string;
  readonly providerConversationKey?: string;
  readonly resumeUrl?: string;
  readonly providerProjectKey?: string;
  readonly bindingState?: BrowserChatBindingRow['bindingState'];
  readonly localTitle: string;
  readonly pinned?: boolean;
  readonly viewMode?: BrowserChatBindingRow['viewMode'];
  readonly permissionProfileId?: string;
  readonly lastOpenedAt?: number;
};

export type BrowserChatBindingUpdateInput = Partial<
  Pick<
    BrowserChatBindingRow,
    | 'projectId'
    | 'providerConversationKey'
    | 'resumeUrl'
    | 'providerProjectKey'
    | 'bindingState'
    | 'localTitle'
    | 'pinned'
    | 'viewMode'
    | 'permissionProfileId'
    | 'lastOpenedAt'
  >
>;

export type ProviderProjectLinkCreateInput = BrowserChatScope & {
  readonly projectId: string;
  readonly provider: BrowserChatProvider;
  readonly providerProjectKey?: string;
  readonly providerProjectUrl?: string;
  readonly state?: ProviderProjectLinkRow['state'];
  readonly lastVerifiedAt?: number;
};

export type ProviderProjectLinkUpdateInput = Partial<
  Pick<
    ProviderProjectLinkRow,
    'providerProjectKey' | 'providerProjectUrl' | 'state' | 'lastVerifiedAt'
  >
>;

type Clock = () => number;
type IdFactory = () => string;

function requiredString(value: string, errorCode: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(errorCode);
  return normalized;
}

function optionalString(
  value: string | undefined,
  errorCode: string,
  maxLength = 512,
): string | undefined {
  return value === undefined ? undefined : requiredString(value, errorCode, maxLength);
}

function normalizeScope(scope: BrowserChatScope): BrowserChatScope {
  return {
    accountId: requiredString(scope.accountId, 'browser_chat_account_invalid', 256),
    workspaceId: requiredString(scope.workspaceId, 'browser_chat_workspace_invalid', 256),
  };
}

function normalizeProviderUrl(
  provider: BrowserChatProvider,
  value: string | undefined,
  requiredKind: ProviderNavigationKind,
  errorCode: string,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    return validateProviderNavigationUrl(provider, value, requiredKind);
  } catch {
    throw new Error(errorCode);
  }
}

function scoped<T extends BrowserChatScope>(row: T | undefined, scope: BrowserChatScope): row is T {
  return Boolean(row && row.accountId === scope.accountId && row.workspaceId === scope.workspaceId);
}

export function createBrowserChatBindingRepository(
  database: JarvisDexie,
  clock: Clock = Date.now,
  idFactory: IdFactory = () => crypto.randomUUID(),
) {
  async function getRequired(
    scopeInput: BrowserChatScope,
    idInput: string,
  ): Promise<BrowserChatBindingRow> {
    const scope = normalizeScope(scopeInput);
    const id = requiredString(idInput, 'browser_chat_binding_id_invalid', 256);
    const row = await database.browser_chat_bindings.get(id);
    if (!scoped(row, scope)) throw new Error('browser_chat_binding_not_found');
    return row;
  }

  return {
    async create(input: BrowserChatBindingCreateInput): Promise<BrowserChatBindingRow> {
      const scope = normalizeScope(input);
      const chatId = requiredString(input.chatId, 'browser_chat_chat_id_invalid', 256);
      const providerProfileKey = requiredString(
        input.providerProfileKey,
        'browser_chat_provider_profile_invalid',
        512,
      );
      const providerConversationKey = optionalString(
        input.providerConversationKey,
        'browser_chat_provider_conversation_invalid',
        1024,
      );
      const resumeUrl = normalizeProviderUrl(
        input.provider,
        input.resumeUrl,
        'conversation',
        'browser_chat_resume_url_invalid',
      );
      if (resumeUrl && !providerConversationKey) {
        throw new Error('browser_chat_provider_conversation_required');
      }
      const timestamp = clock();
      const row: BrowserChatBindingRow = {
        id: requiredString(idFactory(), 'browser_chat_binding_id_invalid', 256),
        ...scope,
        projectId: optionalString(input.projectId, 'browser_chat_project_id_invalid', 256),
        chatId,
        provider: input.provider,
        providerProfileKey,
        providerConversationKey,
        resumeUrl,
        providerProjectKey: optionalString(
          input.providerProjectKey,
          'browser_chat_provider_project_invalid',
          1024,
        ),
        bindingState:
          input.bindingState ?? (providerConversationKey === undefined ? 'new' : 'bound'),
        localTitle: requiredString(input.localTitle, 'browser_chat_title_invalid', 512),
        pinned: input.pinned ?? false,
        viewMode: input.viewMode ?? 'vibespace',
        permissionProfileId: optionalString(
          input.permissionProfileId,
          'browser_chat_permission_profile_invalid',
          256,
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: input.lastOpenedAt,
      };

      return database.transaction('rw', database.browser_chat_bindings, async () => {
        const chatConflict = await database.browser_chat_bindings
          .where('[accountId+workspaceId+chatId]')
          .equals([scope.accountId, scope.workspaceId, chatId])
          .first();
        if (chatConflict) throw new Error('browser_chat_binding_chat_conflict');
        if (providerConversationKey) {
          const conversationConflict = await database.browser_chat_bindings
            .where('[accountId+workspaceId+provider+providerProfileKey+providerConversationKey]')
            .equals([
              scope.accountId,
              scope.workspaceId,
              input.provider,
              providerProfileKey,
              providerConversationKey,
            ])
            .first();
          if (conversationConflict) {
            throw new Error('browser_chat_binding_provider_conversation_conflict');
          }
        }
        await database.browser_chat_bindings.add(row);
        return row;
      });
    },

    async list(scopeInput: BrowserChatScope): Promise<BrowserChatBindingRow[]> {
      const scope = normalizeScope(scopeInput);
      const rows = await database.browser_chat_bindings
        .where('[accountId+workspaceId]')
        .equals([scope.accountId, scope.workspaceId])
        .toArray();
      return rows.sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          (right.lastOpenedAt ?? right.updatedAt) - (left.lastOpenedAt ?? left.updatedAt),
      );
    },

    async get(
      scopeInput: BrowserChatScope,
      idInput: string,
    ): Promise<BrowserChatBindingRow | undefined> {
      const scope = normalizeScope(scopeInput);
      const id = requiredString(idInput, 'browser_chat_binding_id_invalid', 256);
      const row = await database.browser_chat_bindings.get(id);
      return scoped(row, scope) ? row : undefined;
    },

    async findByChat(
      scopeInput: BrowserChatScope,
      chatIdInput: string,
    ): Promise<BrowserChatBindingRow | undefined> {
      const scope = normalizeScope(scopeInput);
      const chatId = requiredString(chatIdInput, 'browser_chat_chat_id_invalid', 256);
      return database.browser_chat_bindings
        .where('[accountId+workspaceId+chatId]')
        .equals([scope.accountId, scope.workspaceId, chatId])
        .first();
    },

    async findByProviderConversation(
      scopeInput: BrowserChatScope,
      identity: {
        readonly provider: BrowserChatProvider;
        readonly providerProfileKey: string;
        readonly providerConversationKey: string;
      },
    ): Promise<BrowserChatBindingRow | undefined> {
      const scope = normalizeScope(scopeInput);
      const providerProfileKey = requiredString(
        identity.providerProfileKey,
        'browser_chat_provider_profile_invalid',
        512,
      );
      const providerConversationKey = requiredString(
        identity.providerConversationKey,
        'browser_chat_provider_conversation_invalid',
        1024,
      );
      return database.browser_chat_bindings
        .where('[accountId+workspaceId+provider+providerProfileKey+providerConversationKey]')
        .equals([
          scope.accountId,
          scope.workspaceId,
          identity.provider,
          providerProfileKey,
          providerConversationKey,
        ])
        .first();
    },

    async update(
      scopeInput: BrowserChatScope,
      idInput: string,
      patch: BrowserChatBindingUpdateInput,
    ): Promise<BrowserChatBindingRow> {
      const scope = normalizeScope(scopeInput);
      const id = requiredString(idInput, 'browser_chat_binding_id_invalid', 256);

      return database.transaction('rw', database.browser_chat_bindings, async () => {
        const current = await database.browser_chat_bindings.get(id);
        if (!scoped(current, scope)) throw new Error('browser_chat_binding_not_found');
        const providerConversationKey =
          patch.providerConversationKey === undefined
            ? current.providerConversationKey
            : optionalString(
                patch.providerConversationKey,
                'browser_chat_provider_conversation_invalid',
                1024,
              );
        const resumeUrl =
          patch.resumeUrl === undefined
            ? current.resumeUrl
            : normalizeProviderUrl(
                current.provider,
                patch.resumeUrl,
                'conversation',
                'browser_chat_resume_url_invalid',
              );
        if (resumeUrl && !providerConversationKey) {
          throw new Error('browser_chat_provider_conversation_required');
        }
        const next: BrowserChatBindingRow = {
          ...current,
          projectId:
            'projectId' in patch
              ? optionalString(patch.projectId, 'browser_chat_project_id_invalid', 256)
              : current.projectId,
          providerConversationKey,
          resumeUrl,
          providerProjectKey:
            patch.providerProjectKey === undefined
              ? current.providerProjectKey
              : optionalString(
                  patch.providerProjectKey,
                  'browser_chat_provider_project_invalid',
                  1024,
                ),
          bindingState: patch.bindingState ?? current.bindingState,
          localTitle:
            patch.localTitle === undefined
              ? current.localTitle
              : requiredString(patch.localTitle, 'browser_chat_title_invalid', 512),
          pinned: patch.pinned ?? current.pinned,
          viewMode: patch.viewMode ?? current.viewMode,
          permissionProfileId:
            patch.permissionProfileId === undefined
              ? current.permissionProfileId
              : optionalString(
                  patch.permissionProfileId,
                  'browser_chat_permission_profile_invalid',
                  256,
                ),
          lastOpenedAt: patch.lastOpenedAt ?? current.lastOpenedAt,
          updatedAt: clock(),
        };
        if (providerConversationKey) {
          const conversationConflict = await database.browser_chat_bindings
            .where('[accountId+workspaceId+provider+providerProfileKey+providerConversationKey]')
            .equals([
              scope.accountId,
              scope.workspaceId,
              current.provider,
              current.providerProfileKey,
              providerConversationKey,
            ])
            .first();
          if (conversationConflict && conversationConflict.id !== current.id) {
            throw new Error('browser_chat_binding_provider_conversation_conflict');
          }
        }
        await database.browser_chat_bindings.put(next);
        return next;
      });
    },

    async remove(scopeInput: BrowserChatScope, idInput: string): Promise<void> {
      const scope = normalizeScope(scopeInput);
      const current = await getRequired(scope, idInput);
      await database.transaction('rw', database.browser_chat_bindings, async () => {
        const owned = await database.browser_chat_bindings.get(current.id);
        if (!scoped(owned, scope)) throw new Error('browser_chat_binding_not_found');
        await database.browser_chat_bindings.delete(current.id);
      });
    },
  };
}

export function createProviderProjectLinkRepository(
  database: JarvisDexie,
  clock: Clock = Date.now,
  idFactory: IdFactory = () => crypto.randomUUID(),
) {
  async function getRequired(
    scopeInput: BrowserChatScope,
    idInput: string,
  ): Promise<ProviderProjectLinkRow> {
    const scope = normalizeScope(scopeInput);
    const id = requiredString(idInput, 'provider_project_link_id_invalid', 256);
    const row = await database.provider_project_links.get(id);
    if (!scoped(row, scope)) throw new Error('provider_project_link_not_found');
    return row;
  }

  return {
    async create(input: ProviderProjectLinkCreateInput): Promise<ProviderProjectLinkRow> {
      const scope = normalizeScope(input);
      const projectId = requiredString(input.projectId, 'browser_chat_project_id_invalid', 256);
      const providerProjectKey = optionalString(
        input.providerProjectKey,
        'browser_chat_provider_project_invalid',
        1024,
      );
      const providerProjectUrl = normalizeProviderUrl(
        input.provider,
        input.providerProjectUrl,
        'project',
        'provider_project_url_invalid',
      );
      const timestamp = clock();
      const row: ProviderProjectLinkRow = {
        id: requiredString(idFactory(), 'provider_project_link_id_invalid', 256),
        ...scope,
        projectId,
        provider: input.provider,
        providerProjectKey,
        providerProjectUrl,
        state:
          input.state ??
          (providerProjectKey !== undefined || providerProjectUrl !== undefined
            ? 'linked'
            : 'unsupported'),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastVerifiedAt: input.lastVerifiedAt,
      };

      return database.transaction('rw', database.provider_project_links, async () => {
        const conflict = await database.provider_project_links
          .where('[accountId+workspaceId+projectId+provider]')
          .equals([scope.accountId, scope.workspaceId, projectId, input.provider])
          .first();
        if (conflict) throw new Error('provider_project_link_conflict');
        await database.provider_project_links.add(row);
        return row;
      });
    },

    async list(scopeInput: BrowserChatScope): Promise<ProviderProjectLinkRow[]> {
      const scope = normalizeScope(scopeInput);
      const rows = await database.provider_project_links
        .where('[accountId+workspaceId]')
        .equals([scope.accountId, scope.workspaceId])
        .toArray();
      return rows.sort((left, right) => right.updatedAt - left.updatedAt);
    },

    async getForProject(
      scopeInput: BrowserChatScope,
      projectIdInput: string,
      provider: BrowserChatProvider,
    ): Promise<ProviderProjectLinkRow | undefined> {
      const scope = normalizeScope(scopeInput);
      const projectId = requiredString(projectIdInput, 'browser_chat_project_id_invalid', 256);
      return database.provider_project_links
        .where('[accountId+workspaceId+projectId+provider]')
        .equals([scope.accountId, scope.workspaceId, projectId, provider])
        .first();
    },

    async update(
      scopeInput: BrowserChatScope,
      idInput: string,
      patch: ProviderProjectLinkUpdateInput,
    ): Promise<ProviderProjectLinkRow> {
      const scope = normalizeScope(scopeInput);
      const current = await getRequired(scope, idInput);
      const next: ProviderProjectLinkRow = {
        ...current,
        providerProjectKey:
          patch.providerProjectKey === undefined
            ? current.providerProjectKey
            : optionalString(
                patch.providerProjectKey,
                'browser_chat_provider_project_invalid',
                1024,
              ),
        providerProjectUrl:
          patch.providerProjectUrl === undefined
            ? current.providerProjectUrl
            : normalizeProviderUrl(
                current.provider,
                patch.providerProjectUrl,
                'project',
                'provider_project_url_invalid',
              ),
        state: patch.state ?? current.state,
        lastVerifiedAt: patch.lastVerifiedAt ?? current.lastVerifiedAt,
        updatedAt: clock(),
      };
      await database.transaction('rw', database.provider_project_links, async () => {
        const owned = await database.provider_project_links.get(current.id);
        if (!scoped(owned, scope)) throw new Error('provider_project_link_not_found');
        await database.provider_project_links.put(next);
      });
      return next;
    },

    async remove(scopeInput: BrowserChatScope, idInput: string): Promise<void> {
      const scope = normalizeScope(scopeInput);
      const current = await getRequired(scope, idInput);
      await database.transaction('rw', database.provider_project_links, async () => {
        const owned = await database.provider_project_links.get(current.id);
        if (!scoped(owned, scope)) throw new Error('provider_project_link_not_found');
        await database.provider_project_links.delete(current.id);
      });
    },
  };
}

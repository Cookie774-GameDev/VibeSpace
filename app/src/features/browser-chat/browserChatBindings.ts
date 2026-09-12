import { settingsRepo } from '@/lib/db';
import {
  isBrowserChatProviderId,
  type BrowserChatProviderId,
} from './providerRegistry';

export type BrowserChatBindingState = 'new' | 'bound' | 'stale' | 'unavailable';

export type BrowserChatBinding = {
  readonly id: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly nativeChatId: string;
  readonly provider: BrowserChatProviderId;
  readonly providerProfileKey: string;
  readonly providerConversationKey?: string;
  readonly resumeUrl?: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly state: BrowserChatBindingState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastOpenedAt?: number;
};

export type BrowserChatBindingInput = Omit<
  BrowserChatBinding,
  'createdAt' | 'updatedAt'
> & {
  readonly createdAt?: number;
  readonly updatedAt?: number;
};

export interface BrowserChatBindingStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

export interface BrowserChatBindingRepository {
  list(accountId: string, workspaceId?: string): Promise<BrowserChatBinding[]>;
  get(accountId: string, id: string): Promise<BrowserChatBinding | undefined>;
  upsert(accountId: string, input: BrowserChatBindingInput): Promise<BrowserChatBinding>;
  patch(
    accountId: string,
    id: string,
    patch: Partial<
      Pick<
        BrowserChatBinding,
        | 'projectId'
        | 'provider'
        | 'providerProfileKey'
        | 'providerConversationKey'
        | 'resumeUrl'
        | 'title'
        | 'pinned'
        | 'state'
        | 'lastOpenedAt'
      >
    >,
  ): Promise<BrowserChatBinding>;
  remove(accountId: string, id: string): Promise<void>;
  clearAccount(accountId: string): Promise<void>;
}

const STORAGE_PREFIX = 'vibespace.browser-chat.bindings.v1:';
const MAX_BINDINGS = 500;
const MAX_SCOPE_LENGTH = 256;
const MAX_TITLE_LENGTH = 160;
const MAX_CONVERSATION_KEY_LENGTH = 512;
const STATES = new Set<BrowserChatBindingState>(['new', 'bound', 'stale', 'unavailable']);

type StoredBindings = {
  readonly version: 1;
  readonly bindings: readonly unknown[];
};

function validIdentifier(value: unknown, maxLength = MAX_SCOPE_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function storageKey(accountId: string): string {
  if (!validIdentifier(accountId)) throw new Error('browser_chat_binding_account_invalid');
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}`;
}

function providerResumeHost(provider: BrowserChatProviderId, host: string): boolean {
  const normalized = host.toLowerCase();
  if (provider === 'chatgpt') {
    return normalized === 'chatgpt.com' || normalized.endsWith('.chatgpt.com');
  }
  if (provider === 'claude') {
    return normalized === 'claude.ai' || normalized.endsWith('.claude.ai');
  }
  return normalized === 'gemini.google.com' || normalized.endsWith('.gemini.google.com');
}

export function validateBrowserChatResumeUrl(
  provider: BrowserChatProviderId,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 2_048 || value.trim() !== value) {
    throw new Error('browser_chat_binding_resume_url_invalid');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('browser_chat_binding_resume_url_invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !providerResumeHost(provider, parsed.hostname)
  ) {
    throw new Error('browser_chat_binding_resume_url_invalid');
  }
  parsed.hash = '';
  return parsed.toString();
}

function optionalIdentifier(value: unknown, maxLength = MAX_SCOPE_LENGTH): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : validIdentifier(value, maxLength)
      ? value
      : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeBinding(value: unknown, expectedAccountId: string): BrowserChatBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !validIdentifier(record.id) ||
    record.accountId !== expectedAccountId ||
    !validIdentifier(record.workspaceId) ||
    !validIdentifier(record.nativeChatId) ||
    !isBrowserChatProviderId(record.provider) ||
    !validIdentifier(record.providerProfileKey) ||
    typeof record.title !== 'string' ||
    record.title.trim().length === 0 ||
    !STATES.has(record.state as BrowserChatBindingState)
  ) {
    return null;
  }
  const createdAt = finiteTimestamp(record.createdAt);
  const updatedAt = finiteTimestamp(record.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return null;

  try {
    return {
      id: record.id,
      accountId: expectedAccountId,
      workspaceId: record.workspaceId,
      projectId: optionalIdentifier(record.projectId),
      nativeChatId: record.nativeChatId,
      provider: record.provider,
      providerProfileKey: record.providerProfileKey,
      providerConversationKey: optionalIdentifier(
        record.providerConversationKey,
        MAX_CONVERSATION_KEY_LENGTH,
      ),
      resumeUrl: validateBrowserChatResumeUrl(
        record.provider,
        typeof record.resumeUrl === 'string' ? record.resumeUrl : undefined,
      ),
      title: record.title.trim().slice(0, MAX_TITLE_LENGTH),
      pinned: record.pinned === true,
      state: record.state as BrowserChatBindingState,
      createdAt,
      updatedAt,
      lastOpenedAt: finiteTimestamp(record.lastOpenedAt),
    };
  } catch {
    return null;
  }
}

function bindingOrder(left: BrowserChatBinding, right: BrowserChatBinding): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftActivity = left.lastOpenedAt ?? left.updatedAt;
  const rightActivity = right.lastOpenedAt ?? right.updatedAt;
  return rightActivity - leftActivity || left.id.localeCompare(right.id);
}

function equivalentBinding(left: BrowserChatBinding, right: BrowserChatBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createBrowserChatBindingRepository(
  store: BrowserChatBindingStore = settingsRepo,
  clock: () => number = Date.now,
): BrowserChatBindingRepository {
  const readAll = async (accountId: string): Promise<BrowserChatBinding[]> => {
    const raw = await store.get<StoredBindings>(storageKey(accountId));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.bindings)) return [];
    const deduplicated = new Map<string, BrowserChatBinding>();
    for (const candidate of raw.bindings) {
      const binding = sanitizeBinding(candidate, accountId);
      if (!binding) continue;
      const existing = deduplicated.get(binding.id);
      if (!existing || binding.updatedAt > existing.updatedAt) {
        deduplicated.set(binding.id, binding);
      }
    }
    return [...deduplicated.values()].sort(bindingOrder).slice(0, MAX_BINDINGS);
  };

  const writeAll = async (accountId: string, bindings: BrowserChatBinding[]): Promise<void> => {
    const bounded = [...bindings].sort(bindingOrder).slice(0, MAX_BINDINGS);
    await store.set(storageKey(accountId), { version: 1, bindings: bounded });
  };

  const repository: BrowserChatBindingRepository = {
    async list(accountId, workspaceId) {
      const bindings = await readAll(accountId);
      return bindings
        .filter((binding) => workspaceId === undefined || binding.workspaceId === workspaceId)
        .map((binding) => structuredClone(binding));
    },

    async get(accountId, id) {
      if (!validIdentifier(id)) return undefined;
      const binding = (await readAll(accountId)).find((candidate) => candidate.id === id);
      return binding ? structuredClone(binding) : undefined;
    },

    async upsert(accountId, input) {
      if (input.accountId !== accountId) {
        throw new Error('browser_chat_binding_account_mismatch');
      }
      const now = clock();
      const existingBindings = await readAll(accountId);
      const existing = existingBindings.find(
        (binding) => binding.id === input.id || binding.nativeChatId === input.nativeChatId,
      );
      const candidateAtExistingRevision = sanitizeBinding(
        {
          ...existing,
          ...input,
          id: input.id,
          accountId,
          providerConversationKey:
            input.providerConversationKey ?? existing?.providerConversationKey,
          resumeUrl: input.resumeUrl ?? existing?.resumeUrl,
          lastOpenedAt: input.lastOpenedAt ?? existing?.lastOpenedAt,
          createdAt: existing?.createdAt ?? input.createdAt ?? now,
          updatedAt: existing?.updatedAt ?? input.updatedAt ?? now,
        },
        accountId,
      );
      if (!candidateAtExistingRevision) throw new Error('browser_chat_binding_invalid');
      if (existing && equivalentBinding(existing, candidateAtExistingRevision)) {
        return structuredClone(existing);
      }

      const candidate = existing
        ? { ...candidateAtExistingRevision, updatedAt: now }
        : candidateAtExistingRevision;
      const next = existingBindings.filter(
        (binding) => binding.id !== candidate.id && binding.nativeChatId !== candidate.nativeChatId,
      );
      next.push(candidate);
      await writeAll(accountId, next);
      return structuredClone(candidate);
    },

    async patch(accountId, id, patch) {
      const existing = await repository.get(accountId, id);
      if (!existing) throw new Error('browser_chat_binding_not_found');
      return repository.upsert(accountId, {
        ...existing,
        ...patch,
        id: existing.id,
        accountId,
        nativeChatId: existing.nativeChatId,
        workspaceId: existing.workspaceId,
        createdAt: existing.createdAt,
      });
    },

    async remove(accountId, id) {
      if (!validIdentifier(id)) return;
      const bindings = await readAll(accountId);
      const next = bindings.filter((binding) => binding.id !== id);
      if (next.length !== bindings.length) await writeAll(accountId, next);
    },

    async clearAccount(accountId) {
      const key = storageKey(accountId);
      if (store.delete) {
        await store.delete(key);
      } else {
        await store.set(key, { version: 1, bindings: [] });
      }
    },
  };

  return repository;
}

export const browserChatBindingRepository = createBrowserChatBindingRepository();

export const CHAT_WORKSPACE_LAYOUT_VERSION = 1 as const;
export const CHAT_WORKSPACE_PANE_LIMIT = 4;
export const CHAT_WORKSPACE_LAYOUT_STORAGE_EVENT = 'vibespace:chat-workspace-layout-storage';

export type ChatWorkspaceScope = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  primaryChatId: string;
}>;

export type ChatWorkspaceLayoutV1 = Readonly<{
  version: 1;
  chatIds: readonly string[];
  focusedChatId: string;
}>;

export type AddChatPaneResult =
  | ChatWorkspaceLayoutV1
  | Readonly<{ ok: false; reason: 'pane_limit' }>;

export type SaveChatWorkspaceLayoutResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'storage_unavailable' }>;

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ResolvedWorkspaceStorage = Readonly<{
  target: WorkspaceStorage;
  native: boolean;
}>;

const SAFE_CHAT_ID = /^[^\u0000-\u001f\u007f]{1,512}$/;
const LAYOUT_KEYS = ['chatIds', 'focusedChatId', 'version'] as const;

function validChatId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CHAT_ID.test(value) && value.trim() === value;
}

function defaultLayout(primaryChatId: string): ChatWorkspaceLayoutV1 {
  return {
    version: CHAT_WORKSPACE_LAYOUT_VERSION,
    chatIds: [primaryChatId],
    focusedChatId: primaryChatId,
  };
}

function parseLayout(value: unknown): ChatWorkspaceLayoutV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== LAYOUT_KEYS.length ||
    !LAYOUT_KEYS.every((key, index) => key === keys[index]) ||
    record.version !== CHAT_WORKSPACE_LAYOUT_VERSION ||
    !Array.isArray(record.chatIds) ||
    record.chatIds.length < 1 ||
    record.chatIds.length > CHAT_WORKSPACE_PANE_LIMIT ||
    !record.chatIds.every(validChatId) ||
    new Set(record.chatIds).size !== record.chatIds.length ||
    !validChatId(record.focusedChatId) ||
    !record.chatIds.includes(record.focusedChatId)
  ) {
    return null;
  }
  return {
    version: CHAT_WORKSPACE_LAYOUT_VERSION,
    chatIds: [...record.chatIds],
    focusedChatId: record.focusedChatId,
  };
}

function availableStorage(storage?: WorkspaceStorage): ResolvedWorkspaceStorage | undefined {
  if (storage) return { target: storage, native: false };
  if (typeof window === 'undefined') return undefined;
  try {
    return { target: window.localStorage, native: true };
  } catch {
    return undefined;
  }
}

function scopePart(value: string | null): string {
  if (value === null) return 'null:0:';
  const encoded = encodeURIComponent(value);
  return `value:${encoded.length}:${encoded}`;
}

export function chatWorkspaceStorageKey(
  scope: Pick<ChatWorkspaceScope, 'accountId' | 'workspaceId' | 'projectId'>,
): string {
  return [
    'vibespace.chat-workspace-layout.v1',
    scopePart(scope.accountId),
    scopePart(scope.workspaceId),
    scopePart(scope.projectId),
  ].join(':');
}

export function loadChatWorkspaceLayout(
  scope: ChatWorkspaceScope,
  storage?: WorkspaceStorage,
): ChatWorkspaceLayoutV1 {
  const fallback = defaultLayout(scope.primaryChatId);
  const resolved = availableStorage(storage);
  if (!resolved) return fallback;
  const { target } = resolved;
  const key = chatWorkspaceStorageKey(scope);
  try {
    const groups = readGroups(target, key);
    if (groups)
      return groups.find((group) => group.chatIds.includes(scope.primaryChatId)) ?? fallback;
  } catch {
    return fallback;
  }
  let stored: string | null;
  try {
    stored = target.getItem(key);
  } catch {
    return fallback;
  }
  if (!stored) return fallback;
  try {
    const parsed = parseLayout(JSON.parse(stored));
    if (parsed) return parsed.chatIds.includes(scope.primaryChatId) ? parsed : fallback;
  } catch {
    // Corrupt local state is discarded below and never blocks Chat startup.
  }
  try {
    target.removeItem(key);
  } catch {
    // Disabled storage is equivalent to no storage; the fallback remains usable.
  }
  return fallback;
}

// The old key remains a backwards-compatible snapshot. The group index owns
// membership: selecting an unrelated chat must never inherit that snapshot.
function readGroups(target: WorkspaceStorage, key: string): ChatWorkspaceLayoutV1[] | null {
  const raw = target.getItem(`${key}.groups`);
  if (!raw) return null;
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return null;
    const groups = values.map(parseLayout);
    if (groups.some((group) => !group)) return null;
    const ids = groups.flatMap((group) => group!.chatIds);
    return new Set(ids).size === ids.length ? (groups as ChatWorkspaceLayoutV1[]) : null;
  } catch {
    return null;
  }
}

export function saveChatWorkspaceLayout(
  scope: ChatWorkspaceScope,
  layout: ChatWorkspaceLayoutV1,
  storage?: WorkspaceStorage,
): SaveChatWorkspaceLayoutResult {
  const parsed = parseLayout(layout);
  if (!parsed) throw new Error('Invalid chat workspace layout.');
  const resolved = availableStorage(storage);
  if (!resolved) return { ok: false, reason: 'storage_unavailable' };
  const { target } = resolved;
  const key = chatWorkspaceStorageKey(scope);
  try {
    let groups = readGroups(target, key);
    if (!groups) {
      let legacy: ChatWorkspaceLayoutV1 | null = null;
      try {
        legacy = parseLayout(JSON.parse(target.getItem(key) ?? 'null'));
      } catch {
        /* No valid old group. */
      }
      groups = legacy ? [legacy] : [];
    }
    const nextGroups = groups
      .filter((group) => !group.chatIds.includes(scope.primaryChatId))
      .map((group) =>
        pruneChatWorkspaceLayout(
          group,
          group.chatIds.filter((id) => !parsed.chatIds.includes(id)),
          group.focusedChatId,
        ),
      )
      .filter((group): group is ChatWorkspaceLayoutV1 => !!group && group.chatIds.length > 1);
    if (parsed.chatIds.length > 1) nextGroups.push(parsed);
    target.setItem(`${key}.groups`, JSON.stringify(nextGroups));
    target.setItem(key, JSON.stringify(parsed));
  } catch {
    return { ok: false, reason: 'storage_unavailable' };
  }
  if (resolved.native) {
    window.dispatchEvent(
      new CustomEvent(CHAT_WORKSPACE_LAYOUT_STORAGE_EVENT, {
        detail: { key, layout: parsed },
      }),
    );
  }
  return { ok: true };
}

export function clearChatWorkspaceLayout(
  scope: Pick<ChatWorkspaceScope, 'accountId' | 'workspaceId' | 'projectId'>,
  storage?: WorkspaceStorage,
): SaveChatWorkspaceLayoutResult {
  const resolved = availableStorage(storage);
  if (!resolved) return { ok: false, reason: 'storage_unavailable' };
  try {
    resolved.target.removeItem(chatWorkspaceStorageKey(scope));
    resolved.target.removeItem(`${chatWorkspaceStorageKey(scope)}.groups`);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'storage_unavailable' };
  }
}

export function addChatPane(layout: ChatWorkspaceLayoutV1, chatId: string): AddChatPaneResult {
  const existingIndex = layout.chatIds.indexOf(chatId);
  if (existingIndex >= 0) return { ...layout, focusedChatId: chatId };
  if (layout.chatIds.length >= CHAT_WORKSPACE_PANE_LIMIT) {
    return { ok: false, reason: 'pane_limit' };
  }
  return {
    version: CHAT_WORKSPACE_LAYOUT_VERSION,
    chatIds: [...layout.chatIds, chatId],
    focusedChatId: chatId,
  };
}

export function closeChatPane(
  layout: ChatWorkspaceLayoutV1,
  chatId: string,
): ChatWorkspaceLayoutV1 {
  const index = layout.chatIds.indexOf(chatId);
  if (index < 0 || layout.chatIds.length === 1) return layout;
  const chatIds = layout.chatIds.filter((id) => id !== chatId);
  const focusedChatId =
    layout.focusedChatId === chatId
      ? (layout.chatIds[index + 1] ?? layout.chatIds[index - 1] ?? chatIds[0])
      : layout.focusedChatId;
  return { version: CHAT_WORKSPACE_LAYOUT_VERSION, chatIds, focusedChatId };
}

export function focusChatPane(
  layout: ChatWorkspaceLayoutV1,
  chatId: string,
): ChatWorkspaceLayoutV1 {
  if (!layout.chatIds.includes(chatId) || layout.focusedChatId === chatId) return layout;
  return { ...layout, focusedChatId: chatId };
}

export function replacePrimaryChatPane(
  layout: ChatWorkspaceLayoutV1,
  chatId: string,
): ChatWorkspaceLayoutV1 {
  if (layout.chatIds.includes(chatId)) return focusChatPane(layout, chatId);
  return defaultLayout(chatId);
}

export function pruneChatWorkspaceLayout(
  layout: ChatWorkspaceLayoutV1,
  accessibleChatIds: readonly string[],
  primaryChatId: string,
): ChatWorkspaceLayoutV1 | null {
  const accessible = new Set(accessibleChatIds);
  const chatIds = layout.chatIds.filter((chatId) => accessible.has(chatId));
  if (chatIds.length === 0) return null;
  const focusedChatId = chatIds.includes(layout.focusedChatId)
    ? layout.focusedChatId
    : chatIds.includes(primaryChatId)
      ? primaryChatId
      : chatIds[0];
  return { version: CHAT_WORKSPACE_LAYOUT_VERSION, chatIds, focusedChatId };
}

export function layoutClassForPaneCount(count: number): string {
  if (count <= 1) return 'grid-cols-1 grid-rows-1';
  if (count === 2) return 'grid-cols-2 grid-rows-1';
  return 'grid-cols-2 grid-rows-2';
}

export function subscribeChatWorkspaceLayout(
  scope: ChatWorkspaceScope,
  listener: (layout: ChatWorkspaceLayoutV1) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const key = chatWorkspaceStorageKey(scope);
  const onSameDocumentStorage = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string; layout?: unknown }>).detail;
    if (detail?.key !== key) return;
    if (parseLayout(detail.layout)) listener(loadChatWorkspaceLayout(scope));
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key) return;
    listener(loadChatWorkspaceLayout(scope));
  };
  window.addEventListener(CHAT_WORKSPACE_LAYOUT_STORAGE_EVENT, onSameDocumentStorage);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHAT_WORKSPACE_LAYOUT_STORAGE_EVENT, onSameDocumentStorage);
    window.removeEventListener('storage', onStorage);
  };
}

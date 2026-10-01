export type PermissionAccessLevel = 'read' | 'write' | 'full';
export type PermissionSlashKind = 'mode' | 'access' | 'approve-all' | 'status';

export interface PermissionAccessState {
  access: PermissionAccessLevel;
  approveAll: boolean;
}

const STORAGE_KEY = 'vibespace.permission-access.v1';
const MAX_CHATS = 128;
const DEFAULT_ACCESS: PermissionAccessLevel = 'full';

interface StoredChatAccess {
  access: PermissionAccessLevel;
  approveAll: boolean;
  updatedAt: number;
}

interface StoredAccess {
  version: 1;
  chats: Record<string, StoredChatAccess>;
}

function emptyState(): StoredAccess {
  return { version: 1, chats: {} };
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function normalizeAccess(value: unknown): PermissionAccessLevel | undefined {
  return value === 'read' || value === 'write' || value === 'full' ? value : undefined;
}

function readState(storage: Pick<Storage, 'getItem'> | null | undefined): StoredAccess {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.chats || typeof record.chats !== 'object') {
      return emptyState();
    }
    const chats: Record<string, StoredChatAccess> = {};
    for (const [chatId, value] of Object.entries(record.chats as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const access = normalizeAccess((value as Record<string, unknown>).access);
      if (!access) continue;
      chats[chatId] = {
        access,
        approveAll: (value as Record<string, unknown>).approveAll === true,
        updatedAt:
          typeof (value as Record<string, unknown>).updatedAt === 'number'
            ? ((value as Record<string, unknown>).updatedAt as number)
            : 0,
      };
    }
    return { version: 1, chats };
  } catch {
    return emptyState();
  }
}

function writeState(
  state: StoredAccess,
  storage: Pick<Storage, 'setItem'> | null | undefined,
): void {
  try {
    const chats = Object.fromEntries(
      Object.entries(state.chats)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_CHATS),
    );
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, chats }));
  } catch {
    // Access level stays in-memory default when storage is unavailable.
  }
}

export function readPermissionAccess(
  chatId: string,
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): PermissionAccessState {
  const stored = readState(storage).chats[chatId];
  return {
    access: stored?.access ?? DEFAULT_ACCESS,
    approveAll: stored?.approveAll === true,
  };
}

function writeChatAccess(
  chatId: string,
  patch: Partial<PermissionAccessState>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): PermissionAccessState {
  const state = readState(storage);
  const current = state.chats[chatId] ?? {
    access: DEFAULT_ACCESS,
    approveAll: false,
    updatedAt: 0,
  };
  const next = {
    access: patch.access ?? current.access,
    approveAll: patch.approveAll ?? current.approveAll,
    updatedAt: Date.now(),
  };
  state.chats[chatId] = next;
  writeState(state, storage);
  return { access: next.access, approveAll: next.approveAll };
}

export function setPermissionAccess(
  chatId: string,
  access: PermissionAccessLevel,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): PermissionAccessState {
  return writeChatAccess(chatId, { access }, storage);
}

export function setApproveAllForRun(
  chatId: string,
  enabled: boolean,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): PermissionAccessState {
  return writeChatAccess(chatId, { approveAll: enabled }, storage);
}

export function expireApproveAllForRun(
  chatId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): PermissionAccessState {
  return writeChatAccess(chatId, { approveAll: false }, storage);
}

export function parsePermissionAccessArg(arg: string): PermissionAccessLevel | undefined {
  const token = arg.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (token === 'read' || token === 'read only' || token === 'readonly') return 'read';
  if (token === 'write' || token === 'write access') return 'write';
  if (token === 'full' || token === 'full access') return 'full';
  return undefined;
}

export function parsePermissionApproveAllArg(arg: string): boolean | undefined {
  const token = arg.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (
    token === 'approve all' ||
    token === 'approve-all' ||
    token === 'approve all on' ||
    token === 'approve-all on'
  ) {
    return true;
  }
  if (
    token === 'approve all off' ||
    token === 'approve-all off' ||
    token === 'approve-all-off'
  ) {
    return false;
  }
  return undefined;
}

export function parsePermissionSlashArg(arg: string):
  | { kind: 'mode'; value: 'ask' | 'plan' | 'agent' }
  | { kind: 'access'; value: PermissionAccessLevel }
  | { kind: 'approve-all'; value: boolean }
  | { kind: 'status' }
  | undefined {
  const token = arg.trim().toLowerCase();
  if (!token) return undefined;
  if (token === 'status' || token === 'policy') return { kind: 'status' };
  const approve = parsePermissionApproveAllArg(token);
  if (approve !== undefined) return { kind: 'approve-all', value: approve };
  const access = parsePermissionAccessArg(token);
  if (access) return { kind: 'access', value: access };
  if (token === 'ask' || token === 'plan' || token === 'agent') {
    return { kind: 'mode', value: token };
  }
  return undefined;
}

export const PERMISSION_ACCESS_OPTIONS = Object.freeze([
  {
    id: 'read',
    label: 'Read Only',
    description: 'Read, search, RLM, and inspect only. No mutations.',
  },
  {
    id: 'write',
    label: 'Write Access',
    description: 'Read plus create/edit in granted roots. No shell, delete, or browser mutation.',
  },
  {
    id: 'full',
    label: 'Full Access',
    description: 'Write plus terminal, Git, browser, and other approved mutating tools.',
  },
] as const);

export const PERMISSION_APPROVE_OPTIONS = Object.freeze([
  {
    id: 'approve-all',
    label: 'Approve All for This Run',
    description: 'Allow eligible asks for this run only. Hard denies still apply.',
  },
  {
    id: 'approve-all-off',
    label: 'Stop Approve All',
    description: 'Turn off run-scoped auto-approve.',
  },
] as const);

const FULL_ONLY_TOOLS = new Set([
  'terminal.open',
  'terminal.focus',
  'terminal.spawn',
  'terminal.write',
  'terminal.schedule',
  'command.run',
  'plugins.run',
  'app.navigate',
  'schedule.create',
]);

export function accessAllowsTool(
  access: PermissionAccessLevel,
  tool: string,
  mutating: boolean,
): boolean {
  if (!mutating) return true;
  if (access === 'read') return false;
  if (access === 'write') return !FULL_ONLY_TOOLS.has(tool);
  return true;
}

export function formatPermissionPolicy(input: {
  mode: 'ask' | 'plan' | 'agent';
  access: PermissionAccessLevel;
  approveAll: boolean;
}): string {
  const accessLabel =
    input.access === 'read' ? 'Read Only' : input.access === 'write' ? 'Write Access' : 'Full Access';
  return [
    `Mode: ${input.mode === 'ask' ? 'Ask' : input.mode === 'plan' ? 'Plan' : 'Agent'}.`,
    `Access: ${accessLabel}.`,
    `Approve All for This Run: ${input.approveAll ? 'ON' : 'OFF'}.`,
    'Hard denies still apply: no secrets, no paths outside granted roots, no privilege elevation.',
  ].join(' ');
}

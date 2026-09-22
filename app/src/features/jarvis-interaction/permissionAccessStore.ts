export type PermissionAccessLevel = 'read' | 'write' | 'full';
export type AgentApprovalMode = 'full' | 'review';
export const AGENT_APPROVAL_OPTIONS = [
  { id: 'full', label: 'Full access', description: 'Run project tools without routine approval prompts.' },
  { id: 'review', label: 'Review risky actions', description: 'Work autonomously and pause before dangerous actions.' },
] as const;
export type PermissionSlashKind = 'mode' | 'status';

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
  agentApprovalMode?: AgentApprovalMode;
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
        agentApprovalMode: (value as Record<string, unknown>).agentApprovalMode === 'full' ? 'full' : 'review',
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
    agentApprovalMode: current.agentApprovalMode,
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

export function readAgentApprovalMode(
  chatId: string,
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): AgentApprovalMode {
  return readState(storage).chats[chatId]?.agentApprovalMode ?? 'review';
}

export function setAgentApprovalMode(
  chatId: string,
  mode: AgentApprovalMode,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): void {
  const state = readState(storage);
  state.chats[chatId] = {
    access: 'full', approveAll: false, agentApprovalMode: mode, updatedAt: Date.now(),
  };
  writeState(state, storage);
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

export function parsePermissionSlashArg(
  arg: string,
): { kind: 'mode'; value: 'ask' | 'plan' | 'agent' } | { kind: 'agent-profile'; value: AgentApprovalMode } | { kind: 'status' } | undefined {
  const token = arg.trim().toLowerCase();
  if (!token) return undefined;
  if (token === 'agent full') return { kind: 'agent-profile', value: 'full' };
  if (token === 'agent review') return { kind: 'agent-profile', value: 'review' };
  if (token === 'status' || token === 'policy') return { kind: 'status' };
  if (token === 'ask' || token === 'plan' || token === 'agent') {
    return { kind: 'mode', value: token };
  }
  return undefined;
}

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
    input.access === 'read'
      ? 'Read Only'
      : input.access === 'write'
        ? 'Write Access'
        : 'Full Access';
  return [
    `Mode: ${input.mode === 'ask' ? 'Ask' : input.mode === 'plan' ? 'Plan' : 'Agent'}.`,
    `Access: ${accessLabel}.`,
    `Approve All for This Run: ${input.approveAll ? 'ON' : 'OFF'}.`,
    'Hard denies still apply: no secrets, no paths outside granted roots, no privilege elevation.',
  ].join(' ');
}

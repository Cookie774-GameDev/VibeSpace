import type { CustomSkillRecord } from '@/features/skills/skillsStore';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import type { Agent, AgentId } from '@/types';

export const RECYCLE_BIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type RecycledAgentItem = Readonly<{
  archiveId: string;
  kind: 'agent';
  entityId: AgentId;
  name: string;
  deletedAt: number;
  expiresAt: number;
  payload: Agent;
}>;

export type RecycledSkillItem = Readonly<{
  archiveId: string;
  kind: 'skill';
  entityId: string;
  name: string;
  deletedAt: number;
  expiresAt: number;
  payload: CustomSkillRecord;
}>;

export type RecycleBinItem = RecycledAgentItem | RecycledSkillItem;

const STORAGE_PREFIX = 'vibespace-recycle-bin-v1';
const SESSION_SCOPE = '__session__';
const MAX_ARCHIVES = 500;
const MAX_ID_CHARS = 240;
const MAX_NAME_CHARS = 2_000;
const MAX_PAYLOAD_BYTES = 200_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type Listener = () => void;

let activeScope = SESSION_SCOPE;
let snapshot: readonly RecycleBinItem[] = [];
const listeners = new Set<Listener>();

function scopeKey(): string {
  const identity = getActiveAccountIdentity();
  return identity ? `${identity.source}\u0000${identity.accountId}` : SESSION_SCOPE;
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scope)}`;
}

function safeString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || FORBIDDEN_KEYS.has(text)) return null;
  return text;
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function jsonClone<T>(value: T): T | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_PAYLOAD_BYTES) return null;
    return JSON.parse(serialized) as T;
  } catch {
    return null;
  }
}

function normalizeAgent(value: unknown): Agent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cloned = jsonClone(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
  const agent = cloned as Record<string, unknown>;
  const id = safeString(agent.id, MAX_ID_CHARS);
  const slug = safeString(agent.slug, MAX_ID_CHARS);
  const name = safeString(agent.name, MAX_NAME_CHARS);
  const description = typeof agent.description === 'string' ? agent.description : null;
  const prompt = typeof agent.system_prompt === 'string' ? agent.system_prompt : null;
  const createdAt = safeTimestamp(agent.created_at);
  const updatedAt = safeTimestamp(agent.updated_at);
  if (
    !id ||
    !slug ||
    !name ||
    description === null ||
    prompt === null ||
    description.length > 20_000 ||
    prompt.length > 100_000 ||
    createdAt === null ||
    updatedAt === null ||
    agent.builtin === true ||
    !agent.model ||
    typeof agent.model !== 'object' ||
    Array.isArray(agent.model) ||
    !Array.isArray(agent.tools_allowed) ||
    !Array.isArray(agent.capabilities)
  ) {
    return null;
  }
  const model = agent.model as Record<string, unknown>;
  if (
    !safeString(model.provider, MAX_ID_CHARS) ||
    !safeString(model.model, MAX_ID_CHARS) ||
    !['agent', 'project', 'workspace'].includes(String(agent.memory_scope))
  ) {
    return null;
  }
  return cloned as Agent;
}

function normalizeSkill(value: unknown): CustomSkillRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cloned = jsonClone(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
  const skill = cloned as Record<string, unknown>;
  const id = safeString(skill.id, MAX_ID_CHARS);
  const name = safeString(skill.name, 200);
  const createdAt = safeTimestamp(skill.createdAt);
  const updatedAt = safeTimestamp(skill.updatedAt);
  if (
    !id ||
    !name ||
    typeof skill.description !== 'string' ||
    skill.description.length > 2_000 ||
    !Array.isArray(skill.tools) ||
    skill.tools.length > 100 ||
    skill.tools.some((tool) => typeof tool !== 'string' || tool.length > 200) ||
    typeof skill.systemPromptAddendum !== 'string' ||
    skill.systemPromptAddendum.length > 50_000 ||
    typeof skill.body !== 'string' ||
    skill.body.length > 50_000 ||
    typeof skill.color_hue !== 'number' ||
    !Number.isFinite(skill.color_hue) ||
    typeof skill.enabled !== 'boolean' ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return cloned as CustomSkillRecord;
}

function normalizeItem(value: unknown): RecycleBinItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const archiveId = safeString(item.archiveId, MAX_ID_CHARS);
  const entityId = safeString(item.entityId, MAX_ID_CHARS);
  const name = safeString(item.name, MAX_NAME_CHARS);
  const deletedAt = safeTimestamp(item.deletedAt);
  const expiresAt = safeTimestamp(item.expiresAt);
  if (
    !archiveId ||
    !entityId ||
    !name ||
    deletedAt === null ||
    expiresAt === null ||
    expiresAt !== deletedAt + RECYCLE_BIN_RETENTION_MS
  ) {
    return null;
  }
  if (item.kind === 'agent') {
    const payload = normalizeAgent(item.payload);
    if (!payload || payload.id !== entityId || payload.name !== name) return null;
    return {
      archiveId,
      kind: 'agent',
      entityId: entityId as AgentId,
      name,
      deletedAt,
      expiresAt,
      payload,
    };
  }
  if (item.kind === 'skill') {
    const payload = normalizeSkill(item.payload);
    if (!payload || payload.id !== entityId || payload.name !== name) return null;
    return { archiveId, kind: 'skill', entityId, name, deletedAt, expiresAt, payload };
  }
  return null;
}

function recoverItems(value: unknown, now = Date.now()): readonly RecycleBinItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const rawItems = (value as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return [];
  const seen = new Set<string>();
  const recovered: RecycleBinItem[] = [];
  for (const raw of rawItems.slice(0, MAX_ARCHIVES)) {
    const item = normalizeItem(raw);
    if (!item || item.expiresAt <= now || seen.has(item.archiveId)) continue;
    seen.add(item.archiveId);
    recovered.push(item);
  }
  return recovered.sort((left, right) => right.deletedAt - left.deletedAt);
}

function load(scope: string): readonly RecycleBinItem[] {
  if (scope === SESSION_SCOPE || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    return raw ? recoverItems(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function persist(scope: string, items: readonly RecycleBinItem[]): void {
  if (scope === SESSION_SCOPE || typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(scope), JSON.stringify({ items }));
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(next: readonly RecycleBinItem[]): void {
  persist(activeScope, next);
  snapshot = next;
  notify();
}

function activateScope(): void {
  const nextScope = scopeKey();
  if (nextScope === activeScope) return;
  activeScope = nextScope;
  snapshot = load(nextScope);
  notify();
}

function newArchiveId(kind: RecycleBinItem['kind'], entityId: string, deletedAt: number): string {
  const nonce =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `bin_${kind}_${entityId}_${deletedAt}_${nonce}`.slice(0, MAX_ID_CHARS);
}

function archive(item: RecycleBinItem): void {
  activateScope();
  const next = [item, ...snapshot.filter((candidate) => candidate.archiveId !== item.archiveId)]
    .filter(
      (candidate, index, items) =>
        items.findIndex(
          (other) => other.kind === candidate.kind && other.entityId === candidate.entityId,
        ) === index,
    )
    .slice(0, MAX_ARCHIVES);
  publish(next);
}

export const recycleBinStore = {
  getSnapshot(): readonly RecycleBinItem[] {
    activateScope();
    return snapshot;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  refreshScope(): void {
    activateScope();
  },

  archiveAgent(agent: Agent, now = Date.now()): RecycledAgentItem {
    const payload = normalizeAgent(agent);
    if (!payload) throw new Error('This agent cannot be moved to the Recycle Bin.');
    const deletedAt = safeTimestamp(now);
    if (deletedAt === null) throw new Error('The deletion time is invalid.');
    const item: RecycledAgentItem = {
      archiveId: newArchiveId('agent', payload.id, deletedAt),
      kind: 'agent',
      entityId: payload.id,
      name: payload.name,
      deletedAt,
      expiresAt: deletedAt + RECYCLE_BIN_RETENTION_MS,
      payload,
    };
    archive(item);
    return item;
  },

  archiveSkill(skill: CustomSkillRecord, now = Date.now()): RecycledSkillItem {
    const payload = normalizeSkill(skill);
    if (!payload) throw new Error('This skill cannot be moved to the Recycle Bin.');
    const deletedAt = safeTimestamp(now);
    if (deletedAt === null) throw new Error('The deletion time is invalid.');
    const item: RecycledSkillItem = {
      archiveId: newArchiveId('skill', payload.id, deletedAt),
      kind: 'skill',
      entityId: payload.id,
      name: payload.name,
      deletedAt,
      expiresAt: deletedAt + RECYCLE_BIN_RETENTION_MS,
      payload,
    };
    archive(item);
    return item;
  },

  removeArchive(archiveId: string): void {
    activateScope();
    const next = snapshot.filter((item) => item.archiveId !== archiveId);
    if (next.length === snapshot.length) return;
    publish(next);
  },

  restoreArchive(item: RecycleBinItem): void {
    const normalized = normalizeItem(item);
    if (!normalized || normalized.expiresAt <= Date.now()) {
      throw new Error('This Recycle Bin item is no longer recoverable.');
    }
    archive(normalized);
  },

  empty(): void {
    activateScope();
    if (snapshot.length === 0) return;
    publish([]);
  },

  pruneExpired(now = Date.now()): void {
    activateScope();
    const next = snapshot.filter((item) => item.expiresAt > now);
    if (next.length === snapshot.length) return;
    publish(next);
  },
};

export function resetRecycleBinStoreForTests(): void {
  activeScope = SESSION_SCOPE;
  snapshot = [];
  listeners.clear();
}

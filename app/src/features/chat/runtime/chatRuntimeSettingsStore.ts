import {
  DEFAULT_CHAT_RUNTIME_SETTINGS,
  type ChatRuntimeSettings,
} from './chatRuntimeCommandController';
import type { AccessLevel } from '@/lib/permissions/OpenCodePermissionProfile';

const STORAGE_KEY = 'vibespace.chat-runtime-settings.v1';
const MAX_CHAT_ENTRIES = 2_000;

export interface ChatRuntimePolicyState {
  settings: ChatRuntimeSettings;
  access: AccessLevel;
  /** One exact next/current run only. Cleared by Composer after dispatch. */
  approveAllForRun: boolean;
}

export const DEFAULT_CHAT_RUNTIME_POLICY_STATE: Readonly<ChatRuntimePolicyState> = Object.freeze({
  settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
  // Preserve the existing Agent-mode behavior while keeping Access orthogonal.
  access: 'full',
  approveAllForRun: false,
});

interface StoredRuntimePolicyState {
  schemaVersion: 1;
  chats: Record<string, ChatRuntimePolicyState>;
}

function validChatId(value: string): boolean {
  const clean = value.trim();
  return Boolean(clean && clean.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(clean));
}

function isEffort(value: unknown): value is ChatRuntimeSettings['effort'] {
  return ['auto', 'minimal', 'low', 'medium', 'high', 'ultra', 'max'].includes(String(value));
}

function isFastMode(value: unknown): value is ChatRuntimeSettings['fastMode'] {
  return value === 'auto' || value === 'on' || value === 'off';
}

function isPerformance(value: unknown): value is ChatRuntimeSettings['performance'] {
  return value === 'responsive' || value === 'balanced' || value === 'quality';
}

function isAccess(value: unknown): value is AccessLevel {
  return value === 'read-only' || value === 'write' || value === 'full';
}

export function sanitizeChatRuntimePolicyState(value: unknown): ChatRuntimePolicyState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      settings: { ...DEFAULT_CHAT_RUNTIME_SETTINGS },
      access: DEFAULT_CHAT_RUNTIME_POLICY_STATE.access,
      approveAllForRun: false,
    };
  }
  const raw = value as Record<string, unknown>;
  const settingsRaw = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings as Record<string, unknown>
    : raw;
  return {
    settings: {
      effort: isEffort(settingsRaw.effort) ? settingsRaw.effort : DEFAULT_CHAT_RUNTIME_SETTINGS.effort,
      fastMode: isFastMode(settingsRaw.fastMode) ? settingsRaw.fastMode : DEFAULT_CHAT_RUNTIME_SETTINGS.fastMode,
      performance: isPerformance(settingsRaw.performance)
        ? settingsRaw.performance
        : DEFAULT_CHAT_RUNTIME_SETTINGS.performance,
      rlmEnabled: typeof settingsRaw.rlmEnabled === 'boolean'
        ? settingsRaw.rlmEnabled
        : DEFAULT_CHAT_RUNTIME_SETTINGS.rlmEnabled,
    },
    access: isAccess(raw.access) ? raw.access : DEFAULT_CHAT_RUNTIME_POLICY_STATE.access,
    approveAllForRun: raw.approveAllForRun === true,
  };
}

function readAll(): StoredRuntimePolicyState {
  if (typeof localStorage === 'undefined') return { schemaVersion: 1, chats: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { schemaVersion: 1, chats: {} };
    }
    const rawChats = (parsed as { chats?: unknown }).chats;
    if (!rawChats || typeof rawChats !== 'object' || Array.isArray(rawChats)) {
      return { schemaVersion: 1, chats: {} };
    }
    const chats: Record<string, ChatRuntimePolicyState> = {};
    for (const [chatId, state] of Object.entries(rawChats as Record<string, unknown>).slice(-MAX_CHAT_ENTRIES)) {
      if (validChatId(chatId)) chats[chatId] = sanitizeChatRuntimePolicyState(state);
    }
    return { schemaVersion: 1, chats };
  } catch {
    return { schemaVersion: 1, chats: {} };
  }
}

function writeAll(state: StoredRuntimePolicyState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Runtime controls remain usable in memory for this render even when storage is unavailable.
  }
}

export function readChatRuntimePolicyState(chatId: string): ChatRuntimePolicyState {
  const clean = chatId.trim();
  if (!validChatId(clean)) return sanitizeChatRuntimePolicyState(null);
  return sanitizeChatRuntimePolicyState(readAll().chats[clean]);
}

export function writeChatRuntimePolicyState(
  chatId: string,
  state: Readonly<ChatRuntimePolicyState>,
): ChatRuntimePolicyState {
  const clean = chatId.trim();
  if (!validChatId(clean)) throw new Error('Invalid chat id for runtime settings.');
  const sanitized = sanitizeChatRuntimePolicyState(state);
  const current = readAll();
  const entries = Object.entries({ ...current.chats, [clean]: sanitized });
  const chats = Object.fromEntries(entries.slice(-MAX_CHAT_ENTRIES));
  writeAll({ schemaVersion: 1, chats });
  return sanitized;
}

export function updateChatRuntimePolicyState(
  chatId: string,
  update: (current: ChatRuntimePolicyState) => ChatRuntimePolicyState,
): ChatRuntimePolicyState {
  return writeChatRuntimePolicyState(chatId, update(readChatRuntimePolicyState(chatId)));
}

export function clearApproveAllForRun(chatId: string): ChatRuntimePolicyState {
  return updateChatRuntimePolicyState(chatId, (current) => ({
    ...current,
    approveAllForRun: false,
  }));
}

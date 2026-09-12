import {
  getReasoningCapabilities,
  normalizeReasoningPreference,
  type ReasoningEffort,
  type ReasoningMode,
  type ReasoningPreference,
  type ReasoningSelection,
} from '@/lib/ai/reasoningControls';

const STORAGE_KEY = 'vibespace.chat-reasoning.v1';
const MAX_CHATS = 128;
let writeSequence = 0;

interface StoredPreference extends ReasoningPreference {
  updatedAt: number;
}

interface StoredReasoningPreferences {
  version: 1;
  chats: Record<string, StoredPreference>;
}

function emptyState(): StoredReasoningPreferences {
  return { version: 1, chats: {} };
}

function readState(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): StoredReasoningPreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.chats || typeof record.chats !== 'object')
      return emptyState();
    const chats: Record<string, StoredPreference> = {};
    for (const [chatId, value] of Object.entries(record.chats as Record<string, unknown>)) {
      const preference = normalizeReasoningPreference(value);
      const updatedAt =
        value &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).updatedAt === 'number'
          ? ((value as Record<string, unknown>).updatedAt as number)
          : 0;
      chats[chatId] = { ...preference, updatedAt };
    }
    return { version: 1, chats };
  } catch {
    return emptyState();
  }
}

function writeState(
  state: StoredReasoningPreferences,
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
    // Reasoning preferences remain optional when storage is unavailable.
  }
}

function defaultStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function nextUpdatedAt(): number {
  writeSequence = (writeSequence + 1) % 1000;
  return Date.now() * 1000 + writeSequence;
}

export function readChatReasoningPreference(
  chatId: string,
  storage: Pick<Storage, 'getItem'> | null | undefined = defaultStorage(),
): ReasoningPreference {
  return normalizeReasoningPreference(readState(storage).chats[chatId]);
}

export function writeChatReasoningEffort(
  chatId: string,
  effortOverride: ReasoningEffort | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = defaultStorage(),
): void {
  const state = readState(storage);
  state.chats[chatId] = {
    mode: 'normal',
    effortOverride,
    updatedAt: nextUpdatedAt(),
  };
  writeState(state, storage);
}

export function writeChatReasoningMode(
  chatId: string,
  mode: ReasoningMode,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = defaultStorage(),
): void {
  const state = readState(storage);
  state.chats[chatId] = { mode, effortOverride: null, updatedAt: nextUpdatedAt() };
  writeState(state, storage);
}

export function clearChatReasoningPreferences(
  storage: Pick<Storage, 'removeItem'> | null | undefined = defaultStorage(),
): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore blocked storage.
  }
}

export function parseReasoningEffortArgument(value: string): ReasoningEffort | null | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (['auto', 'default', 'normal', 'provider-default'].includes(normalized)) return null;
  if (['x-high', 'xhigh', 'max', 'maximum', 'ultra'].includes(normalized)) return 'ultra';
  if (['minimal', 'low', 'medium', 'high'].includes(normalized)) {
    return normalized as ReasoningEffort;
  }
  return undefined;
}

export function parseReasoningModeArgument(value: string): ReasoningMode | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (['token-saver', 'saver', 'fast', 'cheap'].includes(normalized)) return 'token-saver';
  if (['normal', 'default', 'auto'].includes(normalized)) return 'normal';
  if (['token-final-boss', 'final-boss', 'deep', 'maximum'].includes(normalized)) {
    return 'token-final-boss';
  }
  return undefined;
}

export interface ReasoningSlashPickerOption {
  id: string;
  label: string;
  description: string;
}

export function buildReasoningSlashPickerState({
  command,
  selection,
  preference: rawPreference,
}: {
  command: 'effort' | 'mode';
  selection: ReasoningSelection | null;
  preference: ReasoningPreference;
}): {
  options: ReasoningSlashPickerOption[];
  selectedId: string;
  error?: string;
} {
  const preference = normalizeReasoningPreference(rawPreference);
  if (command === 'mode') {
    return {
      options: [
        {
          id: 'token-saver',
          label: 'Token Saver',
          description: 'Use the lightest supported reasoning and a compact response budget.',
        },
        {
          id: 'normal',
          label: 'Normal',
          description: 'Use the connected model provider’s default reasoning policy.',
        },
        {
          id: 'token-final-boss',
          label: 'Token Final Boss',
          description: 'Use the strongest verified reasoning level this model supports.',
        },
      ],
      selectedId: preference.mode,
    };
  }

  if (!selection) {
    return {
      options: [],
      selectedId: '',
      error: 'Choose a single model before setting effort.',
    };
  }
  const capabilities = getReasoningCapabilities(selection);
  if (capabilities.supportedEfforts.length === 0) {
    return {
      options: [],
      selectedId: '',
      error: 'The selected model does not expose an adjustable reasoning effort.',
    };
  }
  const effortOrder: readonly ReasoningEffort[] = [
    'minimal',
    'low',
    'medium',
    'high',
    'ultra',
  ];
  const selectedEffort = preference.effortOverride
    ? capabilities.supportedEfforts.includes(preference.effortOverride)
      ? preference.effortOverride
      : [...capabilities.supportedEfforts].sort(
          (left, right) =>
            Math.abs(effortOrder.indexOf(left) - effortOrder.indexOf(preference.effortOverride!)) -
              Math.abs(
                effortOrder.indexOf(right) - effortOrder.indexOf(preference.effortOverride!),
              ) || effortOrder.indexOf(left) - effortOrder.indexOf(right),
        )[0]
    : null;
  return {
    options: [
      {
        id: 'auto',
        label: 'Auto',
        description: 'Use the provider default or the active policy mode.',
      },
      ...capabilities.supportedEfforts.map((effort) => ({
        id: effort,
        label: effort[0]!.toUpperCase() + effort.slice(1),
        description: `${effort[0]!.toUpperCase() + effort.slice(1)} reasoning effort.`,
      })),
    ],
    selectedId: preference.effortOverride === null ? 'auto' : (selectedEffort ?? 'auto'),
  };
}

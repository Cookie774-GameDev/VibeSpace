import { TOKEN_OPTIMIZATION_MODES, type TokenOptimizationMode } from './contracts';

export const TOKEN_OPTIMIZATION_PREFERENCES_KEY = 'vibespace.token-optimization.preferences.v1';

const MAX_CHAT_OVERRIDES = 256;
export const MIN_DEFAULT_OUTPUT_TOKENS = 256;
export const MAX_DEFAULT_OUTPUT_TOKENS = 32_768;
export const DEFAULT_OUTPUT_TOKENS = 8_192;
const SAFE_CHAT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODES = new Set<string>(TOKEN_OPTIMIZATION_MODES);

export interface TokenOptimizationPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TokenOptimizationPreferences {
  readonly version: 1;
  readonly globalMode: TokenOptimizationMode;
  readonly defaultMaxOutputTokens: number;
  readonly allowStructuralCodeCompression: boolean;
  readonly showOptimizationReportAutomatically: boolean;
  readonly neverChangeSelectedModel: true;
  readonly chatOverrides: Readonly<Record<string, TokenOptimizationMode>>;
}

export interface TokenOptimizationPreferenceStore {
  getSnapshot(): TokenOptimizationPreferences;
  setGlobalMode(mode: TokenOptimizationMode): void;
  setDefaultMaxOutputTokens(tokens: number): void;
  setAllowStructuralCodeCompression(allowed: boolean): void;
  setShowOptimizationReportAutomatically(show: boolean): void;
  setChatOverride(chatKey: string, mode: TokenOptimizationMode): void;
  clearChatOverride(chatKey: string): void;
  resolveMode(chatKey?: string | null): TokenOptimizationMode;
  reset(): void;
}

function isMode(value: unknown): value is TokenOptimizationMode {
  return typeof value === 'string' && MODES.has(value);
}

function assertMode(value: unknown): asserts value is TokenOptimizationMode {
  if (!isMode(value)) throw new Error('Invalid token optimization mode.');
}

function assertChatKey(chatKey: string): void {
  if (!SAFE_CHAT_KEY.test(chatKey)) {
    throw new Error('Invalid chat preference key.');
  }
}

function freezeSnapshot(
  globalMode: TokenOptimizationMode,
  chatOverrides: Record<string, TokenOptimizationMode>,
  options: Readonly<{
    defaultMaxOutputTokens: number;
    allowStructuralCodeCompression: boolean;
    showOptimizationReportAutomatically: boolean;
  }>,
): TokenOptimizationPreferences {
  const ordered = Object.fromEntries(
    Object.entries(chatOverrides).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  ) as Record<string, TokenOptimizationMode>;
  return Object.freeze({
    version: 1 as const,
    globalMode,
    defaultMaxOutputTokens: options.defaultMaxOutputTokens,
    allowStructuralCodeCompression: options.allowStructuralCodeCompression,
    showOptimizationReportAutomatically: options.showOptimizationReportAutomatically,
    neverChangeSelectedModel: true as const,
    chatOverrides: Object.freeze(ordered),
  });
}

function defaultSnapshot(): TokenOptimizationPreferences {
  return freezeSnapshot('off', {}, {
    defaultMaxOutputTokens: DEFAULT_OUTPUT_TOKENS,
    allowStructuralCodeCompression: true,
    showOptimizationReportAutomatically: true,
  });
}

function parseSnapshot(raw: string | null): TokenOptimizationPreferences {
  if (!raw) return defaultSnapshot();
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      globalMode?: unknown;
      defaultMaxOutputTokens?: unknown;
      allowStructuralCodeCompression?: unknown;
      showOptimizationReportAutomatically?: unknown;
      chatOverrides?: unknown;
    };
    if (
      value.version !== 1 ||
      !isMode(value.globalMode) ||
      !value.chatOverrides ||
      typeof value.chatOverrides !== 'object' ||
      Array.isArray(value.chatOverrides)
    ) {
      return defaultSnapshot();
    }
    const overrides: Record<string, TokenOptimizationMode> = {};
    for (const [chatKey, mode] of Object.entries(value.chatOverrides)) {
      if (Object.keys(overrides).length >= MAX_CHAT_OVERRIDES) break;
      if (SAFE_CHAT_KEY.test(chatKey) && isMode(mode)) overrides[chatKey] = mode;
    }
    const defaultMaxOutputTokens =
      Number.isSafeInteger(value.defaultMaxOutputTokens) &&
      Number(value.defaultMaxOutputTokens) >= MIN_DEFAULT_OUTPUT_TOKENS &&
      Number(value.defaultMaxOutputTokens) <= MAX_DEFAULT_OUTPUT_TOKENS
        ? Number(value.defaultMaxOutputTokens)
        : DEFAULT_OUTPUT_TOKENS;
    return freezeSnapshot(value.globalMode, overrides, {
      defaultMaxOutputTokens,
      allowStructuralCodeCompression:
        typeof value.allowStructuralCodeCompression === 'boolean'
          ? value.allowStructuralCodeCompression
          : true,
      showOptimizationReportAutomatically:
        typeof value.showOptimizationReportAutomatically === 'boolean'
          ? value.showOptimizationReportAutomatically
          : true,
    });
  } catch {
    return defaultSnapshot();
  }
}

export function createTokenOptimizationPreferenceStore(
  storage: TokenOptimizationPreferenceStorage,
): TokenOptimizationPreferenceStore {
  let snapshot = parseSnapshot(storage.getItem(TOKEN_OPTIMIZATION_PREFERENCES_KEY));

  const persist = (
    globalMode: TokenOptimizationMode,
    chatOverrides: Record<string, TokenOptimizationMode>,
    options: Readonly<{
      defaultMaxOutputTokens: number;
      allowStructuralCodeCompression: boolean;
      showOptimizationReportAutomatically: boolean;
    }> = snapshot,
  ) => {
    snapshot = freezeSnapshot(globalMode, chatOverrides, options);
    storage.setItem(TOKEN_OPTIMIZATION_PREFERENCES_KEY, JSON.stringify(snapshot));
  };

  return {
    getSnapshot: () => snapshot,
    setGlobalMode(mode) {
      assertMode(mode);
      persist(mode, { ...snapshot.chatOverrides });
    },
    setDefaultMaxOutputTokens(tokens) {
      if (
        !Number.isSafeInteger(tokens) ||
        tokens < MIN_DEFAULT_OUTPUT_TOKENS ||
        tokens > MAX_DEFAULT_OUTPUT_TOKENS
      ) {
        throw new Error('Invalid default output token limit.');
      }
      persist(snapshot.globalMode, { ...snapshot.chatOverrides }, {
        ...snapshot,
        defaultMaxOutputTokens: tokens,
      });
    },
    setAllowStructuralCodeCompression(allowed) {
      if (typeof allowed !== 'boolean') throw new Error('Invalid structural compression setting.');
      persist(snapshot.globalMode, { ...snapshot.chatOverrides }, {
        ...snapshot,
        allowStructuralCodeCompression: allowed,
      });
    },
    setShowOptimizationReportAutomatically(show) {
      if (typeof show !== 'boolean') throw new Error('Invalid optimization report setting.');
      persist(snapshot.globalMode, { ...snapshot.chatOverrides }, {
        ...snapshot,
        showOptimizationReportAutomatically: show,
      });
    },
    setChatOverride(chatKey, mode) {
      assertChatKey(chatKey);
      assertMode(mode);
      const overrides = { ...snapshot.chatOverrides, [chatKey]: mode };
      const orderedKeys = Object.keys(overrides).sort();
      while (orderedKeys.length > MAX_CHAT_OVERRIDES) {
        delete overrides[orderedKeys.shift()!];
      }
      persist(snapshot.globalMode, overrides);
    },
    clearChatOverride(chatKey) {
      assertChatKey(chatKey);
      const overrides = { ...snapshot.chatOverrides };
      delete overrides[chatKey];
      persist(snapshot.globalMode, overrides);
    },
    resolveMode(chatKey) {
      if (!chatKey) return snapshot.globalMode;
      assertChatKey(chatKey);
      return snapshot.chatOverrides[chatKey] ?? snapshot.globalMode;
    },
    reset() {
      snapshot = defaultSnapshot();
      storage.removeItem(TOKEN_OPTIMIZATION_PREFERENCES_KEY);
    },
  };
}

import {
  createTokenOptimizationPreferenceStore,
  TOKEN_OPTIMIZATION_PREFERENCES_KEY,
  type TokenOptimizationPreferenceStorage,
  type TokenOptimizationPreferences,
} from './modePreferences';
import type { TokenOptimizationMode } from './contracts';

export interface BrowserTokenOptimizationPreferences {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TokenOptimizationPreferences;
  setGlobalMode(mode: TokenOptimizationMode): void;
  setDefaultMaxOutputTokens(tokens: number): void;
  setAllowStructuralCodeCompression(allowed: boolean): void;
  setShowOptimizationReportAutomatically(show: boolean): void;
  setChatOverride(chatKey: string, mode: TokenOptimizationMode | null): void;
  resolveMode(chatKey?: string | null): TokenOptimizationMode;
  refresh(): void;
}

export function createBrowserTokenOptimizationPreferences(
  storage: TokenOptimizationPreferenceStorage,
): BrowserTokenOptimizationPreferences {
  let store = createTokenOptimizationPreferenceStore(storage);
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => store.getSnapshot(),
    setGlobalMode(mode) {
      store.setGlobalMode(mode);
      emit();
    },
    setDefaultMaxOutputTokens(tokens) {
      store.setDefaultMaxOutputTokens(tokens);
      emit();
    },
    setAllowStructuralCodeCompression(allowed) {
      store.setAllowStructuralCodeCompression(allowed);
      emit();
    },
    setShowOptimizationReportAutomatically(show) {
      store.setShowOptimizationReportAutomatically(show);
      emit();
    },
    setChatOverride(chatKey, mode) {
      if (mode === null) store.clearChatOverride(chatKey);
      else store.setChatOverride(chatKey, mode);
      emit();
    },
    resolveMode: (chatKey) => store.resolveMode(chatKey),
    refresh() {
      store = createTokenOptimizationPreferenceStore(storage);
      emit();
    },
  };
}

const memory = new Map<string, string>();
const memoryStorage: TokenOptimizationPreferenceStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const storage =
  typeof window !== 'undefined'
    ? {
        getItem: (key: string) => window.localStorage.getItem(key),
        setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
        removeItem: (key: string) => window.localStorage.removeItem(key),
      }
    : memoryStorage;

export const browserTokenOptimizationPreferences =
  createBrowserTokenOptimizationPreferences(storage);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_OPTIMIZATION_PREFERENCES_KEY) {
      browserTokenOptimizationPreferences.refresh();
    }
  });
}

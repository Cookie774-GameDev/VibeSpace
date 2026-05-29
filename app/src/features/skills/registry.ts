/**
 * Singleton skill / agent registry.
 *
 * Wraps `loadAllSkills` + `loadAllAgents` with an in-memory map and a
 * subscribe API so the SkillsPage can react to toggles without
 * re-parsing every render.
 *
 * The contract (per Slice 5 spec) supports both `list/get/toggle` and
 * the alias names `getAll/setEnabled` so consumers from either naming
 * convention work without translation.
 */

import type { SkillManifest } from './loader';
import { loadAllAgents, loadAllSkills } from './loader';

type Listener = (entries: SkillManifest[]) => void;

const entries = new Map<string, SkillManifest>();
const listeners = new Set<Listener>();
let loaded = false;
let loadPromise: Promise<SkillManifest[]> | null = null;

function notify(): void {
  const arr = Array.from(entries.values());
  for (const fn of listeners) {
    try {
      fn(arr);
    } catch (err) {
      console.error('skillRegistry listener threw:', err);
    }
  }
}

function setEntries(arr: SkillManifest[]): void {
  entries.clear();
  for (const m of arr) entries.set(m.name, m);
  notify();
}

export const skillRegistry = {
  /**
   * Load builtins (and, in a future wave, the user's project `.jarvis/`).
   * Idempotent — concurrent callers share the same in-flight Promise.
   */
  async loadFromDisk(opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const [skills, agents] = await Promise.all([loadAllSkills(opts), loadAllAgents(opts)]);
      const all = [...skills, ...agents];
      setEntries(all);
      loaded = true;
      return all;
    })();
    try {
      return await loadPromise;
    } finally {
      // Allow re-load via explicit `reload()` later; for now keep cached.
      loadPromise = null;
    }
  },

  /** Force a re-read from disk on next call. */
  reload(opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
    loaded = false;
    return skillRegistry.loadFromDisk(opts);
  },

  list(kind?: 'skill' | 'agent'): SkillManifest[] {
    const arr = Array.from(entries.values());
    if (!kind) return arr;
    return arr.filter((m) => m.kind === kind);
  },

  /** Alias of `list()` — kept for parity with code that already uses this name. */
  getAll(): SkillManifest[] {
    return Array.from(entries.values());
  },

  get(name: string): SkillManifest | undefined {
    return entries.get(name);
  },

  toggle(name: string, enabled: boolean): void {
    const cur = entries.get(name);
    if (!cur) return;
    entries.set(name, { ...cur, enabled });
    notify();
  },

  /** Alias of `toggle()` for the consumer that uses this name. */
  setEnabled(name: string, enabled: boolean): void {
    skillRegistry.toggle(name, enabled);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /** Inspector helper: has the initial load resolved? */
  isLoaded(): boolean {
    return loaded;
  },
};

export type { SkillManifest } from './loader';

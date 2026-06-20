/**
 * Singleton skill / agent registry.
 *
 * Built-in presets + user custom skills come from `skillCatalog` /
 * `skillsStore`. Legacy bundled `.md` agents are still loaded from disk.
 */

import type { SkillManifest } from './loader';
import { getUnifiedSkillManifests } from './skillCatalog';
import { loadAllAgents } from './loader';
import { readSkillsStore } from './skillsStore';
import { notifyDone } from '@/lib/notifications';

type Listener = (entries: SkillManifest[]) => void;

const entries = new Map<string, SkillManifest>();
const listeners = new Set<Listener>();
let loaded = false;

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
  for (const m of arr) entries.set(m.catalogId ?? m.name, m);
  notify();
}

function refreshFromCatalog(): SkillManifest[] {
  const skills = getUnifiedSkillManifests();
  const agents = entries.size > 0 ? Array.from(entries.values()).filter((m) => m.kind === 'agent') : [];
  const all = [...skills, ...agents];
  setEntries(all);
  return all;
}

export const skillRegistry = {
  /**
   * Seed the unified catalog (16 presets + custom skills) and merge any
   * bundled agent manifests. Idempotent.
   */
  async loadFromDisk(opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
    const agents = await loadAllAgents(opts);
    const skills = getUnifiedSkillManifests();
    const all = [...skills, ...agents];
    setEntries(all);
    loaded = true;
    return all;
  },

  /** Re-read catalog + agent manifests. */
  async reload(opts?: { projectRoot?: string }): Promise<SkillManifest[]> {
    loaded = false;
    return skillRegistry.loadFromDisk(opts);
  },

  /** Refresh in-memory manifests after store edits (no disk IO). */
  refresh(): void {
    refreshFromCatalog();
  },

  list(kind?: 'skill' | 'agent'): SkillManifest[] {
    const arr = Array.from(entries.values());
    if (!kind) return arr;
    return arr.filter((m) => m.kind === kind);
  },

  getAll(): SkillManifest[] {
    return Array.from(entries.values());
  },

  get(name: string): SkillManifest | undefined {
    return entries.get(name);
  },

  toggle(name: string, enabled: boolean): void {
    const cur = entries.get(name);
    if (!cur || cur.kind !== 'skill') return;
    const store = readSkillsStore();
    if (cur.isPreset) {
      store.setSkillEnabled(name, enabled, 'preset');
    } else {
      store.setSkillEnabled(name, enabled, 'custom');
    }
    entries.set(name, { ...cur, enabled });
    notify();
    void notifyDone('skills', enabled ? 'Skill enabled' : 'Skill disabled', cur.title || cur.name);
  },

  setEnabled(name: string, enabled: boolean): void {
    skillRegistry.toggle(name, enabled);
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  isLoaded(): boolean {
    return loaded;
  },
};

export type { SkillManifest } from './loader';

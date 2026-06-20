import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PinnedContextMap = {
  id: string;
  title: string;
  rootDir: string;
  pinnedAt: number;
};

export type PinnedFile = {
  path: string;
  title: string;
  pinnedAt: number;
};

interface PinnedState {
  files: PinnedFile[];
  maps: PinnedContextMap[];
  pinFile: (path: string, title?: string) => void;
  unpinFile: (path: string) => void;
  pinMap: (map: Omit<PinnedContextMap, 'pinnedAt'>) => void;
  unpinMap: (id: string) => void;
  isFilePinned: (path: string) => boolean;
  isMapPinned: (id: string) => boolean;
}

export const usePinnedStore = create<PinnedState>()(
  persist(
    (set, get) => ({
      files: [],
      maps: [],
      pinFile: (path, title) => {
        const normalized = path.trim();
        if (!normalized) return;
        if (get().files.some((f) => f.path === normalized)) return;
        set({
          files: [
            { path: normalized, title: title ?? normalized.split(/[/\\]/).pop() ?? normalized, pinnedAt: Date.now() },
            ...get().files,
          ].slice(0, 24),
        });
      },
      unpinFile: (path) => set({ files: get().files.filter((f) => f.path !== path) }),
      pinMap: (map) => {
        if (get().maps.some((m) => m.id === map.id)) return;
        set({
          maps: [{ ...map, pinnedAt: Date.now() }, ...get().maps].slice(0, 12),
        });
      },
      unpinMap: (id) => set({ maps: get().maps.filter((m) => m.id !== id) }),
      isFilePinned: (path) => get().files.some((f) => f.path === path),
      isMapPinned: (id) => get().maps.some((m) => m.id === id),
    }),
    { name: 'jarvis-inspector-pinned-v1' },
  ),
);

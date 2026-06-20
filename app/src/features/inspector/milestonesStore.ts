import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { MilestoneItem, MilestoneStatus } from './types';

function newId(): string {
  return `ms_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

interface MilestonesState {
  items: MilestoneItem[];
  addMilestone: (title: string, description?: string) => string;
  updateMilestone: (id: string, patch: Partial<Pick<MilestoneItem, 'title' | 'description' | 'status'>>) => void;
  removeMilestone: (id: string) => void;
  toggleDone: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
}

export const useMilestonesStore = create<MilestonesState>()(
  persist(
    (set, get) => ({
      items: [],
      addMilestone: (title, description) => {
        const id = newId();
        const now = Date.now();
        const item: MilestoneItem = {
          id,
          title: title.trim(),
          description: description?.trim() || undefined,
          status: 'todo',
          createdAt: now,
          updatedAt: now,
        };
        set({ items: [item, ...get().items] });
        return id;
      },
      updateMilestone: (id, patch) => {
        const now = Date.now();
        set({
          items: get().items.map((item) => {
            if (item.id !== id) return item;
            const nextStatus = patch.status ?? item.status;
            return {
              ...item,
              ...patch,
              status: nextStatus,
              updatedAt: now,
              completedAt: nextStatus === 'done' ? now : item.completedAt,
            };
          }),
        });
      },
      removeMilestone: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
      toggleDone: (id) => {
        const item = get().items.find((i) => i.id === id);
        if (!item) return;
        const next: MilestoneStatus = item.status === 'done' ? 'todo' : 'done';
        get().updateMilestone(id, { status: next });
      },
      reorder: (fromIndex, toIndex) => {
        const items = [...get().items];
        const [moved] = items.splice(fromIndex, 1);
        if (!moved) return;
        items.splice(toIndex, 0, moved);
        set({ items });
      },
    }),
    { name: 'jarvis-inspector-milestones-v1' },
  ),
);

export function openMilestoneCount(): number {
  return useMilestonesStore.getState().items.filter((i) => i.status !== 'done').length;
}

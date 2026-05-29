import { create } from 'zustand';
import type { DraftTask } from '@/types/task';

/**
 * Ephemeral UI state for the task panel.
 *
 * Tasks themselves are persisted via taskRepo + dexie; this store only
 * holds in-memory selection, popover anchors, and pending draft tasks
 * surfaced from the action extractor.
 */
interface TaskUIState {
  /** ID of the currently selected/focused task in the panel (if any). */
  selectedTaskId: string | null;
  /** Reminder ID for which the snooze popover is open. */
  snoozeOpenForReminderId: string | null;
  /** Pending draft tasks shown in the "Suggested" section. */
  drafts: DraftTask[];
  /** Set of task IDs currently flashing the accent gradient (newly created). */
  flashedTaskIds: Set<string>;

  // ---- selectors / actions ----
  setSelectedTask: (id: string | null) => void;
  openSnoozeFor: (reminderId: string | null) => void;

  setDrafts: (drafts: DraftTask[]) => void;
  addDraft: (draft: DraftTask) => void;
  removeDraft: (id: string) => void;
  clearDrafts: () => void;

  flashTask: (taskId: string) => void;
  unflashTask: (taskId: string) => void;
}

/** How long the accent gradient flashes after a new task is added. */
const FLASH_DURATION_MS = 1100;

export const useTaskStore = create<TaskUIState>((set, get) => ({
  selectedTaskId: null,
  snoozeOpenForReminderId: null,
  drafts: [],
  flashedTaskIds: new Set<string>(),

  setSelectedTask: (id) => set({ selectedTaskId: id }),
  openSnoozeFor: (reminderId) => set({ snoozeOpenForReminderId: reminderId }),

  setDrafts: (drafts) => set({ drafts }),
  addDraft: (draft) =>
    set((s) => ({
      drafts: s.drafts.find((d) => d.id === draft.id) ? s.drafts : [...s.drafts, draft],
    })),
  removeDraft: (id) => set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) })),
  clearDrafts: () => set({ drafts: [] }),

  flashTask: (taskId) => {
    set((s) => {
      const next = new Set(s.flashedTaskIds);
      next.add(taskId);
      return { flashedTaskIds: next };
    });
    // Auto-clear after the duration.
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        get().unflashTask(taskId);
      }, FLASH_DURATION_MS);
    }
  },
  unflashTask: (taskId) =>
    set((s) => {
      if (!s.flashedTaskIds.has(taskId)) return {};
      const next = new Set(s.flashedTaskIds);
      next.delete(taskId);
      return { flashedTaskIds: next };
    }),
}));

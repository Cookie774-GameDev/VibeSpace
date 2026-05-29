import { create } from 'zustand';

/**
 * The set of pages the palette can show. Pages are pushed onto a stack;
 * the top of the stack is the visible page. 'root' is implicit when the
 * stack is empty.
 */
export type PageId =
  | 'root'
  | 'theme'
  | 'switch-agent'
  | 'switch-mode'
  | 'new'
  | 'recent-chats'
  | 'tasks';

/**
 * Human-readable page labels used in the breadcrumb.
 */
export const PAGE_LABELS: Record<PageId, string> = {
  root: 'All',
  theme: 'Theme',
  'switch-agent': 'Switch agent',
  'switch-mode': 'Switch chat mode',
  new: 'New',
  'recent-chats': 'Recent chats',
  tasks: 'Tasks',
};

/**
 * Lightweight reference to a chat shown in the "Recent chats" page.
 * Kept minimal so the palette doesn't take a hard dep on a chat repo
 * that is owned by another feature.
 */
export type RecentChat = {
  id: string;
  title: string;
  updated_at: number;
};

/**
 * Lightweight task reference used in the "Tasks" page.
 */
export type TaskListItem = {
  id: string;
  title: string;
  due_at?: number;
};

interface PaletteState {
  /** Stack of nested pages. Empty stack means we're on root. */
  pageStack: PageId[];
  /** Current input search string. Reset on every nav transition. */
  search: string;

  pushPage: (p: PageId) => void;
  popPage: () => void;
  popToIndex: (index: number) => void;
  resetPages: () => void;
  setSearch: (s: string) => void;
}

export const usePaletteStore = create<PaletteState>()((set) => ({
  pageStack: [],
  search: '',

  pushPage: (p) =>
    set((s) => ({
      pageStack: [...s.pageStack, p],
      search: '',
    })),

  popPage: () =>
    set((s) => ({
      pageStack: s.pageStack.slice(0, -1),
      search: '',
    })),

  /** Pop the stack down to (and including) the page at `index`. -1 to root. */
  popToIndex: (index) =>
    set((s) => ({
      pageStack: index < 0 ? [] : s.pageStack.slice(0, index + 1),
      search: '',
    })),

  resetPages: () => set({ pageStack: [], search: '' }),

  setSearch: (s) => set({ search: s }),
}));

/**
 * Get the visible page given a stack. Empty stack maps to 'root'.
 */
export function getCurrentPage(stack: PageId[]): PageId {
  return stack[stack.length - 1] ?? 'root';
}

/* ------------------------------------------------------------------
 * Data adapter store
 * ------------------------------------------------------------------
 * Some pages render data owned by other features (chat repo, task
 * repo). To keep the palette decoupled from those features, we expose
 * a tiny store that the App layer can populate. The pages subscribe
 * via selectors so they re-render reactively.
 * ------------------------------------------------------------------ */

interface PaletteDataState {
  recentChats: RecentChat[];
  tasks: TaskListItem[];
  setRecentChats: (chats: RecentChat[]) => void;
  setTasks: (tasks: TaskListItem[]) => void;
}

export const usePaletteDataStore = create<PaletteDataState>()((set) => ({
  recentChats: [],
  tasks: [],
  setRecentChats: (chats) => set({ recentChats: chats }),
  setTasks: (tasks) => set({ tasks }),
}));

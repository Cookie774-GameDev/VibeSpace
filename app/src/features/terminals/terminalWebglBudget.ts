export const MAX_ACTIVE_TERMINAL_WEBGL_CONTEXTS = 6;

export interface TerminalWebglLease {
  release(): void;
}

export function createTerminalWebglBudget(limit = MAX_ACTIVE_TERMINAL_WEBGL_CONTEXTS) {
  let activeCount = 0;

  return {
    acquire(): TerminalWebglLease | null {
      if (activeCount >= limit) return null;
      activeCount += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          activeCount = Math.max(0, activeCount - 1);
        },
      };
    },
    active() {
      return activeCount;
    },
  };
}

export const terminalWebglBudget = createTerminalWebglBudget();

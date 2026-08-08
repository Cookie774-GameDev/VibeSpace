/**
 * TerminalsPage — the `'terminal'` route's body.
 *
 * Owns the pane tree state, persists shape (not session ids) to
 * localStorage so reloads restore the layout without zombie PTYs.
 *
 * Project-scoped: the pane tree key in localStorage is suffixed with
 * the active project id (`jarvis-terminal-pane-tree:<projectId>`) so
 * each project carries its own set of terminals. Switching projects
 * swaps the entire tree out from under the user — chats and terminals
 * "switch when I am in a different project," exactly as specced.
 *
 * Layout: tile-grid only as of the Projects update. The legacy splits
 * mode was retired because every cell border is a draggable resize
 * handle, which gives the same affordance with less mode chrome.
 *
 * Per-pane `agentSlug` lets the user tag each pane with one of the
 * seeded agents. Picking an agent on a blank pane pre-fills a sensible
 * CLI for that role (Coder → 'claude'), and any AI request fired
 * through the runtime that resolves to that slug picks up this pane's
 * `connectedFiles` and recent transcript.
 */

import * as React from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { TileGrid } from './TileGrid';
import {
  type PaneNode,
  type PaneTreeChange,
  newLeaf,
  countLeaves,
  flattenLeaves,
  appendLeaf,
  fromLeaves,
  closePane,
  MAX_PANES,
  resolvePaneTreeChange,
} from './paneTree';
import {
  claimTerminalCommands,
  useTerminalCommandQueue,
  type TerminalCommand,
} from './terminalCommandQueue';
import {
  claimTerminalExecution,
  hasCanonicalTerminalExecution,
  markTerminalExecution,
  requestTerminalExecutionCancellation,
  terminalCancellationDisposition,
} from './terminalExecutionStore';
import type { TerminalRef } from './terminalRefs';
import {
  defaultShell,
  loadTerminalTreeForProject,
  moveTerminalLeafToProject,
  saveTerminalTree,
} from './terminalProjectMove';
import { useLiveQuery } from 'dexie-react-hooks';
import { projectRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { captureLiveTree, getLiveTree } from './terminalLiveCache';
import { useTerminalTranscriptStore } from './transcriptStore';
import type { JarvisCancellationRequestResult } from '@/lib/jarvis/contracts/execution';
import './sakura-terminal.css';

export function summarizeTerminalResetCancellations(
  results: readonly (JarvisCancellationRequestResult | null)[],
): { pending: number; terminal: number; rejected: number } {
  const summary = { pending: 0, terminal: 0, rejected: 0 };
  for (const result of results) summary[terminalCancellationDisposition(result)] += 1;
  return summary;
}

/**
 * Map an agent slug to a default CLI to spawn in a fresh pane.
 *
 * Only used when the user assigns a role to a pane that has no command
 * yet. We never overwrite an existing command. With the trimmed
 * Coder/Builder use Claude, while review/scout-style panes use OpenCode.
 * We only apply this to blank panes; existing user commands are never
 * overwritten.
 */
export function commandForAgent(slug: string): string | undefined {
  switch (slug) {
    case 'coder':
    case 'builder':
      return 'claude';
    case 'scout':
    case 'reviewer':
    case 'critic':
      return 'opencode';
    case 'jarvis':
    default:
      return undefined;
  }
}

export function forgetTerminalLeafSessions(
  tree: PaneNode,
  forgetSession: (sessionId: string) => void,
): void {
  for (const leaf of flattenLeaves(tree)) {
    if (leaf.sessionId) forgetSession(leaf.sessionId);
  }
}

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export async function deleteTerminalProjectSnapshots(
  projectId: string | null,
  invokeCommand: InvokeCommand = invoke,
): Promise<void> {
  await invokeCommand('terminal_snapshot_delete_project', { projectId });
}

export function applyTerminalCommandBatch(
  current: PaneNode,
  items: readonly TerminalCommand[],
  markExecution: typeof markTerminalExecution = markTerminalExecution,
): PaneNode {
  let next = current;
  let replaceRootNext = false;
  for (const item of items) {
    if (item.kind === 'shell') {
      markExecution(item.id, 'starting');
      if (item.target === 'all') {
        const pendingCommandId = Date.now();
        next = fromLeaves(
          flattenLeaves(next).map((leaf, index) => ({
            ...leaf,
            pendingCommand: item.command,
            pendingCommandId: pendingCommandId + index,
          })),
        );
      } else if (item.target === 'refs' && item.refs && item.refs.length > 0) {
        const refs = item.refs;
        const pendingCommandId = Date.now();
        let matched = false;
        next = fromLeaves(
          flattenLeaves(next).map((leaf, index) => {
            const hit = refs.some(
              (ref) =>
                (ref.paneId && ref.paneId === leaf.id) ||
                (ref.sessionId && ref.sessionId === leaf.sessionId),
            );
            if (!hit) return leaf;
            matched = true;
            return {
              ...leaf,
              pendingCommand: item.command,
              pendingCommandId: pendingCommandId + index,
            };
          }),
        );
        if (!matched) {
          const first = refs[0];
          next = appendLeaf(next, {
            command: defaultShell(),
            startupCommand: item.command || undefined,
            agentSlug: first?.agentSlug ?? item.label,
          });
        }
      } else {
        const seed = {
          command: defaultShell(),
          startupCommand: item.command || undefined,
          startupCommands: item.startupCommands,
          preserveExisting: item.preserveExisting,
          agentSlug: item.agentSlug ?? item.label,
          name: item.agentSlug ? item.label : undefined,
          cwd: item.cwd,
          executionId: item.id,
        };
        if (replaceRootNext && countLeaves(next) === 1) {
          next = newLeaf(seed);
          replaceRootNext = false;
        } else {
          next = appendLeaf(next, seed);
        }
      }
    } else if (item.kind === 'swarm') {
      next = appendLeaf(next, {
        command: defaultShell(),
        agentSlug: 'jarvis',
      });
    } else if (item.kind === 'close') {
      const leaves = flattenLeaves(next);
      const closeCount = Math.min(item.count, leaves.length);
      for (const leaf of leaves.slice(-closeCount)) {
        const closed = closePane(next, leaf.id);
        if (closed) next = closed;
      }
      if (closeCount >= leaves.length) replaceRootNext = true;
    }
  }
  return next;
}

export function canClaimCanonicalTerminalCommand(
  current: PaneNode,
  priorClaimedItems: readonly TerminalCommand[],
  item: Extract<TerminalCommand, { kind: 'shell' }> & { canonical: object },
): boolean {
  if (item.target === 'all' || item.target === 'refs') return true;
  const projected = applyTerminalCommandBatch(current, priorClaimedItems, () => undefined);
  return countLeaves(projected) < MAX_PANES;
}

export function TerminalsPage() {
  const projectId = useAuthStore((s) => s.projectId);
  const currentProjectId = projectId ?? null;
  const setProjectId = useAuthStore((s) => s.setProjectId);
  const setRoute = useUIStore((s) => s.setRoute);

  const activeProject = useLiveQuery(
    () => (projectId ? projectRepo.getById(projectId) : Promise.resolve(undefined)),
    [projectId],
  );
  const projectName = activeProject?.name ?? null;

  /**
   * The tree is recreated when the active project changes. We keep the
   * dependent useState lazy-init so the *initial* mount uses whichever
   * project is active at render time, then a separate effect swaps
   * the tree on subsequent project changes.
   *
   * Order of preference for the initial value:
   *   1. The in-memory live cache (`terminalLiveCache`). Survives
   *      project switches AND TerminalsPage unmount/remount, and
   *      preserves `sessionId`s so we re-attach to existing PTYs
   *      instead of spawning new shells.
   *   2. localStorage shape (no session ids; safe across full app
   *      reloads where every PTY is dead anyway).
   *   3. A blank single-pane tree as the absolute fallback.
   */
  const [tree, setTree] = React.useState<PaneNode>(() => {
    const cached = getLiveTree(currentProjectId);
    if (cached) return cached;
    return loadTerminalTreeForProject(currentProjectId);
  });
  const [treeProjectId, setTreeProjectId] = React.useState<string | null>(() => currentProjectId);
  const treeReady = treeProjectId === currentProjectId;

  /**
   * Currently fullscreened pane id, or null when in normal grid view.
   * Owned at the page level so Esc-to-exit and "auto-clear when the
   * fullscreen pane is closed" stay in lock-step with the tree state.
   * Transient (not persisted) — reload always lands in normal view.
   */
  const [fullscreenPaneId, setFullscreenPaneId] = React.useState<string | null>(null);

  // Swap the tree when the user switches projects. Pane ids are
  // project-scoped now, so a stale `fullscreenPaneId` would point at
  // a leaf that no longer exists — clear it on every swap.
  //
  // We consult the in-memory live cache before falling back to
  // localStorage. The cache holds the live tree (with `sessionId`s),
  // so flipping A → B → A re-attaches to the same PTYs that were
  // running `opencode` / `claude` / etc. in project A. Without the
  // cache, the strip-on-localStorage logic would force a fresh spawn
  // and the user's running tools would appear to have been wiped.
  React.useLayoutEffect(() => {
    if (treeProjectId === currentProjectId) return;
    const cached = getLiveTree(currentProjectId);
    setTree(cached ?? loadTerminalTreeForProject(currentProjectId));
    setTreeProjectId(currentProjectId);
    setFullscreenPaneId(null);
  }, [currentProjectId, treeProjectId]);

  // Mirror every tree change into the in-memory live cache, keyed
  // by the active project. The cache is a write-through buffer:
  // every `setTree` produces an updated snapshot here, so when the
  // user switches away and back, the most recent tree (with live
  // session ids) is what gets restored. The localStorage write
  // below intentionally stays separate — it strips session ids and
  // serves the orthogonal "survive a full app reload" use case.
  React.useEffect(() => {
    if (!treeReady) return;
    captureLiveTree(treeProjectId, tree);
  }, [tree, treeProjectId, treeReady]);

  // Persist tree shape (not session ids) under the active project's key.
  // Debounced like transcript persistence so resize/rename bursts do not
  // synchronously hammer localStorage; flush on cleanup for durability.
  React.useEffect(() => {
    if (!treeReady) return;
    const handle = window.setTimeout(() => {
      saveTerminalTree(treeProjectId, tree);
    }, 350);
    return () => {
      window.clearTimeout(handle);
      saveTerminalTree(treeProjectId, tree);
    };
  }, [tree, treeProjectId, treeReady]);

  // Esc exits fullscreen. Hook only attaches while fullscreen is active so
  // it doesn't compete with other Esc handlers (popovers, dialogs, etc.).
  React.useEffect(() => {
    if (!fullscreenPaneId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreenPaneId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenPaneId]);

  // V3 — drain the action-runner's terminal command queue.
  //
  // The action layer (`lib/actions/registry.ts`) enqueues either a
  // shell command or a swarm-preset request. Swarm preset is gone with
  // the Projects revamp (the agent roster shrank to 2), so we treat
  // any `swarm` items as plain "append a leaf for jarvis" — keeps
  // older queued items behaving sensibly.
  React.useEffect(() => {
    let draining = false;
    let rerun = false;
    let projectedTree = tree;
    const drainAndProcess = async () => {
      if (draining) {
        rerun = true;
        return;
      }
      draining = true;
      try {
        do {
          rerun = false;
          const items = await claimTerminalCommands(async (item, priorClaimedItems) => {
            if (!canClaimCanonicalTerminalCommand(projectedTree, priorClaimedItems, item)) {
              return false;
            }
            return claimTerminalExecution(item.canonical.executionId);
          });
          if (items.length > 0) {
            projectedTree = applyTerminalCommandBatch(projectedTree, items);
            setTree(projectedTree);
          }
        } while (rerun);
      } finally {
        draining = false;
      }
    };

    void drainAndProcess();
    const unsub = useTerminalCommandQueue.subscribe((state) => {
      if (state.queue.length > 0) void drainAndProcess();
    });
    return unsub;
  }, [tree]);

  const handleChange = React.useCallback(
    (next: PaneTreeChange) => {
      setTree((currentTree) => {
        return resolvePaneTreeChange(currentTree, next, {
          command: defaultShell(),
          projectId: currentProjectId,
        });
      });
    },
    [currentProjectId],
  );

  React.useEffect(() => {
    if (!fullscreenPaneId) return;
    const stillExists = flattenLeaves(tree).some((l) => l.id === fullscreenPaneId);
    if (!stillExists) setFullscreenPaneId(null);
  }, [fullscreenPaneId, tree]);

  const handleAddPane = () => {
    setTree(appendLeaf(tree, { command: defaultShell() }));
  };

  const handleResetSizing = () => {
    window.dispatchEvent(new CustomEvent('jarvis:reset-terminal-sizes'));
    toast.success('Terminal layout reset', 'Sizing has been restored to default.');
  };

  const handleResetAllTerminals = () => {
    const forgetSession = useTerminalTranscriptStore.getState().forgetSession;
    const leaves = flattenLeaves(tree);
    const canonical = leaves.filter(
      (leaf) => leaf.executionId && hasCanonicalTerminalExecution(leaf.executionId),
    );
    if (canonical.length > 0) {
      void Promise.all(
        canonical.map(async (leaf) => ({
          leaf,
          result: await requestTerminalExecutionCancellation(leaf.executionId!),
        })),
      )
        .then((outcomes) => {
          const summary = summarizeTerminalResetCancellations(outcomes.map(({ result }) => result));
          const terminal = outcomes.filter(
            ({ result }) => terminalCancellationDisposition(result) === 'terminal',
          );
          if (terminal.length > 0) {
            const paneIds = new Set(terminal.map(({ leaf }) => leaf.id));
            for (const { leaf } of terminal) {
              if (leaf.sessionId) forgetSession(leaf.sessionId);
            }
            setTree((currentTree) => {
              if (paneIds.size >= flattenLeaves(currentTree).length) {
                return newLeaf({ command: defaultShell() });
              }
              let next = currentTree;
              for (const paneId of paneIds) {
                const closed = closePane(next, paneId);
                if (closed) next = closed;
              }
              return next;
            });
          }
          if (summary.pending > 0) {
            toast.info(
              'Cancellation requested',
              'Canonical terminals remain visible until native exit truth is verified.',
            );
          }
          if (summary.rejected > 0) {
            toast.error(
              'Cancellation unavailable',
              `${summary.rejected} canonical terminal${summary.rejected === 1 ? '' : 's'} could not commit cancellation intent and remain open.`,
            );
          }
        })
        .catch(() => {
          toast.error(
            'Cancellation unavailable',
            'Canonical cancellation results could not be verified; terminals remain open.',
          );
        });
      return;
    }
    for (const leaf of leaves) {
      if (leaf.sessionId) {
        invoke('terminal_kill', { sessionId: leaf.sessionId }).catch(() => {
          /* PTY may have already exited */
        });
      }
    }
    void deleteTerminalProjectSnapshots(currentProjectId).catch(() => {
      /* reset remains usable if native snapshot cleanup is unavailable */
    });
    forgetTerminalLeafSessions(tree, forgetSession);
    setTree(newLeaf({ command: defaultShell() }));
    setFullscreenPaneId(null);
    toast.success('Terminals reset', 'All terminals have been cleared.');
  };

  const [isHolding, setIsHolding] = React.useState(false);
  const holdTimerRef = React.useRef<any>(null);
  const hasTriggeredRef = React.useRef(false);

  const startHold = React.useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if ('button' in e && e.button !== 0) return;
      hasTriggeredRef.current = false;
      setIsHolding(true);
      holdTimerRef.current = setTimeout(() => {
        hasTriggeredRef.current = true;
        setIsHolding(false);
        const confirmed = window.confirm('Confirm to reset all terminals?');
        if (confirmed) {
          handleResetAllTerminals();
        }
      }, 2000);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [tree],
  );

  const endHold = React.useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setIsHolding(false);
    if (!hasTriggeredRef.current) {
      handleResetSizing();
    }
  }, []);

  const cancelHold = React.useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setIsHolding(false);
  }, []);

  React.useEffect(() => {
    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
      }
    };
  }, []);

  const handleFullscreenToggle = (paneId: string) => {
    setFullscreenPaneId((current) => (current === paneId ? null : paneId));
  };

  const handleMoveTerminal = React.useCallback(
    (
      ref: TerminalRef,
      targetProjectId: string | null,
      targetPaneId?: string | null,
      targetProjectName?: string | null,
    ) => {
      const currentProjectId = projectId ?? null;
      const sourceProjectId = (ref.projectId ?? currentProjectId) as string | null;
      const result = moveTerminalLeafToProject({
        ref,
        sourceProjectId,
        targetProjectId,
        targetProjectName,
        targetPaneId,
        currentTree: sourceProjectId === currentProjectId ? tree : undefined,
      });
      if (!result.ok) {
        toast.warning('Could not move terminal', result.reason ?? 'Try again.');
        return;
      }
      if (result.targetProjectId === currentProjectId && result.targetTree) {
        setTree(result.targetTree);
        setRoute('terminal');
        return;
      }
      if (result.sourceProjectId === currentProjectId && result.sourceTree) {
        setTree(result.sourceTree);
      }
      setProjectId(result.targetProjectId as never);
      setRoute('terminal');
    },
    [projectId, setProjectId, setRoute, tree],
  );

  const count = countLeaves(tree);
  const atCap = count >= MAX_PANES;

  return (
    <div
      data-monochrome-route="terminal"
      data-sakura-route="terminal"
      data-sakura-intensity="quiet"
      className="flex h-full w-full flex-col bg-background [html[data-theme=monochrome]_&]:font-sans"
    >
      <div
        data-monochrome-surface="terminal-toolbar"
        data-sakura-surface="terminal-toolbar"
        className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-border bg-paper-soft px-2 py-0.5 [html[data-theme=monochrome]_&]:bg-panel"
      >
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          <span className="font-display text-secondary tracking-tight text-foreground">
            Terminals
          </span>
          <span aria-hidden className="text-border-mid">
            ·
          </span>
          <span>
            {count} / {MAX_PANES} pane{count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddPane}
            disabled={atCap}
            className="h-6 gap-0.5 px-1.5 text-[11px] leading-none"
            title={atCap ? `Max ${MAX_PANES} panes` : 'Add a pane'}
          >
            <Plus className="h-3 w-3" /> Add pane
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onMouseDown={startHold}
            onMouseUp={endHold}
            onMouseLeave={cancelHold}
            onTouchStart={startHold}
            onTouchEnd={endHold}
            className="relative h-6 gap-0.5 overflow-hidden px-1.5 text-[11px] leading-none select-none active:bg-transparent hover:bg-panel-soft"
            title="Click to reset sizing, hold 2s to clear all panes"
          >
            <div
              className={cn(
                'absolute left-0 top-0 bottom-0 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-rose-500/20 transition-all pointer-events-none [html[data-theme=monochrome]_&]:bg-accent-copper/30 [html[data-theme=monochrome]_&]:bg-none',
                isHolding ? 'duration-[2000ms] ease-out w-full' : 'duration-75 w-0',
              )}
            />
            <span className="relative z-10 flex items-center gap-0.5">
              <RotateCcw className="h-3 w-3" /> Reset
            </span>
          </Button>
        </div>
      </div>

      <div
        data-monochrome-surface="terminal-grid"
        data-sakura-surface="terminal-grid"
        className="flex-1 min-h-0 p-2 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:p-1"
      >
        <TileGrid
          tree={tree}
          onChange={handleChange}
          defaultCommand={defaultShell()}
          defaultCommandForAgent={commandForAgent}
          fullscreenPaneId={fullscreenPaneId}
          projectId={treeProjectId}
          projectName={projectName}
          onFullscreenToggle={handleFullscreenToggle}
          onMoveTerminal={handleMoveTerminal}
        />
      </div>
    </div>
  );
}

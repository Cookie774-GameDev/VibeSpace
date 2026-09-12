import { invoke } from '@tauri-apps/api/core';
import {
  MAX_PANES,
  appendLeaf,
  flattenLeaves,
  updateLeaf,
  type PaneNode,
  type TerminalLeafRuntimeEvidence,
} from './paneTree';
import { planTerminalFleet } from './terminalFleet';
import { useTerminalFleetStore } from './terminalFleetStore';
import { getTerminalCliPreset } from './terminalCliPresets';
import {
  useTerminalCommandQueue,
  type TerminalCommand,
} from './terminalCommandQueue';
import { markTerminalExecution } from './terminalExecutionStore';
import { defaultShell } from './terminalProjectMove';
import { useTerminalTranscriptStore } from './transcriptStore';

type TerminalFleetRequest = Extract<TerminalCommand, { kind: 'fleet' }>;
type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface ProcessTerminalFleetRequestDependencies {
  getTree(): PaneNode;
  commitTree(tree: PaneNode): void;
  invokeCommand?: InvokeCommand;
  wait?: (delayMs: number) => Promise<void>;
}

function parseTerminalBackendSnapshot(value: unknown): { sessionId: string }[] | null {
  if (!Array.isArray(value)) return null;
  const sessions: { sessionId: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const sessionId = (item as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string' && sessionId) sessions.push({ sessionId });
  }
  return sessions;
}

function defaultFleetWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export function buildTerminalFleetRuntimeEvidence(
  leaves: readonly Extract<PaneNode, { kind: 'leaf' }>[],
  activeSessionIds: ReadonlySet<string>,
  backendSnapshotAvailable: boolean,
): Record<string, TerminalLeafRuntimeEvidence> {
  const transcripts = useTerminalTranscriptStore.getState().sessions;
  return Object.fromEntries(
    leaves.map((leaf) => {
      let backendState: TerminalLeafRuntimeEvidence['backendState'] = 'unknown';
      if (backendSnapshotAvailable && leaf.sessionId) {
        backendState = activeSessionIds.has(leaf.sessionId) ? 'active' : 'idle';
      } else if (backendSnapshotAvailable) {
        backendState = 'idle';
      }
      const transcript = leaf.sessionId ? transcripts[leaf.sessionId]?.text : undefined;
      return [leaf.id, { backendState, transcript }];
    }),
  );
}

/**
 * Execute one drained Fleet request against fresh state before every bounded
 * batch. Only planner-approved leaves change. Cancellation stops future
 * scheduling and never kills work that already started.
 */
export async function processTerminalFleetRequest(
  request: TerminalFleetRequest,
  dependencies: ProcessTerminalFleetRequestDependencies,
): Promise<void> {
  const invokeCommand = dependencies.invokeCommand ?? invoke;
  const wait = dependencies.wait ?? defaultFleetWait;
  const fleetStore = useTerminalFleetStore.getState();
  if (!fleetStore.records.some((record) => record.requestId === request.requestId)) {
    fleetStore.begin({
      requestId: request.requestId,
      targetTotal: request.targetTotal,
    });
  }

  let createdCount = 0;
  let reusedCount = 0;
  let launchedCount = 0;
  let currentBatch = 0;
  let nextExecutionIndex = 1;

  const cancelIfRequested = (): boolean => {
    if (!useTerminalCommandQueue.getState().isFleetCancelled(request.requestId)) {
      return false;
    }
    useTerminalFleetStore.getState().update(request.requestId, {
      status: 'cancelled',
      createdCount,
      reusedCount,
      launchedCount,
      currentBatch,
    });
    return true;
  };

  try {
    useTerminalFleetStore.getState().update(request.requestId, { status: 'planning' });
    if (cancelIfRequested()) return;

    const availableExecutables = new Set<string>();
    if (request.selection.kind === 'preset') {
      const preset = getTerminalCliPreset(request.selection.presetId);
      if (!preset) {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: 'failed',
          errors: ['The selected CLI preset is no longer recognized.'],
        });
        return;
      }
      let availability: { exists?: boolean };
      try {
        availability = (await invokeCommand('terminal_command_exists', {
          name: preset.executable,
        })) as { exists?: boolean };
      } catch {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: 'failed',
          errors: ['CLI availability could not be verified safely.'],
        });
        return;
      }
      if (availability?.exists !== true) {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: 'failed',
          errors: [`${preset.displayName} is not available on PATH.`],
        });
        return;
      }
      availableExecutables.add(preset.executable);
    }

    for (let guard = 0; guard <= MAX_PANES; guard += 1) {
      if (cancelIfRequested()) return;

      let backendSnapshot: { sessionId: string }[] | null;
      try {
        backendSnapshot = parseTerminalBackendSnapshot(await invokeCommand('terminal_list'));
      } catch {
        backendSnapshot = null;
      }
      if (!backendSnapshot) {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: launchedCount > 0 ? 'partial' : 'failed',
          createdCount,
          reusedCount,
          launchedCount,
          currentBatch,
          errors: [
            'Active terminal state could not be verified; remaining Fleet work was stopped.',
          ],
        });
        return;
      }

      const tree = dependencies.getTree();
      const leaves = flattenLeaves(tree);
      const runtimeByPaneId = buildTerminalFleetRuntimeEvidence(
        leaves,
        new Set(backendSnapshot.map((item) => item.sessionId)),
        true,
      );
      const planningLeaves = leaves.map((leaf) =>
        leaf.sessionId && runtimeByPaneId[leaf.id]?.backendState === 'idle'
          ? { ...leaf, sessionId: null }
          : leaf,
      );
      const plan = planTerminalFleet({
        targetTotal: request.targetTotal,
        leaves: planningLeaves,
        runtimeByPaneId,
        selection: request.selection,
        availableExecutables,
        maxPanes: MAX_PANES,
      });

      if (plan.kind === 'unavailable') {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: launchedCount > 0 ? 'partial' : 'failed',
          createdCount,
          reusedCount,
          launchedCount,
          currentBatch,
          errors: ['The selected CLI is no longer available on PATH.'],
        });
        return;
      }
      if (plan.kind === 'invalid') {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: launchedCount > 0 ? 'partial' : 'failed',
          createdCount,
          reusedCount,
          launchedCount,
          currentBatch,
          errors: [`Fleet request validation failed (${plan.reason}).`],
        });
        return;
      }
      if (plan.assignments.length === 0) {
        useTerminalFleetStore.getState().update(request.requestId, {
          status: plan.skippedCount > 0 ? 'partial' : 'complete',
          createdCount,
          reusedCount,
          launchedCount,
          skippedCount: plan.skippedCount,
          currentBatch,
        });
        return;
      }

      currentBatch += 1;
      const batch = plan.assignments.slice(0, request.batchSize);
      let nextTree = tree;
      for (const assignment of batch) {
        const executionId = `${request.requestId}:${nextExecutionIndex++}`;
        markTerminalExecution(executionId, 'queued');
        markTerminalExecution(executionId, 'starting');
        if (assignment.source === 'reuse') {
          nextTree = updateLeaf(nextTree, assignment.paneId, {
            sessionId: null,
            command: defaultShell(),
            startupCommand: assignment.command,
            executionId,
          });
          reusedCount += 1;
        } else {
          nextTree = appendLeaf(nextTree, {
            command: defaultShell(),
            startupCommand: assignment.command,
            executionId,
          });
          createdCount += 1;
        }
        launchedCount += 1;
      }
      dependencies.commitTree(nextTree);
      useTerminalFleetStore.getState().update(request.requestId, {
        status: 'launching',
        createdCount,
        reusedCount,
        launchedCount,
        currentBatch,
      });

      if (request.staggerDelayMs > 0) {
        await wait(request.staggerDelayMs);
      }
    }

    useTerminalFleetStore.getState().update(request.requestId, {
      status: 'partial',
      createdCount,
      reusedCount,
      launchedCount,
      currentBatch,
      errors: ['Fleet stopped at its bounded planning limit.'],
    });
  } finally {
    useTerminalCommandQueue.getState().completeFleet(request.requestId);
  }
}

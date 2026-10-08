import { devConsole } from '@/features/dev-console/store';
import { executeInstantCommandWithReceipt } from '@/features/instant-command/execute';
import {
  LocalCommandPreModelBridge,
  type LocalCommandExecutor,
} from '@/features/local-command-bridge/preModelBridge';
import type { LocalBridgeInput, LocalBridgeResult } from '@/features/local-command-bridge/types';

export interface VoiceLocalCommandOutcome {
  status: 'command_only' | 'model' | 'held' | 'revoked';
  result: LocalBridgeResult;
  completedCount: number;
  queuedCount: number;
}

/** Bind one Voice submission to the existing command authority and receipt ledger. */
export function createVoiceLocalCommandBoundary(
  input: LocalBridgeInput & { isCurrent(): boolean },
  dependencies: { execute?: LocalCommandExecutor } = {},
): () => Promise<VoiceLocalCommandOutcome> {
  const current = () => {
    try { return input.isCurrent(); } catch { return false; }
  };
  const execute = dependencies.execute ?? executeInstantCommandWithReceipt;
  const bridge = new LocalCommandPreModelBridge({
    execute: (command, context) => {
      if (!current()) throw new Error('voice_local_scope_revoked');
      // The existing authority owns confirmation, deadline and settlement.
      // Keep its real receipt even if Voice is revoked while it settles.
      return execute(command, context);
    },
  });
  const boundInput: LocalBridgeInput = {
    text: input.text,
    interactionId: input.interactionId,
    context: { ...input.context },
  };
  let pending: Promise<LocalBridgeResult> | undefined;
  return async () => {
    const result = await (pending ??= bridge.process(boundInput));
    const completedCount = result.receipts.filter((receipt) => receipt.status === 'completed').length;
    const queuedCount = result.receipts.filter((receipt) => receipt.status === 'queued').length;
    const status: VoiceLocalCommandOutcome['status'] = !current() ? 'revoked'
      : result.holdModel ? 'held'
        : result.commandOnly ? 'command_only' : 'model';
    // Existing bounded diagnostics retain partial settlement without user text,
    // target paths or a fabricated model run, including after panel closure.
    try { devConsole.log({
      channel: 'action', level: status === 'held' || status === 'revoked' ? 'warn' : 'info',
      message: 'Voice local command boundary settled',
      detail: {
        interactionId: boundInput.interactionId,
        scope: { accountId: boundInput.context.accountId, workspaceId: boundInput.context.workspaceId, projectId: boundInput.context.projectId },
        status, completedCount, queuedCount,
        receipts: result.receipts.map(({ commandId, status: receiptStatus }) => ({ commandId, status: receiptStatus })),
      },
    }); } catch { /* Diagnostics must not replace the action's real outcome. */ }
    return { status, result, completedCount, queuedCount };
  };
}

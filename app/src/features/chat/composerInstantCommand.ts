import { InstantCommandEntryBoundary } from '@/features/instant-command';
import type { InstantCommandReceipt } from '@/features/instant-command/receipt';
import { NAVIGATION_COMMAND_INPUTS } from '@/features/instant-command/catalog/navigation';
import { parseOpenCodeLaunch } from '@/features/instant-command/openCodeLaunch';
import { hasDetectedSecret } from '@/lib/security/secretDetector';

export const COMPOSER_INSTANT_SLASH_COMMANDS = Object.freeze([
  'connect',
  'settings',
  'palette',
  'launcher',
  'back',
] as const);

type ComposerInstantSlashCommand = (typeof COMPOSER_INSTANT_SLASH_COMMANDS)[number];

export type ComposerInstantCommandInput = Readonly<{
  source: string;
  interactionId: string;
  accountId: string;
  workspaceId: string;
  projectId: string;
}>;

export type ComposerInstantCommandResult =
  | Readonly<{ handled: false }>
  | Readonly<{
      handled: true;
      ok: boolean;
      message: string;
      commandId?: string;
      status?: InstantCommandReceipt['status'];
    }>;

const COMMANDS = new Set<string>(COMPOSER_INSTANT_SLASH_COMMANDS);
// Whole-message aliases only: explanations and negated instructions remain chat.
// Slash aliases retain their existing Composer meanings (notably /notes).
const LOCAL_NAVIGATION_ALIASES = new Set(
  NAVIGATION_COMMAND_INPUTS.flatMap((command) => command.aliases)
    .filter((alias) => !alias.startsWith('/'))
    .map((alias) => alias.toLowerCase()),
);
const sharedBoundary = new InstantCommandEntryBoundary();
const SAFE_FAILURE = 'Instant Command was rejected safely.';

function slashCommand(source: string): ComposerInstantSlashCommand | undefined {
  const match = /^\/([^\s/]+)(?:\s|$)/u.exec(source.trim());
  const command = match?.[1]?.toLowerCase();
  return command && COMMANDS.has(command) ? (command as ComposerInstantSlashCommand) : undefined;
}

/** Sensitive command drafts are not a credential-entry or durable storage surface. */
export function isSensitiveConnectDraft(source: string): boolean {
  if (slashCommand(source) !== 'connect') return false;
  // /connect accepts only a closed provider/connection ID. Retain its original
  // short credential-marker rejection without weakening the global detector's
  // thresholds for ordinary prose and unrelated drafts.
  return /\bsk-[A-Za-z0-9_-]+\b/iu.test(source) || hasDetectedSecret(source);
}

export function isComposerInstantCommandSource(source: string): boolean {
  return (
    slashCommand(source) !== undefined ||
    LOCAL_NAVIGATION_ALIASES.has(source.trim().toLowerCase()) ||
    parseOpenCodeLaunch(source) !== null
  );
}

function receiptMessage(receipt: InstantCommandReceipt): string {
  return receipt.followUp?.prompt ?? `Instant command ${receipt.status} (${receipt.commandId}).`;
}

export async function submitComposerInstantCommand(
  input: ComposerInstantCommandInput,
  boundary: InstantCommandEntryBoundary = sharedBoundary,
): Promise<ComposerInstantCommandResult> {
  if (!isComposerInstantCommandSource(input.source)) return Object.freeze({ handled: false });
  const outcome = await boundary.submit({
    interactionId: input.interactionId,
    trigger: 'typed',
    source: input.source,
    context: {
      correlationId: input.interactionId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
  });
  if (outcome.kind === 'rejected') {
    return Object.freeze({ handled: true, ok: false, message: outcome.reason });
  }
  if (outcome.kind !== 'command') {
    return Object.freeze({ handled: true, ok: false, message: SAFE_FAILURE });
  }
  const ok = outcome.receipt.status === 'completed' || outcome.receipt.status === 'queued';
  return Object.freeze({
    handled: true,
    ok,
    commandId: outcome.receipt.commandId,
    status: outcome.receipt.status,
    message: receiptMessage(outcome.receipt),
  });
}

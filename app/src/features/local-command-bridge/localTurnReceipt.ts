import type { Message, Part } from '@/types';

type ReceiptSummary = Readonly<{ commandId?: string; status?: string }>;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MAX_RECEIPTS = 512;

/** Stored on command-only user rows after the existing authority accepts them.
 * No user text, payload, correlation identity, or invented model run is stored.
 */
export function buildLocalTurnReceipt(receipts: readonly ReceiptSummary[]): Part[] {
  if (
    !receipts.length ||
    receipts.length > MAX_RECEIPTS ||
    receipts.some(
      (receipt) =>
        typeof receipt.commandId !== 'string' ||
        !SAFE_ID.test(receipt.commandId) ||
        (receipt.status !== 'completed' && receipt.status !== 'queued'),
    )
  )
    return [];
  return [
    {
      kind: 'local_command_receipt',
      version: 1,
      modelDispatch: 'skipped',
      receipts: receipts.map((receipt) => ({
        commandId: receipt.commandId!,
        status: receipt.status as 'completed' | 'queued',
      })),
    },
  ];
}

/** Interpret structured application receipts only, never command-looking prose. */
export function localTurnOutcome(message: Message): 'completed' | 'queued' | undefined {
  if (message.role !== 'user') return undefined;
  const parts = message.parts.filter((part) => part.kind === 'local_command_receipt');
  if (parts.length !== 1) return undefined;
  const part = parts[0]!;
  if (
    part.version !== 1 ||
    part.modelDispatch !== 'skipped' ||
    !Array.isArray(part.receipts) ||
    !part.receipts.length ||
    part.receipts.length > MAX_RECEIPTS ||
    part.receipts.some(
      (receipt) =>
        !receipt ||
        typeof receipt.commandId !== 'string' ||
        !SAFE_ID.test(receipt.commandId) ||
        !['completed', 'queued'].includes(receipt.status),
    )
  )
    return undefined;
  return part.receipts.some((receipt) => receipt.status === 'queued') ? 'queued' : 'completed';
}

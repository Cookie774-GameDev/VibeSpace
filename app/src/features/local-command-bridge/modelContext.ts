import type { LocalBridgeExecution } from './types';

const MAX_CONTEXT_LENGTH = 800;
const MAX_SLOT_LENGTH = 64;
const SAFE_COMMAND_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const SAFE_SLOT_KEY = /^(?:provider|route|color|direction|count|value)$/u;
const SAFE_SLOT_VALUE = /^[a-z0-9._:/+-]{1,64}$/iu;

function safeSlotValue(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > MAX_SLOT_LENGTH || !SAFE_SLOT_VALUE.test(normalized)) {
    return null;
  }
  return normalized;
}

function safeSlots(slots: Readonly<Record<string, unknown>>): string {
  return Object.keys(slots)
    .filter((key) => SAFE_SLOT_KEY.test(key))
    .sort()
    .flatMap((key) => {
      const value = safeSlotValue(slots[key]);
      return value ? [`${key}=${value}`] : [];
    })
    .join(' ');
}

/**
 * Build a bounded model-only note from canonical command metadata. Receipt
 * targets, correlation IDs, executor messages, and raw user text are omitted.
 */
export function buildLocalActionContext(
  executions: readonly LocalBridgeExecution[],
): string | undefined {
  const completed = executions.filter(
    ({ receipt }) => receipt.status === 'completed' || receipt.status === 'queued',
  );
  if (completed.length === 0) return undefined;

  const actions = completed.flatMap(({ detected, receipt }) => {
    const commandId = receipt.commandId.trim();
    if (!SAFE_COMMAND_ID.test(commandId)) return [];
    const slots = safeSlots(detected.slots);
    return [`${commandId}${slots ? ` ${slots}` : ''} status=${receipt.status}`];
  });
  if (actions.length === 0) return undefined;

  const prefix = 'VibeSpace local action receipts: ';
  const pending = completed.some(({ receipt }) => receipt.status === 'queued');
  const suffix =
    '. Do not repeat these local actions; continue the remaining request.' +
    (pending
      ? ' Queued actions are accepted, not proof of readiness; verify live targets before using them.'
      : '');
  let body = actions.join('; ');
  const available = Math.max(0, MAX_CONTEXT_LENGTH - prefix.length - suffix.length);
  if (body.length > available) body = body.slice(0, available).trimEnd();
  return `${prefix}${body}${suffix}`.slice(0, MAX_CONTEXT_LENGTH);
}

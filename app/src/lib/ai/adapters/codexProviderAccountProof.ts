import { appActivityLog } from '@/lib/diagnostics/appActivityLog';

type Metadata = Readonly<Record<string, string | number | boolean | null | undefined>>;
type Recorder = (kind: string, phase: string, data: Metadata) => unknown;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const keys = ['requestId', 'runId', 'chatId', 'generation', 'connectionId', 'modelId', 'accountScopeHash'] as const;

/** Evidence only: same correlated live-parent control reader; never an authorization token. */
export async function recordCodexProviderAccountProof(
  binding: Metadata,
  sessionId: string,
  accountRequestId: string,
  read: () => Promise<unknown>,
  isCurrent: () => boolean,
  record: Recorder = appActivityLog.recordMetadata,
  readAccountEpoch: () => number = () => 1,
): Promise<void> {
  try {
    if (!isCurrent() || binding.protectedAttemptBound !== true || binding.connectionId !== 'openai-codex' ||
      keys.some(key => typeof binding[key] !== 'string' || !binding[key]) ||
      !/^[a-f0-9]{64}$/.test(String(binding.accountScopeHash)) || !sessionId || !accountRequestId) return;
    const accountEpoch = readAccountEpoch();
    if (!Number.isSafeInteger(accountEpoch) || accountEpoch < 1) return;
    const frame = object(await read());
    if (!isCurrent() || readAccountEpoch() !== accountEpoch || !frame || frame.id !== accountRequestId || frame.error !== undefined) return;
    const result = object(frame.result);
    const account = object(result?.account);
    const email = account?.email;
    if (result?.requiresOpenaiAuth !== true || account?.type !== 'chatgpt' ||
      typeof email !== 'string' || !email.trim() || email.length > 1024) return;
    // Exact existing native codex_rlm_native::account_hash domain/byte spelling.
    // Private unique identity is transient and never retained in diagnostics.
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('S61-codex-account-v1\0' + email));
    const authenticatedAccountHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!isCurrent() || readAccountEpoch() !== accountEpoch) return;
    record('model.account-proof.codex', 'rpc-accepted', {
      ...Object.fromEntries(keys.map(key => [key, binding[key]])),
      harness: 'codex', providerId: 'openai', authType: 'chatgpt',
      observation: 'ACTUAL_PROVIDER_ACCOUNT_RPC', method: 'account/read', refreshToken: false,
      accountRPCRequestId: accountRequestId, sessionId, protectedAttemptBound: true,
      authenticatedAccountHash, accountEpoch, observedAtMs: Date.now(),
      effort: binding.effort, fastVariant: binding.fastVariant,
    });
  } catch { /* No raw RPC/private error output, alternate account, retries or model-turn failure. */ }
}
/** Observe notifications on the existing native frame pump; never inspect private params. */
export function recordCodexProviderAccountInvalidation(generation: string, accountEpoch: number, frame: unknown, record: Recorder = appActivityLog.recordMetadata): boolean {
  const method = object(frame)?.method;
  if (method !== 'account/updated' && method !== 'account/login/completed') return false;
  if (generation && Number.isSafeInteger(accountEpoch) && accountEpoch > 0)
    record('model.account-proof.codex', 'invalidated', { generation, accountEpoch, method, observedAtMs: Date.now() });
  return true;
}
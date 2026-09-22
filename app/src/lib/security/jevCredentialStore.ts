import { isTauri } from '@/lib/utils';
import type { JevJsonValue, JevQuestions } from '@/lib/jev/types';

/** Jev is a decision capability, not a normal chat ProviderId. */
export const JEV_CREDENTIAL_ID = 'jev' as const;
const MAX_CREDENTIAL_BYTES = 32 * 1024;

export type JevCredentialErrorCode =
  | 'native_unavailable'
  | 'key_required'
  | 'credential_too_large'
  | 'credential_verification_failed'
  | 'storage_unavailable';

export type JevCredentialMutationResult =
  | { ok: true }
  | { ok: false; code: JevCredentialErrorCode };

export interface JevCredentialStatus {
  available: boolean;
  configured: boolean;
  error?: 'storage_unavailable';
}

export type JevHttpKind =
  | 'connected'
  | 'ok'
  | 'missing_key'
  | 'invalid_key'
  | 'forbidden'
  | 'network'
  | 'provider_error'
  | 'malformed'
  | 'response_too_large'
  | 'request_too_large'
  | 'invalid_request'
  | 'storage_error';

export interface JevModelOption {
  id: string;
  label?: string;
}

export interface JevHttpOutcome {
  kind: JevHttpKind;
  status: number | null;
  models?: readonly JevModelOption[];
  body?: unknown;
}

/**
 * The client owns the typed request shape. This bridge accepts that object but
 * never accepts a URL, method, headers, or credential argument.
 */
export interface JevSystemOneRequest {
  state: JevJsonValue;
  model: string;
  questions: JevQuestions;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
}

function unavailableStatus(): JevCredentialStatus {
  return { available: false, configured: false };
}

function mutationFailure(error: unknown): JevCredentialMutationResult {
  const code = String(error).trim();
  if (code === 'key_required') return { ok: false, code: 'key_required' };
  if (code === 'credential_too_large') return { ok: false, code: 'credential_too_large' };
  if (code === 'credential_verification_failed') {
    return { ok: false, code: 'credential_verification_failed' };
  }
  if (code === 'native_unavailable') return { ok: false, code: 'native_unavailable' };
  return { ok: false, code: 'storage_unavailable' };
}

/** Save and verify inside native Rust; the key is never returned to the renderer. */
export async function saveJevCredential(key: string): Promise<JevCredentialMutationResult> {
  if (!isTauri) return { ok: false, code: 'native_unavailable' };
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, code: 'key_required' };
  if (trimmed.length > MAX_CREDENTIAL_BYTES) {
    return { ok: false, code: 'credential_too_large' };
  }
  try {
    await invoke<void>('jev_credential_set', { key: trimmed });
    return { ok: true };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function getJevCredentialStatus(): Promise<JevCredentialStatus> {
  if (!isTauri) return unavailableStatus();
  try {
    const status = await invoke<{ configured?: unknown }>('jev_credential_status');
    if (!status || typeof status !== 'object' || typeof status.configured !== 'boolean') {
      return { available: true, configured: false, error: 'storage_unavailable' };
    }
    return { available: true, configured: status?.configured === true };
  } catch {
    return { available: true, configured: false, error: 'storage_unavailable' };
  }
}

export async function removeJevCredential(): Promise<JevCredentialMutationResult> {
  if (!isTauri) return { ok: false, code: 'native_unavailable' };
  try {
    await invoke<void>('jev_credential_delete');
    return { ok: true };
  } catch {
    return { ok: false, code: 'storage_unavailable' };
  }
}

/** Fixed native GET /v1/models. It returns only public model metadata/status. */
export async function requestJevModels(): Promise<JevHttpOutcome> {
  if (!isTauri) return { kind: 'network', status: null };
  try {
    return await invoke<JevHttpOutcome>('jev_http_models');
  } catch {
    return { kind: 'network', status: null };
  }
}

/** Fixed native POST /v1/systemone. No URL, method, headers, or key is accepted. */
export async function requestJevSystemOne(
  request: JevSystemOneRequest,
): Promise<JevHttpOutcome> {
  if (!isTauri) return { kind: 'network', status: null };
  try {
    return await invoke<JevHttpOutcome>('jev_http_systemone', { request });
  } catch {
    return { kind: 'network', status: null };
  }
}

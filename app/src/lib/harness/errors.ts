import type { HarnessErrorPayload } from './types';

const MAX_MESSAGE_LENGTH = 2_048;
const MAX_REPAIR_LENGTH = 512;
const MAX_DIAGNOSTIC_LENGTH = 2_048;

export class HarnessError extends Error {
  readonly code: HarnessErrorPayload['code'];
  readonly repair: string;
  readonly recoverable: boolean;
  readonly diagnostic?: string;

  constructor(input: HarnessErrorPayload) {
    super(input.message);
    this.name = 'HarnessError';
    this.code = input.code;
    this.repair = input.repair;
    this.recoverable = input.recoverable;
    if (input.diagnostic !== undefined) this.diagnostic = input.diagnostic;
  }
}

export const OPENCODE_PROVIDER_AUTH_FAILED_MESSAGE =
  'OpenAI ChatGPT sign-in expired. Reconnect OpenAI with ChatGPT in the OpenCode terminal (/connect), or pick a local model. The connector can still show Connected while the saved refresh token is dead.';

export const OPENCODE_PROVIDER_AUTH_FAILED_REPAIR =
  'Run /connect in OpenCode and sign in with ChatGPT, or switch VibeSpace Chat to a local model.';

export function classifyOpenCodeAuthFailure(message: string): HarnessErrorPayload | undefined {
  const text = message.trim();
  if (!text) return undefined;
  const refresh = /token refresh failed|oauth token refresh failed|failed to refresh token/i.test(
    text,
  );
  const unauthorizedRefresh =
    /\b401\b/.test(text) && /refresh|oauth|unauthorized/i.test(text);
  if (!refresh && !unauthorizedRefresh) return undefined;
  return {
    code: 'HARNESS_AUTH_FAILED',
    message: OPENCODE_PROVIDER_AUTH_FAILED_MESSAGE,
    repair: OPENCODE_PROVIDER_AUTH_FAILED_REPAIR,
    recoverable: true,
  };
}

export function redactHarnessText(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api_key|token)\s*=\s*[^\s]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

export function toHarnessErrorPayload(error: unknown): HarnessErrorPayload {
  const source =
    error instanceof HarnessError
      ? error
      : new HarnessError({
          code: 'HARNESS_START_FAILED',
          message: error instanceof Error ? error.message : 'Harness operation failed.',
          repair: 'Retry the harness operation.',
          recoverable: true,
        });

  return {
    code: source.code,
    message: redactHarnessText(source.message).slice(0, MAX_MESSAGE_LENGTH),
    repair: redactHarnessText(source.repair).slice(0, MAX_REPAIR_LENGTH),
    ...(source.diagnostic
      ? {
          diagnostic: redactHarnessText(source.diagnostic).slice(0, MAX_DIAGNOSTIC_LENGTH),
        }
      : {}),
    recoverable: source.recoverable,
  };
}

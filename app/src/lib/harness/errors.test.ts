import { describe, expect, it } from 'vitest';
import {
  classifyOpenCodeAuthFailure,
  HarnessError,
  OPENCODE_PROVIDER_AUTH_FAILED_MESSAGE,
  redactHarnessText,
  toHarnessErrorPayload,
} from './errors';

describe('harness errors', () => {
  it('redacts secrets and bounds diagnostics in serialized harness failures', () => {
    const error = new HarnessError({
      code: 'HARNESS_AUTH_FAILED',
      message: 'Bearer secret-token',
      repair: 'Reconnect provider',
      diagnostic: `https://user:password@localhost ${'x'.repeat(5_000)}`,
      recoverable: true,
    });

    const payload = toHarnessErrorPayload(error);

    expect(payload).toMatchObject({
      code: 'HARNESS_AUTH_FAILED',
      message: 'Bearer [REDACTED]',
      repair: 'Reconnect provider',
      recoverable: true,
    });
    expect(payload.diagnostic).not.toContain('user');
    expect(payload.diagnostic).not.toContain('password');
    expect(payload.diagnostic?.length).toBeLessThanOrEqual(2_048);
  });

  it('maps unknown failures to a bounded safe harness failure', () => {
    expect(toHarnessErrorPayload(new Error('api_key=abc123'))).toEqual({
      code: 'HARNESS_START_FAILED',
      message: 'api_key=[REDACTED]',
      repair: 'Retry the harness operation.',
      recoverable: true,
    });
  });

  it('classifies OpenCode token-refresh 401 as a recoverable provider auth failure', () => {
    expect(classifyOpenCodeAuthFailure('Token refresh failed: 401')).toMatchObject({
      code: 'HARNESS_AUTH_FAILED',
      message: OPENCODE_PROVIDER_AUTH_FAILED_MESSAGE,
      recoverable: true,
    });
    expect(classifyOpenCodeAuthFailure('OAuth token refresh failed for openai-codex')).toMatchObject({
      code: 'HARNESS_AUTH_FAILED',
    });
    expect(classifyOpenCodeAuthFailure('OpenCode ended without a terminal completion event.')).toBeUndefined();
  });

  it('redacts basic authorization and common provider secret assignments', () => {
    expect(
      redactHarnessText(
        'Authorization: Basic dXNlcjpwYXNz OPENAI_API_KEY=sk-test token=token-value',
      ),
    ).toBe('Authorization: Basic [REDACTED] OPENAI_API_KEY=[REDACTED] token=[REDACTED]');
  });
});

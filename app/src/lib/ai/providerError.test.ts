import { describe, expect, it } from 'vitest';
import {
  isProviderRuntimeError,
  providerErrorDetails,
  providerErrorFromEvent,
  ProviderRuntimeError,
} from './providerError';

describe('provider error boundary', () => {
  it('bounds and redacts structured provider metadata', () => {
    const error = providerErrorFromEvent({
      code: 'quota_exhausted',
      message: 'Provider rejected the request; api_key=secret-value',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash-vision-exp',
      retryable: false,
      retryAfterMs: 30_000,
      resetAt: 1_800_000_000_000,
      requestId: 'request-1',
      runId: 'run-1',
    });

    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect(error.message).toBe('Provider rejected the request; api_key=[REDACTED]');
    expect(error.details).toEqual({
      message: 'Provider rejected the request; api_key=[REDACTED]',
      code: 'quota_exhausted',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash-vision-exp',
      retryable: false,
      retryAfterMs: 30_000,
      resetAt: 1_800_000_000_000,
      requestId: 'request-1',
      runId: 'run-1',
    });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('recovers provider detail through the protected attempt wrapper', () => {
    const cause = providerErrorFromEvent({
      code: 'rate_limited',
      message: 'Provider is busy.',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash-vision-exp',
      retryable: true,
      retryAfterMs: 1_500,
    });
    const wrapped = new Error('The provider attempt ended before canonical completion.');
    (wrapped as Error & { cause?: unknown }).cause = cause;

    expect(isProviderRuntimeError(wrapped)).toBe(true);
    expect(providerErrorDetails(wrapped, {
      requestId: 'request-2',
      runId: 'run-2',
    })).toEqual({
      message: 'Provider is busy.',
      code: 'rate_limited',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4-flash-vision-exp',
      retryable: true,
      retryAfterMs: 1_500,
      requestId: 'request-2',
      runId: 'run-2',
    });
  });

  it('keeps unknown provider failures specific while applying verified identity fallback', () => {
    const details = providerErrorDetails(new ProviderRuntimeError({
      message: 'A new provider code was returned.',
    }), {
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      connectionId: 'openai-codex',
      requestId: 'request-3',
    });

    expect(details).toEqual({
      message: 'A new provider code was returned.',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      connectionId: 'openai-codex',
      requestId: 'request-3',
    });
  });

  it('keeps the verified route when an event carries a stale provider alias', () => {
    const error = providerErrorFromEvent(
      {
        message: 'The upstream request was rejected.',
        code: 'upstream_rejected',
        providerId: 'stale-provider',
        modelId: 'stale-model',
        connectionId: 'stale-connection',
        requestId: 'stale-request',
        runId: 'stale-run',
      },
      {
        providerId: 'opencode',
        modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        connectionId: 'opencode-cloud',
        requestId: 'request-verified',
        runId: 'run-verified',
      },
    );

    expect(error.details).toMatchObject({
      providerId: 'opencode',
      modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
      connectionId: 'opencode-cloud',
      requestId: 'request-verified',
      runId: 'run-verified',
    });
  });

  it('keeps verified route identity through a generic wrapper cause chain', () => {
    const cause = new Error('provider alias from transport');
    Object.assign(cause, {
      provider: 'wrong-provider',
      model: 'wrong-model',
      connection: 'wrong-connection',
      request_id: 'wrong-request',
      run_id: 'wrong-run',
      code: 'transport_failed',
    });
    const wrapped = new Error('attempt wrapper');
    (wrapped as Error & { cause?: unknown }).cause = cause;

    expect(providerErrorDetails(wrapped, {
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      connectionId: 'openai-codex',
      requestId: 'request-verified',
      runId: 'run-verified',
    })).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      connectionId: 'openai-codex',
      requestId: 'request-verified',
      runId: 'run-verified',
      code: 'transport_failed',
    });
  });

  it('removes unsafe control characters while retaining readable line breaks', () => {
    const details = providerErrorDetails({
      message: 'first\u0000line\nsecond\u001b[31m',
      retryable: 'yes',
    } as unknown);

    expect(details.message).toBe('first line\nsecond [31m');
    expect(details.retryable).toBeUndefined();
  });
});

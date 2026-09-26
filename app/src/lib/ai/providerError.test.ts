import { describe, expect, it } from 'vitest';
import {
  isProviderRuntimeError,
  isProviderRateLimitError,
  isProviderUsageLimitError,
  presentProviderError,
  providerErrorDetails,
  richestProviderErrorDetails,
  providerErrorFromEvent,
  ProviderRuntimeError,
} from './providerError';
import { JarvisProviderAttemptFailureError } from './providerAttemptEvidence';

describe('provider error boundary', () => {
  it.each([
    { name: 'native string rejection', wrap: (message: string): unknown => message },
    { name: 'string cause', wrap: (message: string): unknown => new Error('Attempt wrapper', { cause: message }) },
    { name: 'plain details envelope', wrap: (message: string): unknown => ({ message, details: { code: 'upstream_rejected' } }) },
    { name: 'protected attempt string cause', wrap: (message: string): unknown => new JarvisProviderAttemptFailureError({
      kind: 'response_started_transport_failure', accountId: 'account-fixture', runId: 'run-fixture',
      requestId: 'request-fixture', attemptNumber: 1, responseStarted: true, chunkCount: 1,
      actionDispatchCount: 0, failureCategory: 'provider_transport_failure', failedAt: 100,
    }, message) },
  ])('preserves safe provider text from $name', ({ wrap }) => {
    const route = {
      providerId: 'opencode', modelId: 'openai/gpt-5.6-luna', connectionId: 'opencode-cli',
      requestId: 'request-verified', runId: 'run-verified',
    };
    const details = providerErrorDetails(wrap('You have reached the weekly usage limit.\napi_key=fixture-private-value'), route);
    expect(details).toMatchObject({ ...route, message: 'You have reached the weekly usage limit.\napi_key=[REDACTED]' });
    expect(presentProviderError(details).title).toBe('Usage limit reached');
    expect(JSON.stringify(details)).not.toContain('fixture-private-value');
    expect(providerErrorDetails(wrap('x'.repeat(5_000)), route).message).toHaveLength(2_048);
    expect(Object.isFrozen(details)).toBe(true);
  });

  it('preserves a specific string failure instead of a later generic session status', () => {
    expect(richestProviderErrorDetails([
      'Specific native rejection.', { message: 'OpenCode session failed.' },
    ]).message).toBe('Specific native rejection.');
  });

  it('keeps nested details text preferred and blank string causes on the safe fallback', () => {
    expect(providerErrorDetails({ message: 'outer', details: { message: 'inner', code: 'upstream' } }))
      .toMatchObject({ message: 'inner', code: 'upstream' });
    expect(providerErrorDetails('   ', { message: 'Verified fallback.' }).message).toBe('Verified fallback.');
  });
  it.each([
    { code: '429', message: 'Too Many Requests.' },
    { code: 'rate_limit_exceeded', message: 'The provider rejected the request.' },
  ])('recognizes a temporary provider rate limit: %j', (details) => {
    expect(isProviderRateLimitError(details)).toBe(true);
    expect(isProviderUsageLimitError(details)).toBe(false);
    expect(presentProviderError({ ...details })).toEqual({
      title: 'Too many requests',
      message:
        'The provider is temporarily rate limited. Wait a moment and try again, or switch to another available model or credential.',
      usageLimit: false,
    });
  });

  it.each([
    { code: 'quota_exhausted', message: 'The provider quota is exhausted.' },
    { code: 'usage_limit', message: 'You have reached the weekly usage limit.' },
    { code: 'usage_limit_exceeded', message: 'The provider rejected this request.' },
  ])('recognizes exhausted provider usage: %j', (details) => {
    expect(isProviderRateLimitError(details)).toBe(true);
    expect(isProviderUsageLimitError(details)).toBe(true);
    expect(presentProviderError({ ...details })).toEqual({
      title: 'Usage limit reached',
      message:
        "The provider's current usage limit was reached for this request. Review the route and connection below, then retry after the limit resets or switch to another available model or credential.",
      usageLimit: true,
    });
  });

  it('keeps non-limit provider wording intact', () => {
    expect(isProviderRateLimitError({ code: 'auth_failed', message: 'Reconnect the provider.' })).toBe(false);
    expect(presentProviderError({ code: 'auth_failed', message: 'Reconnect the provider.' })).toEqual({
      title: 'Provider error',
      message: 'Reconnect the provider.',
      usageLimit: false,
    });
  });

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

  it('keeps an unknown provider code specific while applying verified identity fallback', () => {
    const details = providerErrorDetails(new ProviderRuntimeError({
      message: 'A new provider code was returned.',
      code: 'provider_code_added_after_catalog_sync',
    }), {
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      connectionId: 'openai-codex',
      requestId: 'request-3',
    });

    expect(details).toEqual({
      message: 'A new provider code was returned.',
      code: 'provider_code_added_after_catalog_sync',
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

  it('preserves a specific native transport reason through the protected attempt error', () => {
    const classification = {
      kind: 'response_started_transport_failure' as const,
      accountId: 'account-1',
      runId: 'run-1',
      requestId: 'request-1',
      attemptNumber: 1,
      responseStarted: true as const,
      chunkCount: 1,
      actionDispatchCount: 0,
      failureCategory: 'provider_transport_failure',
      failedAt: 100,
    };
    const wrapped = new JarvisProviderAttemptFailureError(
      classification,
      new Error('OpenCode event stream failed.'),
    );

    expect(providerErrorDetails(wrapped, {
      providerId: 'opencode',
      modelId: 'openai/gpt-5.6-luna',
      connectionId: 'opencode-cli',
      requestId: 'request-1',
      runId: 'run-1',
    })).toMatchObject({
      message: 'OpenCode event stream failed.',
      providerId: 'opencode',
      modelId: 'openai/gpt-5.6-luna',
      connectionId: 'opencode-cli',
      requestId: 'request-1',
      runId: 'run-1',
    });
  });

  it('keeps the richest safe provider failure when a later session error is generic', () => {
    const details = richestProviderErrorDetails(
      [
        {
          message: 'You have reached the weekly usage limit; api_key=private-value',
          code: 'quota_exhausted',
          retryable: false,
          resetAt: 1_900_000_000_000,
        },
        { message: 'OpenCode session failed.' },
      ],
      {
        providerId: 'opencode',
        modelId: 'openai/gpt-5.6-luna',
        connectionId: 'opencode-cli',
        requestId: 'request-rich',
        runId: 'run-rich',
      },
    );

    expect(details).toEqual({
      message: 'You have reached the weekly usage limit; api_key=[REDACTED]',
      code: 'quota_exhausted',
      providerId: 'opencode',
      modelId: 'openai/gpt-5.6-luna',
      connectionId: 'opencode-cli',
      retryable: false,
      resetAt: 1_900_000_000_000,
      requestId: 'request-rich',
      runId: 'run-rich',
    });
  });

  it('shows a brand-new safe provider message without requiring phrase classification', () => {
    expect(
      richestProviderErrorDetails(
        [{ message: 'Brand new upstream capacity condition XYZ-2026.', code: 'xyz_2026' }],
        { providerId: 'new-provider', modelId: 'future-model' },
      ),
    ).toMatchObject({
      message: 'Brand new upstream capacity condition XYZ-2026.',
      code: 'xyz_2026',
      providerId: 'new-provider',
      modelId: 'future-model',
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

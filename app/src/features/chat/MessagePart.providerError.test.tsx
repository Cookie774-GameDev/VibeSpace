import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessagePart } from './MessagePart';

describe('MessagePart provider errors', () => {
  it('renders safe provider details that can be reopened from the transcript', () => {
    render(
      <MessagePart
        allParts={[]}
        part={{
          kind: 'provider_error',
          error: {
            message: 'Provider rejected the request.',
            code: 'provider_rejected',
            providerId: 'opencode-go',
            modelId: 'deepseek-v4-flash-vision-exp',
            retryable: false,
            retryAfterMs: 2_000,
            resetAt: 1_700_000_000_000,
            requestId: 'request-1',
            runId: 'run-1',
          },
        }}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('provider-error')).toBeTruthy();
    expect(screen.getByTestId('provider-error').getAttribute('data-provider-error-layout')).toBe('wide');
    expect(screen.getByText('Provider rejected the request.')).toBeTruthy();
    expect(screen.getByText('provider_rejected')).toBeTruthy();
    expect(screen.getByText('opencode-go/deepseek-v4-flash-vision-exp')).toBeTruthy();
    expect(screen.getByText('Retry is not available')).toBeTruthy();
    expect(screen.getByText('Retry after 2s')).toBeTruthy();
    expect(screen.getByText('Reset at:')).toBeTruthy();
    expect(screen.getByText('1700000000000')).toBeTruthy();
    expect(screen.getByText('request-1')).toBeTruthy();
    expect(screen.getByText('run-1')).toBeTruthy();
  });

  it('renders temporary rate limits as retry guidance while retaining diagnostics', () => {
    render(
      <MessagePart
        allParts={[]}
        part={{
          kind: 'provider_error',
          error: {
            message: 'HTTP 429 Too Many Requests.',
            code: '429',
            providerId: 'opencode-go',
            modelId: 'deepseek-v4-flash-vision-exp',
            connectionId: 'opencode-cli',
            retryable: true,
            retryAfterMs: 60_000,
            requestId: 'request-limit',
            runId: 'run-limit',
          },
        }}
      />,
    );

    expect(screen.getByText('Too many requests')).toBeTruthy();
    expect(screen.getByText(/temporarily rate limited/i)).toBeTruthy();
    expect(screen.getByText('opencode-go/deepseek-v4-flash-vision-exp')).toBeTruthy();
    expect(screen.getByText('opencode-cli')).toBeTruthy();
    expect(screen.getByText('request-limit')).toBeTruthy();
    expect(screen.getByText('run-limit')).toBeTruthy();
    expect(screen.getByTestId('provider-error').querySelector('[data-provider-error-diagnostics="true"]')).toBeTruthy();
  });
});

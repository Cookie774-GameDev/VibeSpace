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
            code: 'quota_exhausted',
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
    expect(screen.getByText('Provider rejected the request.')).toBeTruthy();
    expect(screen.getByText('quota_exhausted')).toBeTruthy();
    expect(screen.getByText('opencode-go/deepseek-v4-flash-vision-exp')).toBeTruthy();
    expect(screen.getByText('Retry is not available')).toBeTruthy();
    expect(screen.getByText('Retry after 2s')).toBeTruthy();
    expect(screen.getByText('Reset at:')).toBeTruthy();
    expect(screen.getByText('1700000000000')).toBeTruthy();
    expect(screen.getByText('request-1')).toBeTruthy();
    expect(screen.getByText('run-1')).toBeTruthy();
  });
});

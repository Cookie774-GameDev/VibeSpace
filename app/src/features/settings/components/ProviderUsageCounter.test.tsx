import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderUsageCounter } from './ProviderUsageCounter';

describe('ProviderUsageCounter', () => {
  it('uses the approved empty-state copy without implying all provider usage is local', () => {
    render(<ProviderUsageCounter providerId="openai" usage={null} />);
    expect(screen.getByText('No usage recorded this month.')).toBeTruthy();
    expect(screen.queryByText(/local usage/i)).toBeNull();
  });

  it('distinguishes loading, errors, and VibeSpace-known usage', () => {
    const { rerender } = render(
      <ProviderUsageCounter providerId="openai" usage={null} status="loading" />,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading usage');

    rerender(
      <ProviderUsageCounter
        providerId="openai"
        usage={null}
        status="error"
        error="IndexedDB unavailable"
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Usage unavailable');

    rerender(
      <ProviderUsageCounter
        providerId="openai"
        usage={{
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          totalTokens: 15,
          costUsd: 0.01,
          lastUsed: Date.now(),
        }}
      />,
    );
    expect(screen.getByText('Requests made through VibeSpace')).toBeTruthy();
  });
});

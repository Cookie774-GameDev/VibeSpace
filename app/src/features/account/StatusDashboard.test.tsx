import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));
vi.mock('./statusAnalytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./statusAnalytics')>()),
  loadStatusSummary: analytics.load,
  clearActiveAccountStatus: analytics.clear,
}));

import { StatusDashboard } from './StatusDashboard';

const summary = {
  period: '7d' as const,
  activeTimeMs: 7_200_000,
  inputTokens: 100,
  outputTokens: 50,
  reasoningTokens: 0,
  cachedTokens: 0,
  totalTokens: 150,
  tokensSaved: 20,
  costUsd: 0.02,
  actualCostUsd: 0.02,
  estimatedCostUsd: 0,
  requests: 2,
  completed: 2,
  failed: 0,
  cancelled: 0,
  linesAdded: 7,
  linesRemoved: 2,
  aiGeneratedLines: 12,
  charactersTyped: 42,
  messagesWritten: 1,
  averageLatencyMs: 800,
  surfaces: [
    {
      id: 'chat',
      label: 'Chat',
      durationMs: 7_200_000,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requests: 0,
      completed: 0,
      failed: 0,
      count: 1,
      percent: 100,
    },
  ],
  providers: [],
  models: [],
  projects: [],
  agents: [],
  timeline: [{ timestamp: 1_800_000_000_000, activeMs: 7_200_000, tokens: 150 }],
  insights: ['Most active surface: Chat.'],
};

describe('StatusDashboard', () => {
  beforeEach(() => {
    analytics.load.mockReset().mockResolvedValue(summary);
    analytics.clear.mockReset().mockResolvedValue(undefined);
  });

  it('renders truthful local metrics and requires confirmation before clearing', async () => {
    render(<StatusDashboard accountId="account-a" />);
    expect(await screen.findByText('Your VibeSpace status')).toBeTruthy();
    expect(await screen.findByText('Provider-reported actual')).toBeTruthy();
    expect(screen.getByText('12 AI-generated lines')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /clear local history/i }));
    expect(analytics.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^clear status history$/i }));
    await waitFor(() => expect(analytics.clear).toHaveBeenCalledTimes(1));
  });

  it('switches periods and exposes exact activity details to keyboard and screen readers', async () => {
    render(<StatusDashboard accountId="account-a" />);
    const bar = await screen.findByRole('img', { name: /2h, 150 tokens/ });
    expect(bar.getAttribute('tabindex')).toBe('0');
    expect(bar.style.height).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: '24H' }));
    await waitFor(() => expect(analytics.load).toHaveBeenLastCalledWith('account-a', '24h'));
    expect(screen.getByRole('button', { name: '24H' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not turn token-only activity into fabricated active time', async () => {
    analytics.load.mockResolvedValue({
      ...summary,
      timeline: [{ timestamp: 1_800_000_000_000, activeMs: 0, tokens: 150 }],
    });
    render(<StatusDashboard accountId="account-a" />);
    const bar = await screen.findByRole('img', { name: /0m, 150 tokens/ });
    expect(bar.style.height).toBe('0%');
    expect(bar.getAttribute('data-empty')).toBe('true');
  });
});

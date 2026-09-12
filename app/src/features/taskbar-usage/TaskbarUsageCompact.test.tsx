import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskbarUsageCompact } from './TaskbarUsageCompact';
import type { ProviderUsageSnapshot } from './providerUsageTypes';

function provider(id: string, usagePercent: number | null): ProviderUsageSnapshot {
  return {
    providerId: id,
    displayName: id,
    connected: true,
    hidden: false,
    activeRequests: id === 'codex' ? 1 : 0,
    usageValue: usagePercent,
    usageLimit: usagePercent === null ? null : 100,
    usageUnit: usagePercent === null ? null : 'percent',
    usagePercent,
    requestsPerMinute: null,
    updatedAt: Date.now(),
    freshness: 'live',
    source: 'local-events',
  };
}

describe('TaskbarUsageCompact', () => {
  it('renders four ordered provider rows, honest unavailable quota, and a full-registry action', () => {
    render(
      <TaskbarUsageCompact
        payload={{
          snapshots: [
            provider('codex', null),
            provider('openai', 42),
            provider('anthropic', 20),
            provider('deepgram', 10),
            provider('groq', 5),
          ],
          totalActiveRequests: 1,
          publishedAt: Date.now(),
        }}
        preferences={{
          enabled: true,
          launchWithVibeSpace: true,
          providerOrder: ['codex', 'openai', 'anthropic', 'deepgram', 'groq'],
          hiddenProviderIds: [],
          pinnedProviderIds: [],
          registrySort: 'active',
          detailsOpen: false,
          placement: null,
          collapsed: false,
        }}
        onToggleCollapsed={() => undefined}
        onOpenReorder={() => undefined}
        onOpenExpanded={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    expect(screen.getByText('1 active request')).toBeTruthy();
    expect(screen.getAllByTestId('taskbar-provider-row')).toHaveLength(4);
    expect(screen.getByText('Quota unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View all providers' })).toBeTruthy();
    expect(screen.getByText('5 connected')).toBeTruthy();
    expect(screen.getByText('0 warnings')).toBeTruthy();
    expect(screen.queryByText('groq')).toBeNull();
  });
});

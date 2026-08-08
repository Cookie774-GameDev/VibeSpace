import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskbarUsageReorder } from './TaskbarUsageReorder';
import type { TaskbarUsageStoreSnapshot } from './taskbarUsageStore';

const state: TaskbarUsageStoreSnapshot = {
  runtimeDiagnostic: null,
  preferences: {
    enabled: true,
    placement: null,
    collapsed: false,
    launchWithVibeSpace: false,
    providerOrder: ['one', 'two', 'three', 'four', 'five'],
    hiddenProviderIds: [],
    pinnedProviderIds: [],
    registrySort: 'active',
    detailsOpen: false,
  },
  payload: {
    snapshots: ['one', 'two', 'three', 'four', 'five'].map((providerId) => ({
      providerId,
      displayName: providerId,
      connected: true,
      hidden: false,
      activeRequests: 0,
      usageValue: null,
      usageLimit: null,
      usageUnit: null,
      usagePercent: null,
      requestsPerMinute: null,
      updatedAt: 1,
      freshness: 'fresh' as const,
      source: 'terminal-session' as const,
    })),
    totalActiveRequests: 0,
    publishedAt: 1,
  },
};

describe('TaskbarUsageReorder', () => {
  it('identifies the four provider rows visible in compact mode', () => {
    const { container } = render(
      <TaskbarUsageReorder
        state={state}
        onMove={() => undefined}
        onMoveTo={() => undefined}
        onToggleHidden={() => undefined}
        onReset={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText('Shown')).toHaveLength(4);
    expect(container.querySelectorAll('.taskbar-usage-reorder-row')[4]?.textContent).not.toContain(
      'Shown',
    );
  });
});

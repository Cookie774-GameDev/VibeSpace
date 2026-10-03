import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => {
  const state = { projectId: null, workspaceId: null, localUserId: null, cloudSession: null };
  return { useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
    subscribe: () => () => undefined,
  }) };
});

vi.mock('./liveWork', () => ({
  focusChat: vi.fn(),
  focusTerminalSession: vi.fn(),
  useLiveChatStatuses: () => [],
  useLiveTerminalStatuses: () => [],
}));

vi.mock('./pinnedStore', () => ({
  usePinnedStore: (
    selector: (state: {
      files: never[];
      maps: never[];
      unpinFile: () => undefined;
      unpinMap: () => undefined;
    }) => unknown,
  ) =>
    selector({
      files: [],
      maps: [],
      unpinFile: () => undefined,
      unpinMap: () => undefined,
    }),
}));

import { InspectorActiveWorkPanel } from './InspectorActiveWorkPanel';
import { useWorkspaceAnalyticsStore } from './workspaceAnalytics';

describe('InspectorActiveWorkPanel analytics truth', () => {
  beforeEach(() => {
    useWorkspaceAnalyticsStore.setState({
      totalTokens: 185,
      totalReasoningTokens: 25,
      totalCachedTokens: 10,
      actualTotalCostUsd: 0.2,
      estimatedTotalCostUsd: 0.03,
      recordedTotalCostUsd: 0.23,
      requestCount: 5,
      completedRunCount: 2,
      failedRunCount: 1,
      cancelledRunCount: 2,
      linesAdded: 18,
      linesRemoved: 6,
      byModel: [
        {
          providerName: 'OpenAI',
          modelName: 'gpt-5.6-sol',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 185,
          recordedCostUsd: 0.23,
        },
      ],
    });
  });

  it('renders persisted run outcomes, file changes, and exact provider/model identity', () => {
    render(<InspectorActiveWorkPanel workspaceId={null} />);

    expect(screen.getByText('Requests').nextSibling?.textContent).toBe('5');
    expect(screen.getByText('Completed runs').nextSibling?.textContent).toBe('2');
    expect(screen.getByText('Failed runs').nextSibling?.textContent).toBe('1');
    expect(screen.getByText('Cancelled runs').nextSibling?.textContent).toBe('2');
    expect(screen.getByText('File changes').nextSibling?.textContent).toBe('+18 / −6');
    expect(screen.getByText('By model')).toBeTruthy();
    expect(screen.getByText('OpenAI · gpt-5.6-sol')).toBeTruthy();
  });
});

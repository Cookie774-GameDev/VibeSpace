import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskbarUsageExpanded, usageWarningSeverity } from './TaskbarUsageExpanded';
import type { ProviderUsageSnapshot } from './providerUsageTypes';

const openAi: ProviderUsageSnapshot = {
  providerId: 'openai-api',
  providerFamilyId: 'openai',
  displayName: 'OpenAI',
  connected: true,
  connectionState: 'connected',
  routeId: 'api',
  routeLabel: 'API key',
  routeType: 'api_key',
  usageCapability: 'partial',
  hidden: false,
  activeRequests: 0,
  usageValue: 0,
  usageLimit: 100,
  usageUnit: 'usd',
  usagePercent: 0,
  requestsPerMinute: null,
  updatedAt: 1_000,
  freshness: 'fresh',
  source: 'provider-api',
};

describe('TaskbarUsageExpanded', () => {
  it('uses the documented 70, 85, and 95 percent warning thresholds', () => {
    expect(usageWarningSeverity(69)).toBe('none');
    expect(usageWarningSeverity(70)).toBe('notice');
    expect(usageWarningSeverity(85)).toBe('high');
    expect(usageWarningSeverity(95)).toBe('critical');
    expect(usageWarningSeverity(null)).toBe('none');
  });

  it('shows the complete registry, truthful connection states, and filters without fabricating usage', () => {
    const onTogglePinned = vi.fn();
    const onRefresh = vi.fn();
    const onOpenConnections = vi.fn();
    render(
      <TaskbarUsageExpanded
        payload={{ snapshots: [openAi], totalActiveRequests: 0, publishedAt: 1_000 }}
        pinnedProviderIds={[]}
        sort="active"
        onClose={() => undefined}
        onRefresh={onRefresh}
        onOpenConnections={onOpenConnections}
        onSortChange={() => undefined}
        onTogglePinned={onTogglePinned}
      />,
    );

    expect(screen.getAllByTestId('usage-registry-row')).toHaveLength(35);
    expect(screen.getByText('No usage recorded this period')).toBeTruthy();
    expect(screen.getByText('Local OpenAI-compatible')).toBeTruthy();
    expect(screen.getByRole('generic', { name: 'Usage data source legend' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Sort providers'), {
      target: { value: 'name' },
    });
    expect(screen.getAllByTestId('usage-registry-row')[0]?.textContent).toContain(
      'Alibaba Model Studio',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connected providers' }));
    expect(screen.getAllByTestId('usage-registry-row')).toHaveLength(1);
    expect(screen.getByText('OpenAI')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Speech providers' }));
    expect(screen.getAllByTestId('usage-registry-row')).toHaveLength(3);
    expect(screen.getByText('Deepgram')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'All providers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin OpenAI' }));
    expect(onTogglePinned).toHaveBeenCalledWith('openai-api', true);

    fireEvent.click(screen.getByRole('button', { name: 'View OpenAI diagnostics' }));
    expect(screen.getByRole('complementary', { name: 'Provider diagnostics' })).toBeTruthy();
    expect(screen.getByText(/Sanitized diagnostic preview/)).toBeTruthy();
    expect(screen.getByText(/"errorCode": null/)).toBeTruthy();
    expect(screen.getByText(/"cacheAgeSeconds":/)).toBeTruthy();
    expect(screen.getByText(/"rateLimitState": "unknown"/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh OpenAI usage' }));
    expect(onRefresh).toHaveBeenCalledWith('openai-api');

    fireEvent.change(screen.getByRole('combobox', { name: 'Configure OpenAI route' }), {
      target: { value: 'codex' },
    });
    expect(onOpenConnections).toHaveBeenCalledWith('openai');
  }, 10_000);
});

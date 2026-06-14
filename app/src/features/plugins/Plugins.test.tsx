import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plugins } from './Plugins';
import { usePluginStore } from './store';

vi.mock('@/lib/sync', () => ({
  enqueueMutation: vi.fn(async () => 'syq_plugin_test'),
}));

describe('Plugins settings page', () => {
  const originalOpen = window.open;

  beforeEach(() => {
    usePluginStore.setState({ connections: {} });
    window.open = vi.fn();
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('loads the catalog and filters by search', () => {
    render(<Plugins />);
    expect(screen.getByText('GitHub')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Linear' } });
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();
  }, 15_000);

  it('connects and disconnects the local mock connector', async () => {
    render(<Plugins />);
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Mock Connector' } });
    const card = screen.getByTestId('plugin-card-mock-connector');
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(await screen.findByText(/connected as local test connector/i)).toBeTruthy();
    fireEvent.click(screen.getAllByText('Close').find((node) => node.tagName === 'BUTTON')!);
    fireEvent.click(
      within(screen.getByTestId('plugin-card-mock-connector')).getByRole('button', {
        name: /manage/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('plugin-card-mock-connector')).getByText('Not connected'),
      ).toBeTruthy(),
    );
  }, 15_000);

  it('opens the official provider connect page before credential entry', () => {
    render(<Plugins />);
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    fireEvent.click(within(screen.getByTestId('plugin-card-github')).getByRole('button', { name: /^connect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /open github connect page/i }));
    expect(window.open).toHaveBeenCalledWith(
      'https://github.com/settings/personal-access-tokens',
      '_blank',
      'noopener,noreferrer',
    );
  }, 15_000);
});

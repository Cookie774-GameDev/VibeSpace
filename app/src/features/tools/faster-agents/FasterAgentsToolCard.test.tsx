import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.fn();
const setRoute = vi.fn();
let route = 'tools';

vi.mock('@/features/terminals/faster-agents/fasterAgentsStore', () => ({
  useFasterAgentsStore: { getState: () => ({ launch }) },
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ setRoute, route }) },
}));

import { FasterAgentsToolCard } from './FasterAgentsToolCard';

describe('FasterAgentsToolCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route = 'tools';
  });
  afterEach(cleanup);
  it('keeps the Workbench open when selecting its terminals', () => {
    route = 'workbench';
    render(<FasterAgentsToolCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Faster Agents' }));
    expect(launch).toHaveBeenCalledOnce();
    expect(setRoute).not.toHaveBeenCalled();
  });
  it('launches the selection flow before navigating to terminals', () => {
    render(<FasterAgentsToolCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Run Faster Agents' }));
    expect(launch).toHaveBeenCalledOnce();
    expect(setRoute).toHaveBeenCalledWith('terminal');
    expect(launch.mock.invocationCallOrder[0]).toBeLessThan(setRoute.mock.invocationCallOrder[0]!);
  });
});

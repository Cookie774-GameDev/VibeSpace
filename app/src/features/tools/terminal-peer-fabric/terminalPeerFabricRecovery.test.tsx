import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalPeerFabricCommandPort } from './terminalPeerFabricTool';
import { TerminalPeerFabricToolCard } from './TerminalPeerFabricToolCard';
const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock('@/features/instant-command/targetSnapshot', () => ({ readLiveTargetSnapshot: discover }));
const capability = { available: true, version: '2.0.0', operations: ['connect', 'team.status'] };
describe('Terminal Peer Fabric recovery', () => {
  afterEach(cleanup);
  it('refreshes terminals that became eligible after the card mounted', async () => {
    discover.mockResolvedValueOnce([]).mockResolvedValueOnce([{}, {}]);
    const port = {
      capability: vi.fn().mockResolvedValue(capability),
      connect: vi.fn(),
      command: vi.fn(),
    };
    render(<TerminalPeerFabricToolCard port={port} />);
    await screen.findByText('Needs at least two eligible terminals.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh Terminal Peer Fabric availability' }),
    );
    await screen.findByText('2 eligible terminals ready.');
    expect(
      (screen.getByRole('button', { name: 'Run Terminal Peer Fabric' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(port.connect).not.toHaveBeenCalled();
  });
  it('rechecks a cached unavailable capability only when explicitly refreshed', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('startup not ready'))
      .mockResolvedValue(capability);
    const port = createTerminalPeerFabricCommandPort(invoke);
    expect(await port.capability()).toEqual({ available: false });
    expect(await port.capability()).toEqual({ available: false });
    expect(invoke).toHaveBeenCalledOnce();
    expect(await port.capability(true)).toEqual(capability);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(
      invoke.mock.calls.every(
        ([command, args]) =>
          command === 'terminal_peer_fabric' && args.request.action === 'capability',
      ),
    ).toBe(true);
  });
  it('recovers Run without launching or connecting anything during refresh', async () => {
    const port = {
      capability: vi.fn().mockResolvedValueOnce({ available: false }).mockResolvedValue(capability),
      connect: vi.fn(),
      command: vi.fn(),
    };
    render(<TerminalPeerFabricToolCard port={port} eligibleTerminalCount={2} />);
    await screen.findByText('Not available in this build.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh Terminal Peer Fabric availability' }),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Run Terminal Peer Fabric' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(port.capability).toHaveBeenLastCalledWith(true);
    expect(port.connect).not.toHaveBeenCalled();
    expect(port.command).not.toHaveBeenCalled();
  });
});

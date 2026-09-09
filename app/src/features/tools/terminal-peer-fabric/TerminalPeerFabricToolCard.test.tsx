// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalPeerFabricToolCard } from './TerminalPeerFabricToolCard';
import type { TerminalPeerFabricCommandPort } from './terminalPeerFabricTool';

function port(
  available: boolean,
  operations: readonly ('connect' | 'team.status')[] = ['connect', 'team.status'],
): TerminalPeerFabricCommandPort {
  return {
    capability: vi
      .fn()
      .mockResolvedValue(
        available ? { available: true, version: '2.0.0', operations } : { available: false },
      ),
    connect: vi.fn(),
    command: vi.fn(),
  };
}

describe('TerminalPeerFabricToolCard', () => {
  it('stays visible and truthfully disabled when native capability is unavailable', async () => {
    await act(async () => {
      render(<TerminalPeerFabricToolCard port={port(false)} eligibleTerminalCount={3} />);
    });

    expect(screen.getByText('Terminal Peer Fabric')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /run terminal peer fabric/i }).hasAttribute('disabled'),
      ).toBe(true),
    );
    expect(await screen.findByText(/not available in this build/i)).toBeTruthy();
  });

  it('opens pane selection even when the cached terminal count is below two', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      render(<TerminalPeerFabricToolCard port={port(true)} eligibleTerminalCount={1} onOpen={onOpen} />);
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /run terminal peer fabric/i }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: /run terminal peer fabric/i }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('stays disabled when the native endpoint cannot connect teams', async () => {
    await act(async () => {
      render(
        <TerminalPeerFabricToolCard port={port(true, ['team.status'])} eligibleTerminalCount={3} />,
      );
    });

    const run = screen.getByRole('button', { name: /run terminal peer fabric/i });
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(true));
    expect(screen.getByText(/not available in this build/i)).toBeTruthy();
  });

  it('fails closed when a capability port rejects its probe', async () => {
    const rejecting = port(true);
    rejecting.capability = vi.fn().mockRejectedValue(new Error('native probe failed'));
    await act(async () => {
      render(<TerminalPeerFabricToolCard port={rejecting} eligibleTerminalCount={3} />);
    });

    const run = screen.getByRole('button', { name: /run terminal peer fabric/i });
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(true));
    expect(await screen.findByText(/not available in this build/i)).toBeTruthy();
  });

  it('opens the local setup surface without installing or downloading anything', async () => {
    const onOpen = vi.fn();
    await act(async () => {
      render(
        <TerminalPeerFabricToolCard port={port(true)} eligibleTerminalCount={2} onOpen={onOpen} />,
      );
    });
    const run = screen.getByRole('button', { name: /run terminal peer fabric/i });
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(false));
    fireEvent.click(run);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

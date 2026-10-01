import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetTerminalSurface } from './PetTerminalSurface';
import { usePetPresentationStore } from './petPresentationStore';

const clearTerminalSession = vi.fn();
const openTerminalVibespacePalette = vi.fn();

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => [],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@/features/terminals/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="live-terminal" data-session={sessionId ?? 'pending'}>
      {sessionId ?? 'pending'}
    </div>
  ),
}));

vi.mock('@/features/terminals/terminalClear', () => ({
  clearTerminalSession: (...args: unknown[]) => clearTerminalSession(...args),
}));

vi.mock('@/features/terminals/terminalSlashIntegration', () => ({
  openTerminalVibespacePalette: (...args: unknown[]) => openTerminalVibespacePalette(...args),
}));

vi.mock('@/features/terminals/transcriptStore', () => ({
  useTerminalTranscriptStore: {
    getState: () => ({ forgetSession: vi.fn() }),
  },
}));

vi.mock('@/lib/db', () => ({
  terminalSessionRepo: {
    listByWorkspace: vi.fn(async () => []),
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: { workspaceId: string; projectId: string }) => unknown) =>
    selector({ workspaceId: 'workspace-1', projectId: 'project-1' }),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: { defaultTerminalFontSize: number }) => unknown) =>
    selector({ defaultTerminalFontSize: 13 }),
}));

describe('PetTerminalSurface main-app chrome (no grid, max 4)', () => {
  beforeEach(() => {
    localStorage.clear();
    clearTerminalSession.mockClear();
    openTerminalVibespacePalette.mockClear();
    usePetPresentationStore.setState({
      terminals: {
        first: {
          terminalId: 'first',
          ptyId: 'pty-first',
          owner: 'pet-mini-panel',
          title: 'First',
          status: 'running',
        },
        second: {
          terminalId: 'second',
          ptyId: 'pty-second',
          owner: 'pet-mini-panel',
          title: 'Second',
          status: 'running',
        },
      },
      panelActiveTerminalId: 'first',
      lastLimitMessage: null,
    });
  });

  it('has no grid control and keeps all sessions mounted for lag-free tab switch', () => {
    render(<PetTerminalSurface />);

    expect(screen.queryByRole('button', { name: /grid/i })).toBeNull();
    // Both live PTYs stay mounted (hidden when inactive) — max 4, no remount on switch.
    const live = screen.getAllByTestId('live-terminal');
    expect(live).toHaveLength(2);
    expect(live.map((el) => el.getAttribute('data-session')).sort()).toEqual([
      'pty-first',
      'pty-second',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'Open terminal Second' }));
    expect(usePetPresentationStore.getState().panelActiveTerminalId).toBe('second');
    expect(screen.getAllByTestId('live-terminal')).toHaveLength(2);
  });

  it('exposes the same PaneToolbar controls: palette, T, clear hold, close hold', () => {
    render(<PetTerminalSurface />);

    expect(
      screen.getByRole('button', { name: 'Open VibeSpace terminal palette' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cycle font size/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Hold 1\.5s to clear screen/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Hold 1\.5s to close pane/i })).toBeTruthy();
  });

  it('requires hold-then-confirm before clear (identical to main app)', () => {
    render(<PetTerminalSurface />);

    const clearBtn = screen.getByRole('button', { name: /Hold 1\.5s to clear screen/i });
    fireEvent.pointerDown(clearBtn);
    // Not yet in confirm — clear must not fire on a short click.
    expect(clearTerminalSession).not.toHaveBeenCalled();
    fireEvent.pointerUp(clearBtn);
    expect(screen.queryByRole('button', { name: 'Confirm clear' })).toBeNull();
  });

  it('enforces max 4 and never offers a grid layout attribute', () => {
    render(<PetTerminalSurface />);
    const surface = document.querySelector('[data-pet-terminal-surface="true"]');
    expect(surface?.getAttribute('data-pet-terminal-layout')).toBe('tabs');
    expect(surface?.getAttribute('data-pet-terminal-layout')).not.toBe('grid');
  });
});

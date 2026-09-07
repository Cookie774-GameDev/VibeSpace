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
  TerminalView: ({ sessionId, paneId, onReady }: { sessionId: string | null; paneId: string; onReady: (id: string) => void }) => (
    <div data-testid="live-terminal" data-session={sessionId ?? 'pending'} data-pane={paneId}>
      {sessionId ?? 'pending'}
      {!sessionId && <button onClick={() => onReady('new-live-pty')}>Report ready</button>}
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

describe('PetTerminalSurface main-app chrome (tabs and grid, max 4)', () => {
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

  it('keeps all sessions mounted across grid and tab switches', () => {
    render(<PetTerminalSurface />);

    // Both live PTYs stay mounted (hidden when inactive) — max 4, no remount on switch.
    const live = screen.getAllByTestId('live-terminal');
    expect(live).toHaveLength(2);
    expect(live.map((el) => el.getAttribute('data-session')).sort()).toEqual([
      'pty-first',
      'pty-second',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(document.querySelector('[data-pet-terminal-layout="grid"]')).not.toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Terminals' })).toBeNull();
    expect(document.querySelectorAll('[data-pet-terminal-tile][aria-hidden="false"]')).toHaveLength(2);
    fireEvent.pointerDown(document.querySelector('[data-pet-terminal-tile="second"]')!);
    expect(usePetPresentationStore.getState().panelActiveTerminalId).toBe('second');
    expect(screen.getAllByTestId('live-terminal')).toEqual(live);
    fireEvent.click(screen.getByRole('button', { name: 'Tabs view' }));
    expect(document.querySelectorAll('[data-pet-terminal-tile][aria-hidden="false"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Open terminal Second' }));
    expect(usePetPresentationStore.getState().panelActiveTerminalId).toBe('second');
    expect(screen.getAllByTestId('live-terminal')).toHaveLength(2);
  });

  it('preserves the live renderer and pane identity when a new shell becomes ready', () => {
    usePetPresentationStore.setState({ terminals: {}, panelActiveTerminalId: null });
    render(<PetTerminalSurface />);
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    const terminal = screen.getByTestId('live-terminal');
    const paneId = terminal.getAttribute('data-pane');
    fireEvent.click(screen.getByRole('button', { name: 'Report ready' }));
    expect(screen.getByTestId('live-terminal')).toBe(terminal);
    expect(terminal.getAttribute('data-session')).toBe('new-live-pty');
    expect(terminal.getAttribute('data-pane')).toBe(paneId);
    expect(usePetPresentationStore.getState().terminals['new-live-pty'].paneId).toBe(paneId);
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tabs view' }));
    expect(screen.getByTestId('live-terminal')).toBe(terminal);
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

  it('shows all four terminals in grid and keeps the four-session limit', () => {
    const first = usePetPresentationStore.getState().terminals.first;
    usePetPresentationStore.setState((s) => ({ terminals: { ...s.terminals,
      third: { ...first, terminalId: 'third', ptyId: 'pty-third' },
      fourth: { ...first, terminalId: 'fourth', ptyId: 'pty-fourth' },
    } }));
    render(<PetTerminalSurface />);
    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(document.querySelectorAll('[data-pet-terminal-tile][aria-hidden="false"]')).toHaveLength(4);
    expect((screen.getByRole('button', { name: 'New terminal' }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem('vibespace-pet-terminal-view-mode')).toBe('grid');
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFasterAgentsStore } from './fasterAgentsStore';
import { useUIStore } from '@/stores/ui';

const { enqueueTerminalCommand } = vi.hoisted(() => ({
  enqueueTerminalCommand: vi.fn(),
}));

vi.mock('../terminalCommandQueue', () => ({ enqueueTerminalCommand }));
vi.mock('./fasterAgentsAudio', () => ({
  preloadOpenWhipCracks: vi.fn(),
  playOpenWhipCrack: vi.fn(async () => true),
}));
vi.mock('./WhipCanvas', () => ({
  WhipCanvas: ({ onCrack, onDismiss }: { onCrack: () => void; onDismiss: () => void }) => (
    <div data-testid="whip-canvas-fixture">
      <button type="button" onClick={onCrack}>
        Simulate pointer crack
      </button>
      <button type="button" onClick={onDismiss}>
        Simulate canvas click
      </button>
    </div>
  ),
}));
import { FasterAgentsOverlay } from './FasterAgentsOverlay';

const terminals = [1, 2, 3].map((index) => ({
  ref: { paneId: `pane-${index}`, sessionId: `session-${index}`, command: 'codex' },
  label: `Terminal ${index}`,
  detail: 'codex · live',
}));

describe('FasterAgentsOverlay', () => {
  beforeEach(() => {
    useUIStore.setState({ route: 'terminal' });
    enqueueTerminalCommand.mockReset();
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1;
        play() {
          return Promise.resolve();
        }
        pause() {}
      },
    );
    useFasterAgentsStore.setState({
      open: true,
      phase: 'select',
      selectedRefs: [],
      phrases: ['Move now.'],
      soundEnabled: false,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('selects the real panes in place and sends only to the exact selected group', async () => {
    const pane1 = document.createElement('div');
    pane1.dataset.terminalDropPaneId = 'pane-1';
    const pane3 = document.createElement('div');
    pane3.dataset.terminalDropPaneId = 'pane-3';
    document.body.append(pane1, pane3);

    render(<FasterAgentsOverlay terminals={terminals} />);
    expect(screen.getByTestId('faster-agents-dimmer').className).toContain('bg-black/55');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /Terminal 1/ })).toBeNull();
    fireEvent.pointerDown(pane1);
    fireEvent.pointerDown(pane3);
    await waitFor(() => expect(pane1.dataset.fasterAgentsSelected).toBe('true'));
    expect(pane3.dataset.fasterAgentsSelected).toBe('true');
    expect(document.documentElement.dataset.fasterAgentsSelecting).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Done selecting' }));
    expect(document.documentElement.dataset.fasterAgentsWhipping).toBe('true');
    expect(screen.queryByRole('button', { name: /crack now/i })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate pointer crack' }));

    expect(enqueueTerminalCommand).toHaveBeenCalledOnce();
    expect(enqueueTerminalCommand).toHaveBeenCalledWith({
      command: 'Move now.',
      target: 'refs',
      refs: [terminals[0]!.ref, terminals[2]!.ref],
    });
    pane1.remove();
    pane3.remove();
  });

  it('lets Enter finish selection and a canvas click dismiss without another delivery', async () => {
    const pane1 = document.createElement('div');
    pane1.dataset.terminalDropPaneId = 'pane-1';
    document.body.append(pane1);
    render(<FasterAgentsOverlay terminals={terminals} />);

    fireEvent.pointerDown(pane1);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(await screen.findByTestId('whip-canvas-fixture')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Simulate canvas click' }));

    expect(useFasterAgentsStore.getState().open).toBe(false);
    expect(enqueueTerminalCommand).not.toHaveBeenCalled();
    pane1.remove();
  });

  it('closing from selection sends nothing', () => {
    render(<FasterAgentsOverlay terminals={terminals} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Faster Agents' }));
    expect(useFasterAgentsStore.getState().open).toBe(false);
    expect(enqueueTerminalCommand).not.toHaveBeenCalled();
  });
  it('uses only the Workbench picker when the terminals page is still mounted', () => {
    useUIStore.setState({ route: 'workbench' });
    render(
      <>
        <FasterAgentsOverlay terminals={terminals} />
        <FasterAgentsOverlay surface="workbench" terminals={terminals} />
      </>,
    );
    expect(screen.getAllByLabelText('Select terminals for Faster Agents')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close Faster Agents' }));
    expect(enqueueTerminalCommand).not.toHaveBeenCalled();
  });
});

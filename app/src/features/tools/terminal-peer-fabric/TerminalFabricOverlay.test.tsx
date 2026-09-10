// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), connect: vi.fn(), command: vi.fn() }));
vi.mock('@/features/instant-command/targetSnapshot', () => ({
  readLiveTargetSnapshot: mocks.read,
}));
vi.mock('./terminalPeerFabricTool', () => ({ terminalPeerFabricCommandPort: mocks }));
import { fabricBridge, TerminalFabricOverlay } from './TerminalFabricOverlay';
import { recordFabricDelivery, useFabricPresentationStore } from './fabricPresentationStore';
const targets = [1, 2, 3].map((n) => ({
  sessionId: `tty-${n}`,
  paneId: `pane-${n}`,
  projectId: 'project',
  ordinal: n,
  label: `Shell ${n}`,
  processIdentity: { processInstanceId: `process-${n}`, runtimeGeneration: 'generation' },
}));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.read.mockReset().mockResolvedValue(targets);
  mocks.connect
    .mockReset()
    .mockResolvedValue({ status: 'completed', targetIds: ['tty-1', 'tty-2'] });
  mocks.command
    .mockReset()
    .mockResolvedValue({ status: 'completed', targetIds: ['tty-1', 'tty-2'] });
  useFabricPresentationStore.setState({ selecting: true, peers: [], delivery: null });
  targets.forEach((t, i) => {
    const pane = document.createElement('div');
    pane.dataset.terminalDropPaneId = t.paneId;
    pane.getBoundingClientRect = () => ({ x: i * 320, y: 160, width: 300, height: 600 }) as DOMRect;
    document.body.append(pane);
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function selectTwo() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Shell 1 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect Shell 2 2' }));
}
describe('native Fabric pane selection', () => {
  it('highlights panes, requires confirmation, and draws only confirmed connections', async () => {
    const view = render(<TerminalFabricOverlay visible projectId="project" />);
    expect(
      screen.getByRole('button', { name: 'Confirm connection' }).hasAttribute('disabled'),
    ).toBe(true);
    await selectTwo();
    expect(
      screen.getByRole('button', { name: 'Connect Shell 1 1' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(mocks.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm connection' }));
    await waitFor(() => expect(screen.getByLabelText('2 connected terminals')).toBeTruthy());
    expect(
      mocks.connect.mock.calls[0][0].peerRefs.map((p: { sessionId: string }) => p.sessionId),
    ).toEqual(['tty-1', 'tty-2']);
    expect(document.querySelector('.vs-fabric-spark')).toBeNull();
    act(() => recordFabricDelivery('receipt', 'tty-1', ['tty-2']));
    expect(document.querySelector('.vs-fabric-spark')).toBeTruthy();
    await waitFor(() => expect(useFabricPresentationStore.getState().delivery).toBeNull());
    view.rerender(<TerminalFabricOverlay visible projectId="different-project" />);
    expect(document.querySelector('.vs-fabric-bridges')).toBeNull();
  }, 15000);
  it('cancels without connecting', async () => {
    render(<TerminalFabricOverlay visible projectId="project" />);
    await selectTwo();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel terminal connection' }));
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(document.querySelector('.vs-fabric-bridges')).toBeNull();
  });
  it('rejects a terminal that restarted after selection', async () => {
    render(<TerminalFabricOverlay visible projectId="project" />);
    await selectTwo();
    mocks.read.mockResolvedValue(
      targets.map((t) => ({
        ...t,
        processIdentity: { ...t.processIdentity, processInstanceId: 'replacement' },
      })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('never shows a bridge for a rejected native receipt', async () => {
    mocks.connect.mockResolvedValue({ status: 'rejected', targetIds: ['tty-1', 'tty-2'] });
    render(<TerminalFabricOverlay visible projectId="project" />);
    await selectTwo();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm connection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not confirmed');
    expect(document.querySelector('.vs-fabric-bridges')).toBeNull();
  });
});

it('retains a Fabric launch while the terminal route is still hidden', async () => {
  useFabricPresentationStore.setState({ selecting: false });
  const view = render(<TerminalFabricOverlay visible={false} projectId="project" />);
  act(() => useFabricPresentationStore.getState().launch());
  expect(useFabricPresentationStore.getState().selecting).toBe(true);
  view.rerender(<TerminalFabricOverlay visible projectId="project" />);
  await screen.findByRole('button', { name: 'Confirm connection' });
  expect(mocks.connect).not.toHaveBeenCalled();
  view.rerender(<TerminalFabricOverlay visible={false} projectId="project" />);
  expect(useFabricPresentationStore.getState().selecting).toBe(false);
});

describe('divider bridge geometry', () => {
  const left = { id: 'left', x: 300, y: 150, width: 790, height: 850 };
  const right = { id: 'right', x: 1104, y: 150, width: 790, height: 850 };
  it('stays in the narrow gap, including when the right pane is selected first', () => {
    expect(fabricBridge(left, right)?.path).toBe('M 1090 575 L 1104 575');
    expect(fabricBridge(right, left)?.path).toBe('M 1104 575 L 1090 575');
  });
  it('uses the horizontal divider for vertically stacked panes', () => {
    const lower = { ...left, id: 'lower', y: 1014 };
    expect(fabricBridge(left, lower)?.path).toBe('M 695 1000 L 695 1014');
    expect(fabricBridge(lower, left)?.path).toBe('M 695 1014 L 695 1000');
  });
  it('does not draw across overlapping or diagonally separated terminal content', () => {
    expect(fabricBridge(left, left)).toBeNull();
    expect(fabricBridge(left, { ...right, y: 1100 })).toBeNull();
  });
});

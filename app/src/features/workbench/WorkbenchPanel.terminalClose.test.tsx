// @vitest-environment jsdom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchPanel as WorkbenchPanelModel } from './types';

const closeSession = vi.hoisted(() => vi.fn());
const paneSession = vi.hoisted(() => vi.fn());
vi.mock('./workbenchTerminalClose', () => ({ closeWorkbenchTerminalSession: closeSession }));
vi.mock('@/features/terminals/terminalClearRegistry', () => ({
  getTerminalPaneSessionId: paneSession,
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ projectId: 'project-owned' }) },
}));
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => <div>Terminal panel</div> }));
vi.mock('./BrowserPanel', () => ({ BrowserPanel: () => <div>Browser panel</div> }));
vi.mock('./ReferencePanel', () => ({ ReferencePanel: () => <div>Reference panel</div> }));

import { WorkbenchPanel } from './WorkbenchPanel';

const panel: WorkbenchPanelModel = {
  id: 'terminal-panel-owned',
  kind: 'terminal',
  title: 'Terminal',
  x: 10,
  y: 10,
  width: 480,
  height: 320,
  z: 1,
  minimized: false,
  status: 'ready',
  settings: { resourceId: 'pty-owned' },
};

function renderPanel(ownedPanel = panel) {
  const onClose = vi.fn();
  render(
    <WorkbenchPanel
      panel={ownedPanel}
      selected
      zoom={1}
      onSelect={vi.fn()}
      onBringToFront={vi.fn()}
      onUpdate={vi.fn()}
      onRuntimeUpdate={vi.fn()}
      onDuplicate={vi.fn()}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  closeSession.mockReset();
  paneSession.mockReset().mockReturnValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Workbench terminal panel close', () => {
  it('leaves the live panel and PTY alone when the user cancels', () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const onClose = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(closeSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the panel only after exact session termination succeeds', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    closeSession.mockResolvedValue('stopped');
    const onClose = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(closeSession).toHaveBeenCalledWith('pty-owned', 'project-owned', expect.any(Function));
  });

  it('keeps the panel available when termination fails', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    closeSession.mockRejectedValue(new Error('session binding changed'));
    const onClose = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    expect((await screen.findByRole('alert')).textContent).toContain('session binding changed');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close Terminal' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('keeps the existing immediate panel close for a terminal without a session ID', () => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    const onClose = renderPanel({ ...panel, settings: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses the mounted pane session during the onReady persistence gap', async () => {
    paneSession.mockReturnValue('pty-just-started');
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    closeSession.mockResolvedValue('stopped');
    const onClose = renderPanel({ ...panel, settings: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(paneSession).toHaveBeenCalledWith('terminal-panel-owned');
    expect(closeSession).toHaveBeenCalledWith(
      'pty-just-started',
      'project-owned',
      expect.any(Function),
    );
  });
});

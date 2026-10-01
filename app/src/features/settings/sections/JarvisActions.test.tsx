import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActionsPaletteOpen: vi.fn(),
  setRoute: vi.fn(),
  setSettingsOpen: vi.fn(),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: typeof mocks) => unknown) => selector(mocks),
}));

vi.mock('@/features/tools/toolStore', () => ({
  useToolStore: (selector: (state: { tools: unknown[] }) => unknown) => selector({ tools: [] }),
}));

vi.mock('@/lib/actions', () => ({
  BUILTIN_ACTION_COUNT: 3,
  getAllActions: () => [{ id: 'nav.chat' }, { id: 'terminal.run' }, { id: 'files.get' }],
}));

vi.mock('@/lib/assistantPersona', () => ({
  askAssistantLabel: () => 'Ask Jarvis',
  useAssistantPersonaName: () => 'Jarvis',
}));

import { JarvisActions } from './JarvisActions';

describe('JarvisActions settings', () => {
  it('closes Settings before navigating to Custom Tools', () => {
    render(<JarvisActions />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage custom tools' }));

    expect(mocks.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(mocks.setRoute).toHaveBeenCalledWith('tools');
    expect(mocks.setSettingsOpen.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setRoute.mock.invocationCallOrder[0]!,
    );
  });

  it('states the approval boundary and only advertises the real resolved catalog', () => {
    render(<JarvisActions />);

    expect(screen.getByText(/Nothing runs until you click/i)).toBeTruthy();
    expect(screen.getByText(/3 built-in actions/i)).toBeTruthy();
    expect(screen.getByText(/3 available to Jarvis/i)).toBeTruthy();
    expect(screen.getByText(/custom\.createTerminalCommand/i)).toBeTruthy();
    expect(screen.getByText(/custom\.createWorkflowTool/i)).toBeTruthy();
  });
});

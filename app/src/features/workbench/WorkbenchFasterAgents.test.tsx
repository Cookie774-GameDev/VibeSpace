import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { overlay } = vi.hoisted(() => ({ overlay: vi.fn() }));
vi.mock('@/features/terminals/faster-agents/FasterAgentsOverlay', () => ({
  FasterAgentsOverlay: (props: unknown) => {
    overlay(props);
    return <div data-testid="workbench-picker" />;
  },
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: Function) => select({ projectId: 'project-1' }),
}));
vi.mock('./store', () => ({
  useWorkbenchStore: (select: Function) =>
    select({
      panels: [
        {
          id: 'live',
          kind: 'terminal',
          title: 'Live terminal',
          settings: { resourceId: 'session-1' },
        },
        { id: 'starting', kind: 'terminal', settings: {} },
        { id: 'hidden', kind: 'terminal', minimized: true, settings: { resourceId: 'session-2' } },
        { id: 'tools', kind: 'tool', settings: { resourceId: 'tools' } },
      ],
    }),
}));
import { WorkbenchFasterAgents } from './WorkbenchFasterAgents';
describe('Workbench Faster Agents', () => {
  afterEach(cleanup);
  it('portals outside canvas transforms and targets only visible live Workbench terminals', () => {
    const { container } = render(<WorkbenchFasterAgents />);
    expect(container.querySelector('[data-testid="workbench-picker"]')).toBeNull();
    expect(screen.getByTestId('workbench-picker').parentElement).toBe(document.body);
    expect(overlay).toHaveBeenLastCalledWith({
      deliver: expect.any(Function),
      surface: 'workbench',
      terminals: [
        {
          ref: {
            paneId: 'live',
            sessionId: 'session-1',
            projectId: 'project-1',
            label: 'Live terminal',
          },
          label: 'Live terminal',
          detail: 'Terminal',
        },
      ],
    });
  });
});

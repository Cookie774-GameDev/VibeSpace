import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), panels: [] as any[], overlay: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign((selector: any) => selector({ projectId: 'project-k24' }), {
    getState: () => ({ projectId: 'project-k24' }),
  }),
}));
vi.mock('./store', () => ({ useWorkbenchStore: { getState: () => ({ panels: mocks.panels }) } }));
vi.mock('@/features/tools/terminal-peer-fabric/TerminalFabricOverlay', () => ({
  TerminalFabricOverlay: (props: any) => {
    mocks.overlay(props);
    return null;
  },
}));
import { readWorkbenchFabricTargets, WorkbenchFabric } from './WorkbenchFabric';
import { useFabricPresentationStore } from '@/features/tools/terminal-peer-fabric/fabricPresentationStore';
afterEach(cleanup);
it('discovers ten real Workbench sessions with native project identities, not the terminal-page tree', async () => {
  mocks.panels = Array.from({ length: 10 }, (_, i) => ({
    id: `wb-${i}`,
    kind: 'terminal',
    title: `Terminal ${i}`,
    settings: { resourceId: `tty-${i}` },
  }));
  mocks.invoke.mockResolvedValue(
    mocks.panels.map((panel, i) => ({
      sessionId: `tty-${i}`,
      projectId: 'project-k24',
      processInstanceId: `process-${i}`,
      runtimeGeneration: 'gen',
      pid: 100 + i,
      processStartedAt: 123,
      startedAt: 123,
    })),
  );
  const targets = await readWorkbenchFabricTargets();
  expect(targets).toHaveLength(10);
  expect(targets.map((t) => t.paneId)).toEqual(mocks.panels.map((p) => p.id));
  mocks.panels[0].minimized = true;
  mocks.panels[1].kind = 'browser';
  mocks.panels[2].settings.resourceId = 'stale';
  expect(await readWorkbenchFabricTargets()).toHaveLength(7);
});
it('opens the shared picker scoped to the Workbench panel frames', () => {
  useFabricPresentationStore.setState({ selecting: false });
  render(<WorkbenchFabric />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Workbench terminals' }));
  expect(useFabricPresentationStore.getState().selecting).toBe(true);
  expect(mocks.overlay).toHaveBeenCalledWith(
    expect.objectContaining({
      visible: true,
      projectId: 'project-k24',
      readTargets: readWorkbenchFabricTargets,
      paneSelector: '.workbench-canvas .workbench-panel:not(.wb-creative-item)',
    }),
  );
});

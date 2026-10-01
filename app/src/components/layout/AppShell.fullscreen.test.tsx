import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFullscreenStore } from '@/features/fullscreen/fullscreenStore';
import { useUIStore, type Route } from '@/stores/ui';

vi.mock('./TopBar', () => ({ TopBar: () => <div data-testid="top-bar" /> }));
vi.mock('./NavPane', () => ({ NavPane: () => <div data-testid="nav-pane" /> }));
vi.mock('./Inspector', () => ({ Inspector: () => <div data-testid="inspector" /> }));
vi.mock('./TabStrip', () => ({ TabStrip: () => <div data-testid="tab-strip" /> }));
vi.mock('./ActivityStrip', () => ({
  CouncilActivityStrip: () => <div data-testid="activity-strip" />,
}));
vi.mock('@/features/workbench/window', () => ({ isWorkbenchDetachedSearch: () => false }));
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { AppShell } from './AppShell';

describe('AppShell Workspace Focus Mode', () => {
  beforeEach(() => {
    useUIStore.setState(useUIStore.getInitialState(), true);
    useUIStore.setState({ route: 'chat', theme: 'default', chatMode: 'council' });
    useFullscreenStore.setState({
      focusActive: false,
      activationOrder: [],
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    useFullscreenStore.setState({ focusActive: false, activationOrder: [] });
  });

  it.each([
    {
      route: 'chat',
      navVisible: false,
      description: 'dedicated chat',
    },
    {
      route: 'terminal',
      navVisible: false,
      description: 'dedicated terminal',
    },
    {
      route: 'canvas',
      navVisible: true,
      description: 'other-page sidebar',
    },
  ] as const)(
    'removes nonessential application chrome for the $description layout',
    ({ route, navVisible }) => {
      useUIStore.setState({ route: route as Route });
      useFullscreenStore.setState({ focusActive: true, activationOrder: ['focus'] });
      const rendered = render(
        <AppShell>
          <section data-testid="active-workspace" />
        </AppShell>,
      );

      expect(rendered.queryByTestId('top-bar')).toBeNull();
      expect(rendered.queryByTestId('tab-strip')).toBeNull();
      expect(rendered.queryByTestId('inspector')).toBeNull();
      expect(rendered.queryByTestId('activity-strip')).toBeNull();
      expect(Boolean(rendered.queryByTestId('nav-pane'))).toBe(navVisible);
      expect(rendered.getByTestId('active-workspace')).toBeTruthy();
      expect(
        rendered.container
          .querySelector('[data-focus-mode="true"]')
          ?.getAttribute('data-focus-mode-route'),
      ).toBe(route);
    },
  );

  it('keeps the active workspace mounted while entering and exiting Focus Mode', () => {
    let mounts = 0;
    function StatefulWorkspace() {
      const identity = React.useRef(Symbol('workspace'));
      React.useEffect(() => {
        mounts += 1;
      }, []);
      return <section data-testid="stateful-workspace" data-stable={String(identity.current)} />;
    }

    const rendered = render(
      <AppShell>
        <StatefulWorkspace />
      </AppShell>,
    );
    const workspace = rendered.getByTestId('stateful-workspace');

    act(() => useFullscreenStore.getState().setFocusActive(true));
    expect(rendered.getByTestId('stateful-workspace')).toBe(workspace);

    act(() => useFullscreenStore.getState().setFocusActive(false));
    expect(rendered.getByTestId('stateful-workspace')).toBe(workspace);
    expect(mounts).toBe(1);
  });

  it('does not replace the existing full-bleed Workbench shell', () => {
    useUIStore.setState({ route: 'workbench' });
    useFullscreenStore.setState({ focusActive: true, activationOrder: ['focus'] });
    const rendered = render(
      <AppShell>
        <section data-testid="workbench" />
      </AppShell>,
    );

    expect(rendered.container.querySelector('[data-workbench-fullscreen="true"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-focus-mode]')).toBeNull();
    expect(rendered.getByTestId('workbench')).toBeTruthy();
  });
});

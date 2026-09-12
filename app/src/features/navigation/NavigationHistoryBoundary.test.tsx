import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { NavigationHistoryBoundary } from './NavigationHistoryBoundary';

describe('NavigationHistoryBoundary', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    useUIStore.setState({ route: 'chat', activeAgentId: null });
    useAuthStore.setState({ projectId: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('canonicalizes initial location with replace and never pushes on mount', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');

    render(<NavigationHistoryBoundary />);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?route=chat');
    expect(push).not.toHaveBeenCalled();
  });

  it('pushes each distinct store-driven route once', () => {
    const push = vi.spyOn(window.history, 'pushState');
    render(<NavigationHistoryBoundary />);

    act(() => useUIStore.getState().setRoute('files'));
    act(() => useUIStore.getState().setRoute('files'));

    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?route=files');
  });

  it('applies popstate route and detail identifiers without writing history', () => {
    render(<NavigationHistoryBoundary />);
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');

    window.history.replaceState(null, '', '/?route=agent-detail&agentId=agt_42');
    replace.mockClear();
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(useUIStore.getState().activeAgentId).toBe('agt_42');
    expect(useUIStore.getState().route).toBe('agent-detail');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not bind the detached Workbench window to main history', () => {
    window.history.replaceState(null, '', '/?workbench=1');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');

    render(<NavigationHistoryBoundary />);
    act(() => useUIStore.getState().setRoute('files'));

    expect(window.location.search).toBe('?workbench=1');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('cleans up its popstate listener under Strict Mode', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const view = render(
      <React.StrictMode>
        <NavigationHistoryBoundary />
      </React.StrictMode>,
    );
    view.unmount();

    const added = add.mock.calls.filter(([name]) => String(name) === 'popstate').length;
    const removed = remove.mock.calls.filter(([name]) => String(name) === 'popstate').length;
    expect(added).toBe(removed);
  });

  it('stays mounted at the persistent workspace shell instead of a route-only page', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const pageRouterSource = readFileSync(
      resolve(process.cwd(), 'src/components/layout/PageRouter.tsx'),
      'utf8',
    );

    expect(appSource).toMatch(/<NavigationHistoryBoundary\s*\/>\s*<AppShell>/u);
    expect(pageRouterSource).not.toContain('<NavigationHistoryBoundary />');
  });
});

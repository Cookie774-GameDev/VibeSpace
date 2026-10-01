import * as React from 'react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ProjectId } from '@/types/common';
import { createRouteHref, parseRouteLocation, type RouteLocation } from './routeSchema';

function currentRelativeHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function locationFromStores(): RouteLocation {
  const ui = useUIStore.getState();
  const auth = useAuthStore.getState();
  return {
    route: ui.route,
    ...(ui.route === 'agent-detail' && ui.activeAgentId ? { agentId: ui.activeAgentId } : {}),
    ...(ui.route === 'project-detail' && auth.projectId ? { projectId: auth.projectId } : {}),
  };
}

function applyRouteLocation(location: RouteLocation): void {
  const ui = useUIStore.getState();
  if (location.route === 'agent-detail' && location.agentId) {
    ui.setActiveAgent(location.agentId);
  }
  if (location.route === 'project-detail' && location.projectId) {
    useAuthStore.getState().setProjectId(location.projectId as ProjectId);
  }
  ui.setRoute(location.route);
}

/**
 * Synchronizes VibeSpace's transient page store with native web history.
 * The detached Workbench window keeps its legacy `?workbench=1` contract and
 * deliberately opts out.
 */
export function NavigationHistoryBoundary(): null {
  React.useEffect(() => {
    const initial = parseRouteLocation(window.location.search);
    if (initial.detachedWorkbench) {
      useUIStore.getState().setRoute('workbench');
      return;
    }

    let applyingPopState = true;
    applyRouteLocation(initial);
    const canonicalInitial = createRouteHref(initial, window.location.href);
    if (canonicalInitial !== currentRelativeHref()) {
      window.history.replaceState(null, '', canonicalInitial);
    }
    applyingPopState = false;

    const writeStoreLocation = () => {
      if (applyingPopState) return;
      const location = locationFromStores();
      const href = createRouteHref(location, window.location.href);
      if (href === currentRelativeHref()) return;
      window.history.pushState(null, '', href);
    };

    const unsubscribeUi = useUIStore.subscribe(writeStoreLocation);
    const unsubscribeAuth = useAuthStore.subscribe(writeStoreLocation);
    const handlePopState = () => {
      applyingPopState = true;
      const location = parseRouteLocation(window.location.search);
      applyRouteLocation(location);
      const canonical = createRouteHref(location, window.location.href);
      if (canonical !== currentRelativeHref()) {
        window.history.replaceState(null, '', canonical);
      }
      applyingPopState = false;
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      unsubscribeUi();
      unsubscribeAuth();
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  return null;
}

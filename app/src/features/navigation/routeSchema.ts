export const APP_ROUTES = [
  'chat',
  'canvas',
  'workbench',
  'preview',
  'browser',
  'terminal',
  'kanban',
  'schedule',
  'agents',
  'model-foundry',
  'agent-detail',
  'project-detail',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'account',
] as const;

export type Route = (typeof APP_ROUTES)[number];

export interface RouteLocation {
  route: Route;
  agentId?: string;
  projectId?: string;
  detachedWorkbench?: boolean;
}

const ROUTE_SET = new Set<string>(APP_ROUTES);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isSafeIdentifier(value: string | null): value is string {
  return Boolean(value && value.length <= 256 && !CONTROL_CHARACTER.test(value));
}

export function parseRouteLocation(search = ''): RouteLocation {
  const params = new URLSearchParams(search);
  if (params.get('workbench') === '1') {
    return { route: 'workbench', detachedWorkbench: true };
  }

  const rawRoute = params.get('route');
  const route: Route = rawRoute && ROUTE_SET.has(rawRoute) ? (rawRoute as Route) : 'chat';

  if (route === 'agent-detail') {
    const agentId = params.get('agentId');
    return isSafeIdentifier(agentId) ? { route, agentId } : { route: 'agents' };
  }
  if (route === 'project-detail') {
    const projectId = params.get('projectId');
    return isSafeIdentifier(projectId) ? { route, projectId } : { route: 'chat' };
  }
  return { route };
}

export function createRouteHref(
  location: RouteLocation,
  currentHref = 'http://localhost/',
): string {
  const url = new URL(currentHref, 'http://localhost/');
  url.searchParams.delete('workbench');
  url.searchParams.delete('agentId');
  url.searchParams.delete('projectId');
  url.searchParams.set('route', location.route);

  const agentId = location.agentId ?? null;
  if (location.route === 'agent-detail' && isSafeIdentifier(agentId)) {
    url.searchParams.set('agentId', agentId);
  }
  const projectId = location.projectId ?? null;
  if (location.route === 'project-detail' && isSafeIdentifier(projectId)) {
    url.searchParams.set('projectId', projectId);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

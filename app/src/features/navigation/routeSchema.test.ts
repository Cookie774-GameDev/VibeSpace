import { describe, expect, it } from 'vitest';
import { APP_ROUTES, createRouteHref, parseRouteLocation, type Route } from './routeSchema';

describe('routeSchema', () => {
  it('round-trips every application route through the canonical query', () => {
    expect(APP_ROUTES).toHaveLength(19);

    for (const route of APP_ROUTES) {
      const href = createRouteHref(
        {
          route,
          ...(route === 'agent-detail' ? { agentId: 'agt_roundtrip' } : {}),
          ...(route === 'project-detail' ? { projectId: 'prj_roundtrip' } : {}),
        },
        'https://app.local/?keep=1#section',
      );
      const parsed = parseRouteLocation(new URL(href, 'https://app.local').search);

      expect(parsed.route).toBe(route);
      expect(href).toContain('keep=1');
      expect(href.endsWith('#section')).toBe(true);
    }
  });

  it('keeps the detached Workbench marker authoritative and non-canonical', () => {
    expect(parseRouteLocation('?workbench=1&route=files')).toEqual({
      route: 'workbench',
      detachedWorkbench: true,
    });
    expect(createRouteHref({ route: 'workbench' }, 'https://app.local/?keep=1')).toBe(
      '/?keep=1&route=workbench',
    );
  });

  it('validates detail identifiers and falls back safely', () => {
    expect(parseRouteLocation('?route=agent-detail&agentId=agt_123')).toEqual({
      route: 'agent-detail',
      agentId: 'agt_123',
    });
    expect(parseRouteLocation('?route=project-detail&projectId=prj_123')).toEqual({
      route: 'project-detail',
      projectId: 'prj_123',
    });
    expect(parseRouteLocation('?route=agent-detail&agentId=%00unsafe')).toEqual({
      route: 'agents',
    });
    expect(parseRouteLocation('?route=project-detail')).toEqual({ route: 'chat' });
  });

  it('removes stale detail identifiers when navigating elsewhere', () => {
    expect(
      createRouteHref(
        { route: 'files' },
        'https://app.local/?agentId=agt_1&projectId=prj_1&keep=1#x',
      ),
    ).toBe('/?keep=1&route=files#x');
  });

  it('exports an exact Route union for route consumers', () => {
    const route: Route = 'model-foundry';
    expect(route).toBe('model-foundry');
  });
});

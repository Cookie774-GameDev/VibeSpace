import { describe, expect, it } from 'vitest';
import type { Route } from '@/stores/ui';
import { SAKURA_ROUTE_INTENSITY, resolveSakuraRouteIntensity } from './routeIntensity';

describe('Sakura route intensity', () => {
  it('uses the frozen route matrix without changing route identity', () => {
    const expected: Record<Route, 'open' | 'standard' | 'quiet'> = {
      chat: 'open',
      agents: 'standard',
      'model-foundry': 'quiet',
      'agent-detail': 'standard',
      'project-detail': 'standard',
      workbench: 'standard',
      kanban: 'standard',
      schedule: 'standard',
      context: 'standard',
      canvas: 'quiet',
      preview: 'quiet',
      browser: 'quiet',
      terminal: 'quiet',
      skills: 'quiet',
      benchmarks: 'quiet',
      history: 'quiet',
      tools: 'quiet',
      files: 'quiet',
      account: 'quiet',
    };

    expect(SAKURA_ROUTE_INTENSITY).toEqual(expected);
    for (const [route, intensity] of Object.entries(expected)) {
      expect(resolveSakuraRouteIntensity(route as Route)).toBe(intensity);
    }
    expect(Object.isFrozen(SAKURA_ROUTE_INTENSITY)).toBe(true);
  });

  it('fails closed to quiet for an unknown future route', () => {
    expect(resolveSakuraRouteIntensity('future-route')).toBe('quiet');
  });
});

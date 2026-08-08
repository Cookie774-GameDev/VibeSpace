export type SakuraRouteIntensity = 'open' | 'standard' | 'quiet';

export const SAKURA_ROUTE_INTENSITY = Object.freeze({
  chat: 'open',
  canvas: 'quiet',
  workbench: 'standard',
  preview: 'quiet',
  browser: 'quiet',
  terminal: 'quiet',
  kanban: 'standard',
  schedule: 'standard',
  agents: 'standard',
  'model-foundry': 'quiet',
  'agent-detail': 'standard',
  'project-detail': 'standard',
  context: 'standard',
  skills: 'quiet',
  benchmarks: 'quiet',
  history: 'quiet',
  tools: 'quiet',
  files: 'quiet',
  account: 'quiet',
} as const satisfies Readonly<Record<string, SakuraRouteIntensity>>);

export function resolveSakuraRouteIntensity(route: string): SakuraRouteIntensity {
  return Object.prototype.hasOwnProperty.call(SAKURA_ROUTE_INTENSITY, route)
    ? SAKURA_ROUTE_INTENSITY[route as keyof typeof SAKURA_ROUTE_INTENSITY]
    : 'quiet';
}

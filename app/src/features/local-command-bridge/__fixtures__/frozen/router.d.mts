import type { LocalRouteResult, LocalDetectedCommand } from '../../types';
export function routeLocalCommand(text: unknown): LocalRouteResult;
export function normalize(text: unknown): string;
export function signature(command: LocalDetectedCommand): string;

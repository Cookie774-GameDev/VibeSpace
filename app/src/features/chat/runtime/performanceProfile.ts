export type PerformanceProfile = 'responsive' | 'balanced' | 'quality';

export interface PerformancePolicy {
  profile: PerformanceProfile;
  directRouteBias: number;
  maxConcurrentChildren: number;
  maxSubcalls: number;
  maxEvidenceBytes: number;
  modelIdPreserved: true;
  effortPreserved: true;
}

export const DEFAULT_PERFORMANCE_PROFILE: PerformanceProfile = 'quality';

const POLICIES: Readonly<Record<PerformanceProfile, PerformancePolicy>> = Object.freeze({
  responsive: Object.freeze({
    profile: 'responsive',
    directRouteBias: 0.85,
    maxConcurrentChildren: 1,
    maxSubcalls: 2,
    maxEvidenceBytes: 64 * 1024,
    modelIdPreserved: true,
    effortPreserved: true,
  }),
  balanced: Object.freeze({
    profile: 'balanced',
    directRouteBias: 0.55,
    maxConcurrentChildren: 2,
    maxSubcalls: 4,
    maxEvidenceBytes: 128 * 1024,
    modelIdPreserved: true,
    effortPreserved: true,
  }),
  quality: Object.freeze({
    profile: 'quality',
    directRouteBias: 0.25,
    maxConcurrentChildren: 2,
    maxSubcalls: 6,
    maxEvidenceBytes: 256 * 1024,
    modelIdPreserved: true,
    effortPreserved: true,
  }),
});

export function performancePolicy(profile: PerformanceProfile): PerformancePolicy {
  return POLICIES[profile];
}

export type PerformanceCommand = {
  kind: 'performance';
  value?: PerformanceProfile | 'status';
};

export function parsePerformanceCommand(input: string): PerformanceCommand | null {
  const tokens = input.trim().toLocaleLowerCase('en-US').split(/\s+/u).filter(Boolean);
  if (tokens[0] !== '/performance' || tokens.length > 2) return null;
  const value = tokens[1];
  if (!value) return { kind: 'performance' };
  if (['responsive', 'balanced', 'quality', 'status'].includes(value)) {
    return { kind: 'performance', value: value as PerformanceProfile | 'status' };
  }
  return null;
}

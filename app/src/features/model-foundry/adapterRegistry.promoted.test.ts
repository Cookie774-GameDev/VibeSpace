import { describe, expect, it, beforeEach } from 'vitest';
import {
  LocalAdapterRegistry,
  canRoutePromotedAdapter,
  listPromotedAdapters,
  promotedAdapterForProject,
} from './adapterRegistry';

const NOW = () => '2026-08-16T00:00:00.000Z';
const MANIFEST = 'b'.repeat(64);

function makeRegistry(): LocalAdapterRegistry {
  return new LocalAdapterRegistry(window.localStorage, NOW);
}

function seed(registry: LocalAdapterRegistry, projectId: string, jobId: string): void {
  registry.upsert(
    projectId,
    jobId,
    {
      projectId,
      jobId,
      manifestSha256: MANIFEST,
      adapterFiles: { 'adapter.safetensors': 'private' },
      metrics: {},
      trainingConfig: {},
    },
    'Test project',
  );
}

function passEvaluation(registry: LocalAdapterRegistry, projectId: string, jobId: string): void {
  registry.recordEvaluation(projectId, jobId, MANIFEST, {
    suite: 'private-dataset-studio',
    caseCount: 1,
    baseScore: 0,
    candidateScore: 1,
    championScore: null,
    delta: 1,
    safetyFailures: [],
    gate: 'pass',
    caseEvidence: [],
  });
}

describe('foundry adapter promotion authority', () => {
  beforeEach(() => window.localStorage.clear());

  it('lists only promoted adapters with a current passing evaluation', () => {
    const registry = makeRegistry();
    seed(registry, 'p1', 'job_ok');
    passEvaluation(registry, 'p1', 'job_ok');
    registry.promote('p1', 'job_ok');
    seed(registry, 'p2', 'job_candidate');

    const promoted = listPromotedAdapters(window.localStorage);
    expect(promoted.map((record) => `${record.projectId}:${record.jobId}`)).toEqual(['p1:job_ok']);
    expect(promotedAdapterForProject(window.localStorage, 'p1')?.jobId).toBe('job_ok');
  });

  it('fails closed when the evaluation gate is blocked or the manifest drifted', () => {
    const registry = makeRegistry();
    seed(registry, 'p3', 'job_blocked');
    registry.recordEvaluation('p3', 'job_blocked', MANIFEST, {
      suite: 'private-dataset-studio',
      caseCount: 1,
      baseScore: 0,
      candidateScore: 0,
      championScore: null,
      delta: 0,
      safetyFailures: [],
      gate: 'blocked',
      caseEvidence: [],
    });
    expect(() => registry.promote('p3', 'job_blocked')).toThrow();
    expect(canRoutePromotedAdapter(window.localStorage, 'p3', 'job_blocked')).toBe(false);

    seed(registry, 'p4', 'job_drift');
    passEvaluation(registry, 'p4', 'job_drift');
    registry.promote('p4', 'job_drift');
    // A re-trained artifact changes the manifest; the stale promotion must stop routing.
    registry.upsert('p4', 'job_drift', {
      projectId: 'p4',
      jobId: 'job_drift',
      manifestSha256: 'c'.repeat(64),
      adapterFiles: { 'adapter.safetensors': 'private' },
      metrics: {},
      trainingConfig: {},
    });
    expect(canRoutePromotedAdapter(window.localStorage, 'p4', 'job_drift')).toBe(false);
    expect(listPromotedAdapters(window.localStorage)).toEqual([]);
  });

  it('rejects malformed storage without throwing', () => {
    window.localStorage.setItem('vibespace.model-foundry.real-adapters.v1', '{not-json');
    expect(listPromotedAdapters(window.localStorage)).toEqual([]);
  });
});

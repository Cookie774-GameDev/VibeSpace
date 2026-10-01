import { describe, expect, it } from 'vitest';
import { canRoutePromotedAdapter, LocalAdapterRegistry, promotedAdapterForProject } from './adapterRegistry';
import { InMemoryStorageAdapter } from './localRepository';

describe('LocalAdapterRegistry', () => {
  it('persists only verified adapter metadata and archives without deleting provenance', () => {
    const registry = new LocalAdapterRegistry(new InMemoryStorageAdapter(), () => '2026-07-14T00:00:00.000Z');
    registry.upsert('project-1', 'job-1', {
      projectId: 'project-1', jobId: 'job-1', manifestSha256: 'a'.repeat(64), adapterFiles: { 'adapter_model.safetensors': 'b'.repeat(64) }, metrics: { eval_loss: 0.25 }, trainingConfig: { method: 'lora' },
    }, 'Invoice Extractor');
    expect(registry.list('project-1')).toMatchObject([{ jobId: 'job-1', projectName: 'Invoice Extractor', status: 'candidate', adapterFileCount: 1 }]);
    expect(registry.archive('project-1', 'job-1')).toMatchObject([{ jobId: 'job-1', status: 'archived' }]);
  });

  it('requires a current passing evaluation before explicit promotion', () => {
    const storage = new InMemoryStorageAdapter();
    const registry = new LocalAdapterRegistry(storage, () => '2026-07-14T00:00:00.000Z');
    const artifact = { projectId: 'project-1', jobId: 'job-1', manifestSha256: 'a'.repeat(64), adapterFiles: { 'adapter_model.safetensors': 'b'.repeat(64) }, metrics: {}, trainingConfig: { method: 'lora' } };
    registry.upsert('project-1', 'job-1', artifact);
    expect(() => registry.promote('project-1', 'job-1')).toThrow(/passing local evaluation/i);
    registry.recordEvaluation('project-1', 'job-1', artifact.manifestSha256, { suite: 'pinned-validation-reference-v1', caseCount: 1, baseScore: 0.2, candidateScore: 0.3, championScore: null, delta: 0.1, safetyFailures: [], gate: 'pass', caseEvidence: [{ caseId: 'case-1', baseScore: 0.2, candidateScore: 0.3, championScore: null, evidenceHash: 'c'.repeat(64) }] });
    expect(registry.promote('project-1', 'job-1')).toMatchObject([{ jobId: 'job-1', status: 'promoted' }]);
    expect(() => registry.archive('project-1', 'job-1')).toThrow(/Promote another/i);
    expect(canRoutePromotedAdapter(storage, 'project-1', 'job-1')).toBe(true);
    expect(promotedAdapterForProject(storage, 'project-1')).toMatchObject({ jobId: 'job-1', status: 'promoted' });
  });

  it('rolls back to the immediately prior passing champion', () => {
    const registry = new LocalAdapterRegistry(new InMemoryStorageAdapter(), () => '2026-07-14T00:00:00.000Z');
    for (const jobId of ['job-1', 'job-2']) {
      const artifact = { projectId: 'project-1', jobId, manifestSha256: jobId[4]!.repeat(64), adapterFiles: { 'adapter_model.safetensors': 'b'.repeat(64) }, metrics: {}, trainingConfig: { method: 'lora' } };
      registry.upsert('project-1', jobId, artifact);
      registry.recordEvaluation('project-1', jobId, artifact.manifestSha256, { suite: 'pinned-validation-reference-v1', caseCount: 1, baseScore: 0.2, candidateScore: 0.3, championScore: null, delta: 0.1, safetyFailures: [], gate: 'pass', caseEvidence: [{ caseId: 'case-1', baseScore: 0.2, candidateScore: 0.3, championScore: null, evidenceHash: 'c'.repeat(64) }] });
      registry.promote('project-1', jobId);
    }
    expect(registry.rollback('project-1')).toMatchObject([{ jobId: 'job-1', status: 'promoted' }, { jobId: 'job-2', status: 'candidate' }]);
  });
});

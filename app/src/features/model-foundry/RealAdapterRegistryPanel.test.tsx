import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RealAdapterRegistryPanel } from './RealAdapterRegistryPanel';
import type { LocalAdapterRecord } from './adapterRegistry';

const legacy: LocalAdapterRecord = { schemaVersion: 1, projectId: 'project', jobId: 'job',
  artifactManifestSha256: 'a'.repeat(64), adapterFileCount: 1, metrics: {}, trainingConfig: {},
  status: 'candidate', verifiedAt: '2026-10-06T00:00:00Z',
  evaluation: { artifactManifestSha256: 'a'.repeat(64), evaluatedAt: '2026-10-06T00:00:00Z',
    report: { suite: 'private-dataset-studio', caseCount: 1, baseScore: 0, candidateScore: 1,
      championScore: null, delta: 1, safetyFailures: [], gate: 'pass',
      caseEvidence: [{ caseId: 'private', hidden: true, baseScore: 0, candidateScore: 1, championScore: null, evidenceHash: 'c'.repeat(64) }] } } };
const actions = { onUse: vi.fn(), onProbe: vi.fn(), onEvaluate: vi.fn(), onPromote: vi.fn(), onArchive: vi.fn() };

describe('candidate-only evaluation display', () => {
  it('does not advertise fabricated comparison, safety, or promotion from a legacy report', () => {
    render(<RealAdapterRegistryPanel records={[legacy]} runtimeReady {...actions} />);
    expect(screen.getByRole('button', { name: 'Approve & promote' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/Safety gate passed/)).toBeNull();
    expect(screen.queryByText(/vs base/)).toBeNull();
    expect(screen.queryByText('0.000')).toBeNull();
    expect(screen.getByText(/Comparison and safety checks were not run/i)).toBeTruthy();
  });
  it('disables chat routing for a persisted legacy promotion without rewriting the record', () => {
    render(<RealAdapterRegistryPanel records={[{ ...legacy, status: 'promoted' }]} runtimeReady {...actions} />);
    expect(screen.getByRole('button', { name: 'Use in chat' }).hasAttribute('disabled')).toBe(true);
    expect(legacy.evaluation?.report.gate).toBe('pass');
  });
  it('shows unmeasured fields in a current candidate report without losing its score', () => {
    const record: LocalAdapterRecord = { ...legacy, evaluation: { ...legacy.evaluation!,
      report: { ...legacy.evaluation!.report, suite: 'private-dataset-candidate-v1', baseScore: null,
        delta: null, candidateScore: 0.5, gate: 'blocked', caseEvidence: [{
          ...legacy.evaluation!.report.caseEvidence[0]!, baseScore: null, candidateScore: 0.5,
        }] } } };
    render(<RealAdapterRegistryPanel records={[record]} runtimeReady {...actions} />);
    expect(screen.getAllByText('0.500')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Approve & promote' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/Safety gate passed/)).toBeNull();
  });
  it('preserves the positive comparative control using synthetic test evidence', () => {
    const record: LocalAdapterRecord = { ...legacy, evaluation: { ...legacy.evaluation!, report: {
      ...legacy.evaluation!.report, suite: 'pinned-validation-reference-v1', baseScore: 0.25,
      candidateScore: 0.75, delta: 0.5,
      caseEvidence: [{ caseId: 'synthetic-comparison', baseScore: 0.25, candidateScore: 0.75,
        championScore: null, evidenceHash: 'c'.repeat(64) }],
    } } };
    render(<RealAdapterRegistryPanel records={[record]} runtimeReady {...actions} />);
    expect(screen.getByRole('button', { name: 'Approve & promote' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/\+0.500 vs base/)).toBeTruthy();
  });
});

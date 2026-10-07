import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { evaluateMock } = vi.hoisted(() => ({ evaluateMock: vi.fn() }));
vi.mock('./nativeBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('./nativeBridge')>(),
  getFoundryTrainingRuntimeStatus: async () => ({ installed: true, qloraInstalled: false, detail: 'Synthetic runtime readiness' }),
  evaluateFoundryArtifact: evaluateMock,
}));
import { FoundryPage } from './FoundryPage';
import { InMemoryStorageAdapter } from './localRepository';
import { LocalAdapterRegistry } from './adapterRegistry';
import type { FoundryArtifactEvaluation } from './nativeBridge';
import { useAuthStore } from '../../stores/auth';

it('requires reviewed private cases without promising an unimplemented validation fallback', () => {
  render(<FoundryPage storage={new InMemoryStorageAdapter()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  expect(screen.queryByText(/Without local cases, the immutable validation split is used/i)).toBeNull();
  expect(screen.getByText(/Add at least one reviewed private case to evaluate/i)).toBeTruthy();
  expect(screen.queryByText(/Optional local reference cases replace/i)).toBeNull();
});

it('persists candidate diagnostics and gives an honest notice without enabling promotion', async () => {
  // Only the native boundary is injected. The real page, controls and registry are exercised.
  const storage = new InMemoryStorageAdapter();
  const registry = new LocalAdapterRegistry(storage, () => '2026-10-06T00:00:00Z');
  registry.upsert('project-1', 'job', { projectId: 'project-1', jobId: 'job', manifestSha256: 'a'.repeat(64),
    adapterFiles: {}, metrics: {}, trainingConfig: {} });
  evaluateMock.mockResolvedValue({ artifactManifestSha256: 'a'.repeat(64), report: {
    suite: 'private-dataset-candidate-v1', caseCount: 1, baseScore: null, candidateScore: 0.5,
    championScore: null, delta: null, gate: 'blocked', safetyFailures: [], caseEvidence: [{
      caseId: 'synthetic-candidate', baseScore: null, candidateScore: 0.5, championScore: null,
      evidenceHash: 'c'.repeat(64),
    }],
  } });
  render(<FoundryPage storage={storage} dependencies={{ clock: () => '2026-10-06T00:00:00Z', idFactory: (kind) => `${kind}-1` }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check training runtime' }));
  await screen.findByText('Synthetic runtime readiness');
  fireEvent.click(screen.getByRole('button', { name: 'Add private case' }));
  fireEvent.change(screen.getByLabelText('Case 1 prompt'), { target: { value: 'Say blue.' } });
  fireEvent.change(screen.getByLabelText('Expected completion'), { target: { value: 'blue sky' } });
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
  expect(await screen.findByText(/Candidate reference-match score: 0.500.*promotion remains blocked/)).toBeTruthy();
  expect(registry.list('project-1')[0]?.evaluation?.report.baseScore).toBeNull();
  expect(screen.getByRole('button', { name: 'Approve & promote' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByText(/versus base/)).toBeNull();
});

const result: FoundryArtifactEvaluation = { artifactManifestSha256: 'a'.repeat(64), report: {
  suite: 'private-dataset-candidate-v1', caseCount: 1, baseScore: null, candidateScore: 0.5,
  championScore: null, delta: null, gate: 'blocked', safetyFailures: [], caseEvidence: [{
    caseId: 'review', baseScore: null, candidateScore: 0.5, championScore: null, evidenceHash: 'c'.repeat(64),
  }],
} };
const artifact = { projectId: 'project-1', jobId: 'old-job', manifestSha256: 'a'.repeat(64), adapterFiles: {}, metrics: {}, trainingConfig: {} };
beforeEach(() => { evaluateMock.mockReset(); });

async function ready(storage: InMemoryStorageAdapter) {
  const counters: Record<string, number> = {};
  const view = render(<FoundryPage storage={storage} dependencies={{ clock: () => '2026-10-06T00:00:00Z', idFactory: (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}` }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check training runtime' }));
  await screen.findByText('Synthetic runtime readiness');
  fireEvent.click(screen.getByRole('button', { name: 'Add private case' }));
  fireEvent.change(screen.getByLabelText('Case 1 prompt'), { target: { value: 'Say blue.' } });
  fireEvent.change(screen.getByLabelText('Expected completion'), { target: { value: 'blue sky' } });
  return view;
}

it('independent F05 preserves the newly selected project when old evaluation resolves', async () => {
  const storage = new InMemoryStorageAdapter();
  const registry = new LocalAdapterRegistry(storage, () => 'now');
  registry.upsert('project-1', 'old-job', artifact);
  let resolve!: (value: FoundryArtifactEvaluation) => void;
  evaluateMock.mockReturnValue(new Promise<FoundryArtifactEvaluation>((done) => { resolve = done; }));
  await ready(storage);
  expect(screen.getByText(/^old-job ·/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
  await waitFor(() => expect(evaluateMock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  expect(screen.queryByText(/^old-job ·/)).toBeNull();
  await act(async () => { resolve(result); await Promise.resolve(); });
  expect(screen.queryByText(/^old-job ·/)).toBeNull();
  expect(screen.queryByText(/Candidate reference-match score:/)).toBeNull();
});

it('independent F05 does not use a revoked legacy false-pass record as comparison authority', async () => {
  const storage = new InMemoryStorageAdapter();
  const registry = new LocalAdapterRegistry(storage, () => 'now');
  const candidate = registry.upsert('project-1', 'old-job', artifact);
  storage.setItem('vibespace.model-foundry.real-adapters.v1', JSON.stringify([candidate, {
    ...candidate, jobId: 'legacy-job', status: 'promoted', evaluation: {
      artifactManifestSha256: artifact.manifestSha256, evaluatedAt: 'then', report: {
        ...result.report, suite: 'private-dataset-studio', baseScore: 0, delta: 1, candidateScore: 1, gate: 'pass',
      },
    },
  }]));
  evaluateMock.mockResolvedValue(result);
  await ready(storage);
  fireEvent.click(screen.getAllByRole('button', { name: 'Evaluate' })[0]!);
  await waitFor(() => expect(evaluateMock).toHaveBeenCalledTimes(1));
  expect(evaluateMock.mock.calls[0]![0]).toMatchObject({ projectId: 'project-1', jobId: 'old-job' });
  expect(evaluateMock.mock.calls[0]![0].championJobId).toBeUndefined();
  expect(registry.list('project-1').find((entry) => entry.jobId === 'legacy-job')?.evaluation?.report.gate).toBe('pass');
});

it('retains a genuinely eligible synthetic champion request and its truthful unsupported error', async () => {
  const storage = new InMemoryStorageAdapter();
  const registry = new LocalAdapterRegistry(storage, () => 'now');
  registry.upsert('project-1', 'old-job', artifact);
  registry.upsert('project-1', 'champion-job', { ...artifact, jobId: 'champion-job' });
  // Synthetic comparative fixture, not a real model evaluation or promotion claim.
  registry.recordEvaluation('project-1', 'champion-job', artifact.manifestSha256, {
    ...result.report, suite: 'pinned-validation-reference-v1', baseScore: 0.25,
    candidateScore: 0.5, delta: 0.25, gate: 'pass', caseEvidence: [{
      caseId: 'synthetic', baseScore: 0.25, candidateScore: 0.5, championScore: null, evidenceHash: 'c'.repeat(64),
    }],
  });
  registry.promote('project-1', 'champion-job');
  evaluateMock.mockRejectedValue(new Error('Champion comparison is not available in the current local evaluator.'));
  await ready(storage);
  fireEvent.click(screen.getAllByRole('button', { name: 'Evaluate' })[0]!);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Champion comparison is not available in the current local evaluator.');
  expect(evaluateMock.mock.calls[0]![0].championJobId).toBe('champion-job');
  expect(registry.list('project-1').find((entry) => entry.jobId === 'old-job')?.evaluation).toBeUndefined();
});

async function pendingEvaluation() {
  const storage = new InMemoryStorageAdapter();
  const registry = new LocalAdapterRegistry(storage, () => 'now');
  registry.upsert('project-1', 'old-job', artifact);
  let resolve!: (value: FoundryArtifactEvaluation) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FoundryArtifactEvaluation>((done, fail) => { resolve = done; reject = fail; });
  evaluateMock.mockReturnValue(promise);
  const view = await ready(storage);
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
  await waitFor(() => expect(evaluateMock).toHaveBeenCalledTimes(1));
  return { storage, registry, resolve, reject, promise, view };
}

describe('pending evaluation lifetime and scope', () => {
  type Auth = ReturnType<typeof useAuthStore.getState>;
  beforeEach(() => useAuthStore.setState({ cloudSession: null, localUserId: 'account-a',
    workspaceId: 'workspace-a' as Auth['workspaceId'], projectId: 'app-project-a' as Auth['projectId'] }));

  it.each(['account', 'workspace', 'project'] as const)('revokes a batched %s round trip before persistence', async (scope) => {
    const pending = await pendingEvaluation();
    act(() => {
      if (scope === 'account') {
        useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' });
      } else if (scope === 'workspace') {
        useAuthStore.setState({ workspaceId: 'workspace-b' as Auth['workspaceId'] }); useAuthStore.setState({ workspaceId: 'workspace-a' as Auth['workspaceId'] });
      } else {
        useAuthStore.setState({ projectId: 'app-project-b' as Auth['projectId'] }); useAuthStore.setState({ projectId: 'app-project-a' as Auth['projectId'] });
      }
    });
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation).toBeUndefined();
    expect(screen.queryByText(/Candidate reference-match score:/)).toBeNull();
  });

  it('revokes a Foundry project leave/reopen round trip', async () => {
    const pending = await pendingEvaluation();
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    const saved = screen.getAllByRole('button', { name: /VibeCoder/ }).find((button) => button.hasAttribute('aria-pressed'));
    expect(saved).toBeTruthy(); fireEvent.click(saved!);
    expect(screen.getByText(/^old-job ·/)).toBeTruthy();
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation).toBeUndefined();
  });

  it('does not persist a late success after unmount', async () => {
    const pending = await pendingEvaluation(); pending.view.unmount();
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation).toBeUndefined();
  });

  it('does not publish a late error into a different project', async () => {
    const pending = await pendingEvaluation();
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    await act(async () => {
      pending.reject(new Error('Old evaluation failed'));
      await expect(pending.promise).rejects.toThrow('Old evaluation failed');
    });
    expect(screen.queryByText('Old evaluation failed')).toBeNull();
  });

  it('retains unchanged scope as a positive control', async () => {
    const pending = await pendingEvaluation();
    act(() => useAuthStore.setState({ localUserId: 'account-a' }));
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation?.report).toEqual(result.report);
    expect(screen.getByText(/Candidate reference-match score:/)).toBeTruthy();
  });

  it('does not attach a late report to an archived candidate', async () => {
    const pending = await pendingEvaluation();
    act(() => { pending.registry.archive('project-1', 'old-job'); });
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]).toMatchObject({ status: 'archived' });
    expect(pending.registry.list('project-1')[0]?.evaluation).toBeUndefined();
  });

  it('rejects a changed artifact at the page publication boundary', async () => {
    const pending = await pendingEvaluation();
    act(() => { pending.registry.upsert('project-1', 'old-job', { ...artifact, manifestSha256: 'b'.repeat(64) }); });
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toMatch(/changed during evaluation/);
  });

  it('keeps the newer evaluation when an older request finishes last', async () => {
    const pending = await pendingEvaluation();
    const newer = { ...result, report: { ...result.report, candidateScore: 0.75 } };
    evaluateMock.mockResolvedValue(newer);
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
    await screen.findByText(/Candidate reference-match score: 0.750/);
    await act(async () => { pending.resolve(result); await Promise.resolve(); });
    expect(pending.registry.list('project-1')[0]?.evaluation?.report.candidateScore).toBe(0.75);
  });
});

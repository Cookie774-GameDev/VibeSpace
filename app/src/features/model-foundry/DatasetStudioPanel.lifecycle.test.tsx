import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { teacher } = vi.hoisted(() => ({ teacher: vi.fn() }));
vi.mock('./nativeBridge', async (original) => ({
  ...await original<typeof import('./nativeBridge')>(), generateFromFoundryArtifact: teacher,
}));
import { DatasetStudioPanel } from './DatasetStudioPanel';
import * as dataset from './datasetStudio';
import { LocalAdapterRegistry } from './adapterRegistry';
import { useAuthStore } from '../../stores/auth';

const NOW = '2026-10-06T21:30:00Z';
const hash = 'a'.repeat(64);
const released: (() => void)[] = [];
const builds: Promise<unknown>[] = [];
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function stage(input = 'What is the cobalt otter index?', output = '47') {
  fireEvent.change(screen.getByLabelText('Input'), { target: { value: input } });
  fireEvent.change(screen.getByLabelText('Expected output'), { target: { value: output } });
  fireEvent.click(screen.getByRole('button', { name: 'Add approved example' }));
}
function holdRealHash() {
  const gate = defer<void>(); released.push(() => gate.resolve());
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hashSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
    await gate.promise; return digest(...args);
  });
  const realBuild = dataset.buildDatasetVersion;
  const buildSpy = vi.spyOn(dataset, 'buildDatasetVersion').mockImplementation((...args) => {
    const result = realBuild(...args); builds.push(result); return result;
  });
  return { hashSpy, buildSpy, finish: async () => {
    await act(async () => { gate.resolve(); await Promise.allSettled(builds); });
  } };
}
function seedTeacher() {
  const registry = new LocalAdapterRegistry(localStorage, () => NOW);
  registry.upsert('project-a', 'teacher', { projectId: 'project-a', jobId: 'teacher', manifestSha256: hash,
    adapterFiles: {}, metrics: {}, trainingConfig: {} });
  // Synthetic comparative fixture only; no model inference or promotion is claimed.
  registry.recordEvaluation('project-a', 'teacher', hash, { suite: 'pinned-validation-reference-v1',
    caseCount: 1, baseScore: 0.25, candidateScore: 0.75, championScore: null, delta: 0.5,
    gate: 'pass', safetyFailures: [], caseEvidence: [{ caseId: 'fixture', baseScore: 0.25,
      candidateScore: 0.75, championScore: null, evidenceHash: 'b'.repeat(64) }] });
  registry.promote('project-a', 'teacher');
  return registry;
}
beforeEach(() => { teacher.mockReset(); localStorage.clear(); released.length = 0; builds.length = 0; });
afterEach(async () => {
  await act(async () => { released.forEach((release) => release()); await Promise.allSettled(builds); });
  vi.restoreAllMocks();
});

describe('Dataset Studio joined version lifecycle', () => {
  it('uses the actual parser/hash builder to retry malformed input and exclude duplicates/quarantine', async () => {
    const onVersion = vi.fn(); render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    fireEvent.change(screen.getByLabelText('Selected import content'), { target: { value: '{broken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage import' }));
    expect(screen.getByText('No approved examples to preview.')).toBeTruthy();
    const content = [{ input: 'clean input', output: 'clean answer' }, { input: 'clean input', output: 'clean answer' },
      { input: 'password=synthetic123', output: 'quarantined example' }].map((row) => JSON.stringify(row)).join('\n');
    fireEvent.change(screen.getByLabelText('Selected import content'), { target: { value: content } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage import' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(onVersion).toHaveBeenCalledOnce());
    const manifest = onVersion.mock.calls[0]![0];
    expect(manifest.examples).toHaveLength(1);
    expect(manifest.examples[0]).toMatchObject({ input: 'clean input', expectedOutput: 'clean answer',
      source: { kind: 'jsonl', reference: 'local-selected-jsonl#1', approved: true }, consent: { approved: true }, split: 'train' });
    expect(manifest.excludedExampleIds).toHaveLength(1);
    expect(manifest.splitStrategy.statistics).toEqual({ train: 1, validation: 0, test: 0 });
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('synthetic123');
  });

  it('revokes an in-progress hash build when consent is withdrawn and restored', async () => {
    const onVersion = vi.fn(); render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    stage(); fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    const held = holdRealHash(); fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(held.hashSpy).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    await held.finish(); expect(onVersion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(onVersion).toHaveBeenCalledOnce());
  });

  it('requires fresh consent when the selected review queue changes during hashing', async () => {
    const onVersion = vi.fn(); render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    stage(); fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    const held = holdRealHash(); fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(held.hashSpy).toHaveBeenCalled());
    stage('A second reviewed input.', 'A different response.');
    expect((screen.getByRole('checkbox', { name: 'Approve dataset consent' }) as HTMLInputElement).checked).toBe(false);
    await held.finish(); expect(onVersion).not.toHaveBeenCalled();
  });

  it.each(['project', 'lineage', 'unmount'] as const)('does not publish a hash result after %s changes', async (change) => {
    const onVersion = vi.fn(); const view = render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    stage(); fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    const held = holdRealHash(); fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(held.hashSpy).toHaveBeenCalled());
    if (change === 'unmount') view.unmount();
    else view.rerender(<DatasetStudioPanel projectId={change === 'project' ? 'project-b' : 'project-a'}
      version={change === 'lineage' ? 2 : 1} parentVersionId={change === 'lineage' ? 'other-v1' : null} now={() => NOW} onVersion={onVersion} />);
    await held.finish(); expect(onVersion).not.toHaveBeenCalled();
  });

  it('revokes a pending hash result on an account round trip even when the local draft stays visible', async () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'dataset-owner-a' });
    const onVersion = vi.fn(); render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    stage(); fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    const held = holdRealHash(); fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(held.hashSpy).toHaveBeenCalled());
    act(() => { useAuthStore.setState({ localUserId: 'dataset-owner-b' }); useAuthStore.setState({ localUserId: 'dataset-owner-a' }); });
    await held.finish(); expect(onVersion).not.toHaveBeenCalled();
  });

  it('can retry a terminal hashing failure with the same approved queue', async () => {
    const onVersion = vi.fn(); render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={onVersion} />);
    stage(); fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('Synthetic hashing failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    expect(await screen.findByText('Synthetic hashing failure')).toBeTruthy();
    expect(onVersion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(onVersion).toHaveBeenCalledOnce());
    expect(onVersion.mock.calls[0]![0].examples[0].input).toBe('What is the cobalt otter index?');
  });

  it('keeps duplicate provenance and fingerprint independent of hash completion order', async () => {
    const content = [{ input: 'Hello blue', output: 'Answer' }, { input: ' hello   blue ', output: 'Answer' },
      ...Array.from({ length: 12 }, (_, index) => ({ input: `Fixture review ${index}`, output: `Target ${index}` }))]
      .map((row) => JSON.stringify(row)).join('\n');
    const enter = () => {
      fireEvent.change(screen.getByLabelText('Selected import content'), { target: { value: content } });
      fireEvent.click(screen.getByRole('button', { name: 'Stage import' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
    };
    const baseline = vi.fn();
    const first = render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={baseline} />);
    enter(); fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(baseline).toHaveBeenCalledOnce());
    expect(baseline.mock.calls[0]![0].examples).toHaveLength(13);
    expect(baseline.mock.calls[0]![0].examples[0].source.reference).toBe('local-selected-jsonl#1');
    first.unmount();
    const reordered = vi.fn();
    render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={reordered} />);
    enter(); const held = holdRealHash();
    fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
    await waitFor(() => expect(held.hashSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => { await held.hashSpy.mock.results[1]!.value; await Promise.resolve(); });
    await held.finish();
    expect(reordered).toHaveBeenCalledOnce();
    expect(reordered.mock.calls[0]![0].fingerprint).toBe(baseline.mock.calls[0]![0].fingerprint);
    expect(reordered.mock.calls[0]![0].splitStrategy).toEqual(baseline.mock.calls[0]![0].splitStrategy);
    expect(reordered.mock.calls[0]![0].examples).toEqual(baseline.mock.calls[0]![0].examples);
  });
});

describe('Dataset Studio teacher draft lifetime', () => {
  it.each(['input', 'approval', 'project'] as const)('does not apply a teacher reply after the %s changes', async (change) => {
    seedTeacher(); const pending = defer<{ text: string; inputTokens: number; outputTokens: number; artifactManifestSha256: string }>();
    teacher.mockReturnValue(pending.promise);
    const view = render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Original approved seed.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    await waitFor(() => expect(teacher).toHaveBeenCalledOnce());
    if (change === 'input') fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'New unrelated seed.' } });
    else if (change === 'approval') {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    } else view.rerender(<DatasetStudioPanel projectId="project-b" now={() => NOW} onVersion={() => undefined} />);
    await act(async () => { pending.resolve({ text: 'Old teacher target.', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash }); await pending.promise; });
    expect((screen.getByLabelText('Expected output') as HTMLTextAreaElement).value).not.toBe('Old teacher target.');
  });

  it('does not use a teacher whose promotion evidence was revoked while inference was pending', async () => {
    const registry = seedTeacher(); const pending = defer<{ text: string; inputTokens: number; outputTokens: number; artifactManifestSha256: string }>();
    teacher.mockReturnValue(pending.promise);
    render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Approved seed.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    await waitFor(() => expect(teacher).toHaveBeenCalledOnce());
    const prior = registry.list('project-a')[0]!.evaluation!.report;
    registry.recordEvaluation('project-a', 'teacher', hash, { ...prior, gate: 'blocked' });
    await act(async () => { pending.resolve({ text: 'Revoked teacher target.', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash }); await pending.promise; });
    expect((screen.getByLabelText('Expected output') as HTMLTextAreaElement).value).toBe('');
  });

  it('signals cancellation, waits for the old teacher to settle, and permits an explicitly approved retry', async () => {
    seedTeacher(); const pending = defer<{ text: string; inputTokens: number; outputTokens: number; artifactManifestSha256: string }>();
    teacher.mockReturnValueOnce(pending.promise);
    render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'First seed.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    const originalSignal = teacher.mock.calls[0]![0].signal as AbortSignal;
    expect(originalSignal.aborted).toBe(false);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Second seed.' } });
    expect(originalSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    expect(screen.getByRole('button', { name: 'Drafting locally…' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { pending.resolve({ text: 'Stale output.', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash }); await pending.promise; });
    teacher.mockResolvedValueOnce({ text: 'Fresh output.', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash });
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    await waitFor(() => expect((screen.getByLabelText('Expected output') as HTMLTextAreaElement).value).toBe('Fresh output.'));
    expect(teacher).toHaveBeenCalledTimes(2);
    expect(teacher.mock.calls[1]![0].prompt).toContain('Second seed.');
  });

  it('keeps generated secrets quarantined and permits a clean retry without auto-staging', async () => {
    seedTeacher(); teacher.mockResolvedValueOnce({ text: 'password=synthetic123', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash });
    render(<DatasetStudioPanel projectId="project-a" now={() => NOW} onVersion={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Input'), { target: { value: 'Approved seed.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approve local teacher draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    expect(await screen.findByText(/Local teacher output was quarantined/)).toBeTruthy();
    expect((screen.getByLabelText('Expected output') as HTMLTextAreaElement).value).toBe('');
    teacher.mockResolvedValueOnce({ text: 'Reviewed target.', inputTokens: 1, outputTokens: 1, artifactManifestSha256: hash });
    fireEvent.click(screen.getByRole('button', { name: 'Draft with promoted adapter' }));
    await waitFor(() => expect((screen.getByLabelText('Expected output') as HTMLTextAreaElement).value).toBe('Reviewed target.'));
    expect(screen.getByText('No approved examples to preview.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Approve dataset consent' }) as HTMLInputElement).checked).toBe(false);
  });
});

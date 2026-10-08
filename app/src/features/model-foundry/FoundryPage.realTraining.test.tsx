import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('../../lib/utils', async (original) => ({
  ...await original<typeof import('../../lib/utils')>(), isTauri: true,
}));

import { FoundryPage } from './FoundryPage';
import { InMemoryStorageAdapter } from './localRepository';
import { LocalAdapterRegistry } from './adapterRegistry';
import { useAuthStore } from '../../stores/auth';

type NativeJob = ReturnType<typeof nativeJob>;
const NOW = '2026-10-08T03:00:00Z';
let receive: ((event: { payload: NativeJob }) => void) | undefined;
let jobs: NativeJob[];
let start: () => Promise<NativeJob>;
let cancel: () => Promise<NativeJob>;
let runtime: () => Promise<Record<string, unknown>>;
function nativeJob(overrides: Partial<{ id: string; projectId: string; status: string; progress: number;
  artifactVerified: boolean; error: string | null }> = {}) {
  return { id: 'job_native_1', projectId: 'project-1', name: 'Synthetic trained model',
    baseModelId: 'smollm2-135m-instruct', method: 'lora', status: 'queued', progress: 0,
    artifactPath: '/synthetic/jobs/job_native_1/weight-artifact', artifactSha256: 'a'.repeat(64),
    artifactVerified: false, storageBytes: 24, sourceCount: 12, version: 1,
    resumeAvailable: false, error: null as string | null, createdAt: NOW, updatedAt: NOW, ...overrides };
}
function emit(job: NativeJob) { jobs = [job]; receive?.({ payload: job }); }
function storedRun(storage: InMemoryStorageAdapter) {
  return JSON.parse(storage.getItem('vibespace.model-foundry.native-runs.v1') ?? '{}')['project-1'];
}
function startedCalls() { return invokeMock.mock.calls.filter(([name]) => name === 'model_foundry_start_training'); }

beforeEach(() => {
  receive = undefined; jobs = []; cancel = async () => nativeJob({ status: 'cancelled' });
  runtime = async () => ({ installed: true, attested: true, methods: ['full', 'lora'],
    modalities: ['text'], precisions: ['bf16'], protocol: 2, reason: null });
  start = async () => { const job = nativeJob(); jobs = [job]; return job; };
  invokeMock.mockReset(); listenMock.mockReset();
  listenMock.mockImplementation(async (name, listener) => {
    if (name === 'model-foundry:job-updated') receive = listener;
    return vi.fn();
  });
  invokeMock.mockImplementation(async (name) => {
    if (name === 'model_foundry_training_worker_status') return runtime();
    if (name === 'model_foundry_download_model') return { modelId: 'smollm2-135m-instruct',
      sizeBytes: 100, files: [], resumed: false, path: '/synthetic/base', manifestPath: '/synthetic/manifest' };
    if (name === 'model_foundry_start_training') return start();
    if (name === 'model_foundry_list_jobs') return jobs;
    if (name === 'model_foundry_cancel_job') return cancel();
    throw new Error(`Unassigned synthetic IPC: ${name}`);
  });
  type Auth = ReturnType<typeof useAuthStore.getState>;
  useAuthStore.setState({ cloudSession: null, localUserId: 'account-a',
    workspaceId: 'workspace-a' as Auth['workspaceId'], projectId: 'app-project-a' as Auth['projectId'] });
});
afterEach(cleanup);

async function ready() {
  const storage = new InMemoryStorageAdapter();
  const counts: Record<string, number> = {};
  const view = render(<FoundryPage storage={storage} dependencies={{ clock: () => NOW,
    idFactory: (kind) => `${kind}-${counts[kind] = (counts[kind] ?? 0) + 1}` }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  await prepareCurrentProject();
  await waitFor(() => expect(receive).toBeTypeOf('function'));
  return { storage, view, registry: new LocalAdapterRegistry(storage, () => NOW) };
}

async function prepareCurrentProject() {
  fireEvent.click(screen.getByRole('button', { name: 'Open Dataset Studio' }));
  const rows = Array.from({ length: 20 }, (_, i) => JSON.stringify({
    input: `Synthetic record number ${i + 1}: return its identifier.`, expectedOutput: `record-${i + 1}`,
  })).join('\n');
  fireEvent.change(screen.getByLabelText('Selected import content'), { target: { value: rows } });
  fireEvent.click(screen.getByRole('button', { name: 'Stage import' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Approve dataset consent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create immutable dataset v1' }));
  await screen.findByRole('region', { name: 'Saved dataset examples' });
  fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Download and verify model' }));
  await screen.findByText(/Verified 0 MB offline model snapshot/);
}

describe('real Studio native job lifecycle', () => {
  it('adopts the returned native ID and uses it for cancellation', async () => {
    const { storage } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('model_foundry_cancel_job', { jobId: 'job_native_1' }));
  });

  it('consumes the actual native terminal payload and registers the exact artifact once', async () => {
    const { registry } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    const complete = nativeJob({ status: 'completed', progress: 100, artifactVerified: true });
    await act(async () => { emit(complete); emit(complete); });
    await screen.findByText('Candidate ID: project-1--job_native_1');
    expect(registry.list('project-1')).toHaveLength(1);
    expect(registry.list('project-1')[0]).toMatchObject({ jobId: 'job_native_1', status: 'candidate' });
    expect(screen.queryByText('10000%')).toBeNull();
  });

  it('retains a terminal event that arrives before the start acknowledgment', async () => {
    let acknowledge!: (job: NativeJob) => void;
    start = () => new Promise((resolve) => { acknowledge = resolve; });
    const { storage, registry } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    await act(async () => {
      emit(nativeJob({ status: 'completed', progress: 100, artifactVerified: true }));
      acknowledge(nativeJob());
    });
    await waitFor(() => expect(registry.list('project-1')).toHaveLength(1));
    expect(storedRun(storage)).toMatchObject({ jobId: 'job_native_1', phase: 'completed', terminal: true });
  });

  it('does not register an unsolicited terminal event from another project', async () => {
    const { registry } = await ready();
    await act(async () => { emit(nativeJob({ id: 'job_foreign', projectId: 'project-foreign',
      status: 'completed', progress: 100, artifactVerified: true })); });
    expect(registry.list('project-foreign')).toHaveLength(0);
    expect(registry.list('project-1')).toHaveLength(0);
  });
});


describe('native training lifetime boundaries', () => {
  it('deduplicates clicks while the real runtime prerequisite is still pending', async () => {
    const { storage } = await ready();
    let release!: (value: Record<string, unknown>) => void;
    runtime = () => new Promise((resolve) => { release = resolve; });
    const button = screen.getByRole('button', { name: 'Start real training' });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => { release({ installed: true, attested: true, methods: ['full', 'lora'] }); });
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    expect(startedCalls()).toHaveLength(1);
  });

  it('keeps failed native completion terminal and never registers an artifact', async () => {
    const { storage, registry } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    await act(async () => { emit(nativeJob({ status: 'failed', progress: 35, error: 'Synthetic worker failed' })); });
    expect(storedRun(storage)).toMatchObject({ phase: 'failed', terminal: true, progress: 0.35, detail: 'Synthetic worker failed' });
    expect(registry.list('project-1')).toHaveLength(0);
  });

  it('ignores older progress after a native terminal result', async () => {
    const { storage } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    await act(async () => { emit(nativeJob({ status: 'completed', progress: 100, artifactVerified: true })); });
    await screen.findByText('Candidate ID: project-1--job_native_1');
    await act(async () => { emit(nativeJob({ status: 'training', progress: 35 })); });
    expect(storedRun(storage)).toMatchObject({ phase: 'completed', progress: 1, terminal: true });
  });

  it('keeps a late start acknowledgment under its original project without replacing the new view', async () => {
    let acknowledge!: (job: NativeJob) => void;
    start = () => new Promise((resolve) => { acknowledge = resolve; });
    const { storage } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    await act(async () => { acknowledge(nativeJob()); });
    const saved = JSON.parse(storage.getItem('vibespace.model-foundry.native-runs.v1') ?? '{}');
    expect(saved['project-1']?.jobId).toBe('job_native_1');
    expect(saved['project-2']).toBeUndefined();
    expect(screen.queryByText('Native training job accepted.')).toBeNull();
  });

  it('revokes a late acknowledgment across an account round trip', async () => {
    let acknowledge!: (job: NativeJob) => void;
    start = () => new Promise((resolve) => { acknowledge = resolve; });
    const { storage, registry } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    act(() => { useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' }); });
    await act(async () => { acknowledge(nativeJob()); emit(nativeJob({ status: 'completed', progress: 100, artifactVerified: true })); });
    expect(storedRun(storage)).toBeUndefined();
    expect(registry.list('project-1')).toHaveLength(0);
  });

  it('suppresses a late prerequisite failure after selecting another project', async () => {
    const { storage } = await ready();
    let reject!: (error: Error) => void;
    runtime = () => new Promise((_resolve, fail) => { reject = fail; });
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(reject).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    await act(async () => { reject(new Error('Old project runtime failure')); });
    expect(screen.queryByText('Old project runtime failure')).toBeNull();
    expect(storedRun(storage)).toBeUndefined();
  });

  it('does not apply a late cancellation acknowledgment to a newer project run', async () => {
    const { storage } = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    let acknowledge!: (value: NativeJob) => void;
    cancel = () => new Promise((resolve) => { acknowledge = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
    await waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
    await prepareCurrentProject();
    start = async () => { const job = nativeJob({ id: 'job_native_2', projectId: 'project-2' }); jobs = [job]; return job; };
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(2));
    await waitFor(() => expect(JSON.parse(storage.getItem('vibespace.model-foundry.native-runs.v1') ?? '{}')['project-2']?.jobId).toBe('job_native_2'));
    await act(async () => { emit(nativeJob({ id: 'job_native_2', projectId: 'project-2', status: 'training', progress: 35 })); });
    await screen.findByText('35%');
    await act(async () => { acknowledge(nativeJob({ status: 'cancelled' })); });
    expect(screen.queryByText('Cancellation requested; the worker will stop safely.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disposes a listener whose subscription completes after unmount', async () => {
    let resolve!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    listenMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<FoundryPage storage={new InMemoryStorageAdapter()} />);
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    view.unmount();
    await act(async () => { resolve(unlisten); });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe('native readback versus live-event ordering', () => {
  it('does not regress newer training progress when an older queued readback resolves last', async () => {
    const { storage } = await ready();
    const normalInvoke = invokeMock.getMockImplementation()!;
    let finishReadback!: (value: NativeJob[]) => void;
    invokeMock.mockImplementation((name, ...args) => name === 'model_foundry_list_jobs'
      ? new Promise((resolve) => { finishReadback = resolve; })
      : normalInvoke(name, ...args));
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(finishReadback).toBeTypeOf('function'));
    const oldQueuedSnapshot = nativeJob();
    await act(async () => { emit(nativeJob({ status: 'training', progress: 35 })); });
    expect(storedRun(storage)).toMatchObject({ phase: 'training', progress: 0.35 });
    await act(async () => { finishReadback([oldQueuedSnapshot]); });
    expect(storedRun(storage)).toMatchObject({ phase: 'training', progress: 0.35 });
    expect(screen.queryByText('0%')).toBeNull();
  });
});

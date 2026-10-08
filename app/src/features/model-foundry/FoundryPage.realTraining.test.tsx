import { createHash } from 'node:crypto';
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
let catalog: ReturnType<typeof catalogModel>[];
let downloadModel: () => Promise<ReturnType<typeof catalogModel>>;
function catalogModel(ready = false) {
  return { id: 'smollm2-135m-instruct', label: 'SmolLM2 135M Instruct',
    sourceId: 'HuggingFaceTB/SmolLM2-135M-Instruct', revision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
    license: 'apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0', gated: false,
    parametersB: 0.135, downloadBytes: 272437573, expectedRamGb: 4, expectedVramGb: 2,
    contextTokens: 8192, precision: 'BF16 safetensors', modalities: ['text'], speed: 'fast',
    quality: 'efficient', cpuPractical: true, installed: ready, verified: ready,
    installedBytes: ready ? 272437573 : 0, status: ready ? 'ready' : 'not-installed', localOnly: true };
}
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
  catalog = [catalogModel()]; downloadModel = async () => { catalog = [catalogModel(true)]; return catalog[0]!; };
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
    if (name === 'model_foundry_training_catalog') return catalog;
    if (name === 'model_foundry_download_training_model') return downloadModel();
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

async function ready(skipDownload = false) {
  const storage = new InMemoryStorageAdapter();
  const counts: Record<string, number> = {};
  const view = render(<FoundryPage storage={storage} dependencies={{ clock: () => NOW,
    idFactory: (kind) => `${kind}-${counts[kind] = (counts[kind] ?? 0) + 1}` }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
  await prepareCurrentProject(skipDownload);
  await waitFor(() => expect(receive).toBeTypeOf('function'));
  return { storage, view, registry: new LocalAdapterRegistry(storage, () => NOW) };
}

async function prepareCurrentProject(skipDownload = false) {
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
  fireEvent.click(screen.getByRole('button', { name: 'Check training runtime' }));
  await screen.findByText(/Local training runtime is installed\.|Full ready; LoRA unavailable\./);
  if (!skipDownload) {
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download and verify model' }));
    await screen.findByText(/Verified .* (?:offline model|native training) snapshot/);
  }
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


describe('canonical Studio runtime and model services', () => {
  it('shows the canonical training catalog revision instead of the old standalone snapshot', async () => {
    await ready();
    expect(screen.getByText('Revision 12fd25f77366fa6b3b4b768ec3050bf629380bac')).toBeTruthy();
    expect(screen.queryByText('Revision a91318be21aeaf0879874faa161dcb40c68847e9')).toBeNull();
  });

  it('uses only the canonical training-model download command', async () => {
    await ready();
    expect(invokeMock).toHaveBeenCalledWith('model_foundry_download_training_model', { modelId: 'smollm2-135m-instruct' });
    expect(invokeMock.mock.calls.some(([command]) => command === 'model_foundry_download_model')).toBe(false);
  });

  it('reuses a ready canonical base without starting another download', async () => {
    catalog = [catalogModel(true)];
    const { storage } = await ready(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    expect(invokeMock.mock.calls.some(([command]) => /download.*model/.test(String(command)))).toBe(false);
  });

  it('keeps Start disabled after a Full-only probe when Studio selected LoRA', async () => {
    runtime = async () => ({ installed: true, attested: true, methods: ['full'],
      reason: 'Full ready; LoRA unavailable.' });
    await ready();
    expect(screen.getByRole('button', { name: 'Start real training' })).toHaveProperty('disabled', true);
    expect(startedCalls()).toHaveLength(0);
  });
  it('rejects a download receipt for a different canonical revision', async () => {
    await ready(true);
    downloadModel = async () => ({ ...catalogModel(true), revision: 'a'.repeat(40) });
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Download and verify model' }));
    await screen.findByText('The native training snapshot does not match the approved model revision.');
    expect(screen.getByRole('button', { name: 'Start real training' })).toHaveProperty('disabled', true);
    expect(screen.queryByText(/Verified .* native training snapshot/)).toBeNull();
  });

  it('keeps downloads and training disabled when the native catalog lacks the selected model', async () => {
    catalog = [];
    await ready(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    expect(screen.getByRole('button', { name: 'Download and verify model' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Start real training' })).toHaveProperty('disabled', true);
  });

  it('keeps QLoRA disabled when only core and LoRA are attested', async () => {
    await ready();
    fireEvent.change(screen.getByRole('combobox', { name: 'Method' }), { target: { value: 'qlora' } });
    expect(screen.getByRole('button', { name: 'Start real training' })).toHaveProperty('disabled', true);
  });

  it.each(['model round trip', 'project change', 'account round trip'] as const)(
    'ignores late canonical download success after a %s', async (boundary) => {
      await ready(true);
      let finish!: (value: ReturnType<typeof catalogModel>) => void;
      downloadModel = () => new Promise((resolve) => { finish = resolve; });
      fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Download and verify model' }));
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      if (boundary === 'model round trip') {
        fireEvent.click(screen.getByRole('button', { name: /Fixture Base/ }));
        fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
      } else if (boundary === 'project change') {
        fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
        fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
      } else {
        act(() => { useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' }); });
      }
      await act(async () => { finish(catalogModel(true)); });
      expect(screen.queryByText(/Verified .* native training snapshot/)).toBeNull();
      expect(startedCalls()).toHaveLength(0);
    },
  );

  it('does not submit the previously selected model after a held runtime check', async () => {
    await ready();
    let finish!: (value: Record<string, unknown>) => void;
    runtime = () => new Promise((resolve) => { finish = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: /Fixture Base/ }));
    fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
    await act(async () => { finish({ installed: true, attested: true, methods: ['full', 'lora'] }); });
    expect(startedCalls()).toHaveLength(0);
  });

  it('requires approval after the canonical catalog arrives instead of reusing fallback consent', async () => {
    const normalInvoke = invokeMock.getMockImplementation()!;
    let finish!: (value: ReturnType<typeof catalogModel>[]) => void;
    invokeMock.mockImplementation((name, ...args) => name === 'model_foundry_training_catalog'
      ? new Promise((resolve) => { finish = resolve; }) : normalInvoke(name, ...args));
    await ready(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    await act(async () => { finish([catalogModel()]); });
    expect(screen.getByRole('button', { name: 'Download and verify model' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed and approve/ }));
    expect(screen.getByRole('button', { name: 'Download and verify model' })).toHaveProperty('disabled', false);
  });

});


describe('Dataset Studio manifest to canonical native payload', () => {
  it('retains logical identity and exact split membership without sending test rows', async () => {
    const { storage } = await ready();
    const snapshots = JSON.parse(storage.getItem('vibespace.model-foundry.project-catalog.v1') ?? '[]') as {
      project: { id: string }; datasetVersion: { id: string; manifestHash: string; fingerprint: string;
        examples: { input: string; expectedOutput: string; split: string }[] };
    }[];
    const version = snapshots.find((entry) => entry.project.id === 'project-1')!.datasetVersion;
    const expected = (split: string) => version.examples.filter((row) => row.split === split)
      .map((row) => JSON.stringify({ prompt: row.input, response: row.expectedOutput })).join('\n');
    const train = expected('train'); const validation = expected('validation');
    expect(train).not.toBe(''); expect(validation).not.toBe('');
    expect(version.examples.some((row) => row.split === 'test')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    const wire = startedCalls()[0]![1].request;
    expect(wire).toMatchObject({
      datasetVersionId: version.id, datasetManifestHash: version.manifestHash,
      datasetFingerprint: version.fingerprint, datasetJsonl: train, validationDatasetJsonl: validation,
      datasetPayloadSha256: createHash('sha256').update(train).digest('hex'),
      validationPayloadSha256: createHash('sha256').update(validation).digest('hex'),
    });
    expect(wire.datasetFingerprint).not.toBe(wire.datasetPayloadSha256);
    for (const row of version.examples.filter((entry) => entry.split === 'test')) {
      expect(train).not.toContain(row.input); expect(validation).not.toContain(row.input);
    }
  });
  it.each(['account round trip', 'project change', 'model round trip'] as const)(
    'does not first dispatch a prepared job after a %s during payload hashing', async (boundary) => {
      const { storage } = await ready();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
        await held; return digest(...args);
      });
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
        await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
        if (boundary === 'account round trip') {
          act(() => { useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' }); });
        } else if (boundary === 'project change') {
          fireEvent.click(screen.getByRole('button', { name: 'Create another AI' }));
          fireEvent.click(screen.getByRole('button', { name: 'Create VibeCoder' }));
        } else {
          fireEvent.click(screen.getByRole('button', { name: /Fixture Base/ }));
          fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
        }
        await act(async () => {
          release(); await Promise.all(spy.mock.results.map((result) => result.value));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(startedCalls()).toHaveLength(0);
        expect(storedRun(storage)).toBeUndefined();
        expect(screen.queryByText('Submitting immutable real-training job.')).toBeNull();
        spy.mockRestore();
        if (boundary === 'project change') await prepareCurrentProject();
        const nextProject = boundary === 'project change' ? 'project-2' : 'project-1';
        start = async () => {
          const job = nativeJob({ id: 'job_after_revocation', projectId: nextProject }); jobs = [job]; return job;
        };
        fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
        await waitFor(() => expect(startedCalls()).toHaveLength(1));
        await waitFor(() => expect(JSON.parse(storage.getItem('vibespace.model-foundry.native-runs.v1') ?? '{}')[nextProject]?.jobId)
          .toBe('job_after_revocation'));
      } finally { release(); spy.mockRestore(); }
    },
  );

  it('does not first dispatch when Cancel real run is requested during payload hashing', async () => {
    await ready();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await held; return digest(...args);
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
      expect(screen.getByText('Cancelling preparation before native submission.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Start real training' })).toHaveProperty('disabled', true);
      await act(async () => {
        release(); await Promise.all(spy.mock.results.map((result) => result.value));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(startedCalls()).toHaveLength(0);
      expect(invokeMock.mock.calls.filter(([name]) => name === 'model_foundry_cancel_job')).toHaveLength(0);
      expect(screen.queryByText('Submitting immutable real-training job.')).toBeNull();
      spy.mockRestore();
      fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
      await waitFor(() => expect(startedCalls()).toHaveLength(1));
    } finally { release(); spy.mockRestore(); }
  });

  it('retains the real native identity when Cancel is clicked after dispatch but before its acknowledgment', async () => {
    const { storage } = await ready();
    let acknowledge!: (job: NativeJob) => void;
    start = () => new Promise((resolve) => { acknowledge = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
    await waitFor(() => expect(startedCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
    expect(screen.queryByText('Cancelling preparation before native submission.')).toBeNull();
    expect(invokeMock.mock.calls.filter(([name]) => name === 'model_foundry_cancel_job')).toHaveLength(0);
    await act(async () => { acknowledge(nativeJob()); });
    await waitFor(() => expect(storedRun(storage)?.jobId).toBe('job_native_1'));
    // Pending-ack cancellation remains the existing separate gap. Once the ID
    // is accepted, normal cancellation must still target that real job only.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('model_foundry_cancel_job', { jobId: 'job_native_1' }));
  });

  it.each(['cancel', 'account round trip', 'model round trip'] as const)(
    'retires revoked unsent preparation after a digest failure following %s', async (boundary) => {
      await ready();
      let fail!: (error: Error) => void;
      const held = new Promise<ArrayBuffer>((_resolve, reject) => { fail = reject; });
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => held);
      try {
        fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
        await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
        if (boundary === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel real run' }));
        else if (boundary === 'account round trip') {
          act(() => { useAuthStore.setState({ localUserId: 'account-b' }); useAuthStore.setState({ localUserId: 'account-a' }); });
        } else {
          fireEvent.click(screen.getByRole('button', { name: /Fixture Base/ }));
          fireEvent.click(screen.getByRole('button', { name: /SmolLM2 135M Instruct/ }));
        }
        await act(async () => {
          fail(new Error('Obsolete preparation hash failure')); await Promise.allSettled([held]);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(startedCalls()).toHaveLength(0);
        expect(screen.queryAllByText('Obsolete preparation hash failure')).toHaveLength(0);
        expect(screen.queryByText('Submitting immutable real-training job.')).toBeNull();
        expect(screen.queryByText('Cancelling preparation before native submission.')).toBeNull();
        spy.mockRestore();
        fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
        await waitFor(() => expect(startedCalls()).toHaveLength(1));
      } finally { spy.mockRestore(); }
    },
  );

  it('still reports a current preparation failure without dispatch and permits a fresh Start', async () => {
    await ready();
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('Current preparation hash failure'));
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Current preparation hash failure'));
      expect(startedCalls()).toHaveLength(0);
      spy.mockRestore();
      fireEvent.click(screen.getByRole('button', { name: 'Start real training' }));
      await waitFor(() => expect(startedCalls()).toHaveLength(1));
    } finally { spy.mockRestore(); }
  });

});

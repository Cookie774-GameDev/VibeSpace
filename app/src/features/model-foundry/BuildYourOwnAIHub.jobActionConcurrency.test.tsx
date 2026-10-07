import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { loadJobs, saveJobs, TRAINABLE_MODELS, type FoundryJob } from './modelHub';

const { invoke, save } = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: vi.fn() }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({ bootstrapOllamaConnection: async () => ({ ready: false }) }));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function job(id: string, status: FoundryJob['status'] = 'failed'): FoundryJob {
  return { id, name: `Synthetic ${id}`, baseModelId: TRAINABLE_MODELS[0].id, method: 'knowledge',
    status, progress: status === 'completed' ? 100 : 0, artifactVerified: status === 'completed',
    ...(status === 'completed' ? { artifactPath: `C:/synthetic/${id}.json` } : {}),
    createdAt: '2026-10-06T22:00:00Z', updatedAt: '2026-10-06T22:00:01Z' };
}
function action(id: string, name: string | RegExp) {
  const card = screen.getByText(`Synthetic ${id}`).parentElement!.parentElement!;
  return within(card).getByRole('button', { name });
}
const actions = () => invoke.mock.calls.filter(([command]) => /model_foundry_(retry|retrain|export|resume|cancel|duplicate|rename|delete)/.test(command));
let a: ReturnType<typeof deferred<FoundryJob>>; let b: ReturnType<typeof deferred<FoundryJob>>;
async function open(jobs: FoundryJob[]) {
  await import('@tauri-apps/api/core');
  saveJobs(localStorage, jobs);
  render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} trainingWorker={null} verifiedTrainingModels={[]} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'model_foundry_list_jobs')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'View model library' }));
}
async function settle(pending: ReturnType<typeof deferred<FoundryJob>>, value: FoundryJob) {
  await act(async () => { pending.resolve(value); await pending.promise; await vi.dynamicImportSettled(); });
}
beforeEach(() => {
  // Native dynamic imports can use the real Tauri JS wrapper; inject its IPC boundary too.
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string, args?: unknown) => invoke(command, args) });
  localStorage.clear(); invoke.mockReset(); save.mockReset().mockResolvedValue(null);
  a = deferred<FoundryJob>(); b = deferred<FoundryJob>();
  const list = deferred<FoundryJob[]>();
  invoke.mockImplementation((command: string, args?: { jobId?: string }) => {
    if (command === 'model_foundry_list_jobs') return list.promise;
    if (command === 'plugin:dialog|save') return save(args);
    if (command === 'faster_whisper_status') return Promise.resolve({ ready: false });
    if (command === 'model_foundry_detect_hardware') return Promise.resolve({ cpu: 'Synthetic CPU', gpu: null,
      ramGb: 16, vramGb: 0, freeStorageGb: 64, os: 'Synthetic', accelerators: [] });
    if (args?.jobId === 'A') return a.promise;
    if (args?.jobId === 'B') return b.promise;
    throw new Error(`Unexpected injected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Hub per-job action admission with synthetic native acknowledgements', () => {
  it.each([
    { label: 'Retry', command: 'model_foundry_retry_job', status: 'failed' as const, sameId: false },
    { label: 'Resume from checkpoint', command: 'model_foundry_resume_job', status: 'failed' as const, sameId: true },
    { label: 'Retrain as v2', command: 'model_foundry_retrain_artifact', status: 'completed' as const, sameId: false },
    { label: 'Cancel', command: 'model_foundry_cancel_job', status: 'training' as const, sameId: true },
  ])('coalesces same-render repeated $label clicks into one native submission', async ({ label, command, status, sameId }) => {
    const original = job('A', status);
    if (label === 'Resume from checkpoint') { original.method = 'lora'; original.resumeAvailable = true; }
    await open([original]); const button = action('A', label);
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(actions()).toHaveLength(1);
    expect(actions()[0]).toEqual([command, { jobId: 'A' }]);
    const acknowledged = { ...original, id: sameId ? 'A' : 'A-next',
      status: label === 'Cancel' ? 'cancelled' as const : 'queued' as const,
      artifactVerified: false, progress: 0, updatedAt: '2026-10-06T22:00:02Z' };
    await settle(a, acknowledged);
    expect(loadJobs(localStorage).find((item) => item.id === acknowledged.id)).toEqual(acknowledged);
  });

  it('keeps both independent jobs pending when a second job starts', async () => {
    await open([job('A'), job('B')]);
    fireEvent.click(action('A', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(1));
    fireEvent.click(action('B', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(2));
    expect(action('A', /^Retry$/)).toHaveProperty('disabled', true);
    expect(action('B', /^Retry$/)).toHaveProperty('disabled', true);
    fireEvent.click(action('A', /^Retry$/));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(actions()).toHaveLength(2);
  });

  it('releases only the acknowledged job while another remains pending', async () => {
    await open([job('A'), job('B')]);
    fireEvent.click(action('A', /^Retry$/)); fireEvent.click(action('B', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(2));
    await settle(a, job('A-retry', 'queued'));
    expect(action('A', /^Retry$/)).toHaveProperty('disabled', false);
    expect(action('B', /^Retry$/)).toHaveProperty('disabled', true);
    await settle(b, job('B-retry', 'queued'));
    expect(loadJobs(localStorage).map((item) => item.id)).toEqual(expect.arrayContaining(['A', 'B', 'A-retry', 'B-retry']));
    expect(action('B', /^Retry$/)).toHaveProperty('disabled', false);
  });

  it('does not release another job when an export picker is cancelled', async () => {
    await open([job('A', 'completed'), job('B')]);
    fireEvent.click(action('B', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(1));
    fireEvent.click(action('A', /^Export$/));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(save).toHaveBeenCalledOnce();
    expect(action('B', /^Retry$/)).toHaveProperty('disabled', true);
    expect(action('A', /^Export$/)).toHaveProperty('disabled', false);
    expect(actions()).toHaveLength(1);
  });

  it('retries the same job after actual failure without changing its identity', async () => {
    await open([job('A')]); fireEvent.click(action('A', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(1));
    await act(async () => { a.reject(new Error('Synthetic native retry rejected')); await a.promise.catch(() => undefined); });
    expect(screen.getByRole('alert').textContent).toContain('Synthetic native retry rejected');
    expect(action('A', /^Retry$/)).toHaveProperty('disabled', false);
    a = deferred<FoundryJob>(); fireEvent.click(action('A', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(2));
    expect(actions().map((call) => call[1])).toEqual([{ jobId: 'A' }, { jobId: 'A' }]);
    await settle(a, job('A-retry', 'queued'));
  });

  it('retains another pending job after the first native action fails', async () => {
    await open([job('A'), job('B')]);
    fireEvent.click(action('A', /^Retry$/)); fireEvent.click(action('B', /^Retry$/));
    await waitFor(() => expect(actions()).toHaveLength(2));
    await act(async () => { a.reject(new Error('Synthetic A failed')); await a.promise.catch(() => undefined); });
    expect(action('A', /^Retry$/)).toHaveProperty('disabled', false);
    expect(action('B', /^Retry$/)).toHaveProperty('disabled', true);
    await settle(b, job('B-retry', 'queued'));
    expect(loadJobs(localStorage).find((item) => item.id === 'A')?.status).toBe('failed');
    expect(loadJobs(localStorage).find((item) => item.id === 'B-retry')?.status).toBe('queued');
  });

  it('opens one export picker and admits a fresh attempt only after actual cancellation', async () => {
    const picker = deferred<string | null>(); save.mockReturnValueOnce(picker.promise);
    await open([job('A', 'completed')]); const button = action('A', /^Export$/);
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(save).toHaveBeenCalledOnce();
    expect(button).toHaveProperty('disabled', true);
    expect(action('A', 'Retrain as v2')).toHaveProperty('disabled', true);
    await act(async () => { picker.resolve(null); await picker.promise; });
    expect(action('A', /^Export$/)).toHaveProperty('disabled', false);
    fireEvent.click(action('A', /^Export$/));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(actions()).toHaveLength(0);
    expect(loadJobs(localStorage)).toEqual([job('A', 'completed')]);
  });

});

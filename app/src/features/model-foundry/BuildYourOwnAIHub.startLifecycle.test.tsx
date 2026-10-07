import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { loadJobs, TRAINABLE_MODELS, type FoundryJob } from './modelHub';

const { invoke, pick } = vi.hoisted(() => ({ invoke: vi.fn(), pick: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: vi.fn() }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({ bootstrapOllamaConnection: async () => ({ ready: true }) }));
vi.mock('@/lib/ai/providers/ollama', () => ({ listOllamaModels: async () => [TRAINABLE_MODELS[0].id] }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const accepted: FoundryJob = { id: 'synthetic-accepted-job', name: 'Original draft',
  baseModelId: TRAINABLE_MODELS[0].id, method: 'knowledge', status: 'queued', progress: 0,
  artifactVerified: false, createdAt: '2026-10-06T22:00:00Z', updatedAt: '2026-10-06T22:00:00Z' };
const props = { open: true, onOpenChange: vi.fn(), initialMethod: 'knowledge' as const,
  trainingWorker: null, verifiedTrainingModels: [] };
let pending: ReturnType<typeof deferred<FoundryJob>>;
const startCalls = () => invoke.mock.calls.filter(([command]) => command === 'model_foundry_start_training');
async function ready() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Installed and verified in Ollama');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'Original draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
  await screen.findByText('notes.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const button = screen.getByRole('button', { name: 'Begin local processing' });
  expect(button).toHaveProperty('disabled', false);
  return button;
}
async function begin() {
  fireEvent.click(await ready());
  await waitFor(() => expect(startCalls()).toHaveLength(1));
}
async function accept() {
  await act(async () => { pending.resolve(accepted); await pending.promise; });
}
async function reject() {
  await act(async () => { pending.reject(new Error('Synthetic preparation rejected')); await pending.promise.catch(() => undefined); });
}
beforeEach(() => {
  localStorage.clear(); invoke.mockReset(); pick.mockReset(); pending = deferred<FoundryJob>();
  pick.mockResolvedValue(['C:/synthetic/notes.txt']);
  const list = deferred<FoundryJob[]>();
  invoke.mockImplementation((command: string) => {
    if (command === 'model_foundry_start_training') return pending.promise;
    if (command === 'model_foundry_list_jobs') return list.promise;
    if (command === 'faster_whisper_status') return Promise.resolve({ ready: false });
    if (command === 'model_foundry_detect_hardware') return Promise.resolve({ cpu: 'Synthetic CPU', gpu: null,
      ramGb: 16, vramGb: 0, freeStorageGb: 64, os: 'Synthetic', accelerators: [] });
    throw new Error(`Unexpected native operation: ${command}`);
  });
});
afterEach(cleanup);

describe('Hub native preparation submission with injected acknowledgement IO', () => {
  it('submits one immutable request for repeated clicks while the acknowledgement is pending', async () => {
    render(<BuildYourOwnAIHub {...props} />);
    const button = await ready();
    fireEvent.click(button);
    await waitFor(() => expect(startCalls()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Begin local processing' }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(startCalls()).toHaveLength(1);
    expect(button).toHaveProperty('disabled', true);
    expect(startCalls()[0][1].request).toMatchObject({ name: 'Original draft', method: 'knowledge',
      baseModelId: TRAINABLE_MODELS[0].id, sourcePaths: ['C:/synthetic/notes.txt'], localOnly: true });
    await accept();
    expect(loadJobs(localStorage)).toEqual([accepted]);
    expect(screen.getByRole('button', { name: 'Continue using VibeSpace' })).toBeTruthy();
  });

  it('preserves the accepted job without navigating a reopened draft to the old job', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); await begin();
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />);
    await accept();
    expect(loadJobs(localStorage)).toEqual([accepted]);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue using VibeSpace' })).toBeNull();
  });

  it('preserves a newer draft and review step when the original start acknowledges', async () => {
    render(<BuildYourOwnAIHub {...props} />); await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'New draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await accept();
    expect(loadJobs(localStorage)).toEqual([accepted]);
    expect(screen.getByRole('button', { name: 'Begin local processing' })).toBeTruthy();
    expect(screen.getByText('New draft')).toBeTruthy();
  });

  it('does not publish an old preparation failure into a reopened draft', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); await begin();
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />);
    await reject();
    expect(loadJobs(localStorage)).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains the current failure and permits a new user retry after terminal rejection', async () => {
    render(<BuildYourOwnAIHub {...props} />); await begin(); await reject();
    expect(screen.getByRole('alert').textContent).toContain('Synthetic preparation rejected');
    pending = deferred<FoundryJob>();
    fireEvent.click(screen.getByRole('button', { name: 'Begin local processing' }));
    await waitFor(() => expect(startCalls()).toHaveLength(2));
    await accept();
    expect(loadJobs(localStorage)).toEqual([accepted]);
  });

  it('does not lose a native-accepted job when the original Hub unmounts', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); await begin(); view.unmount();
    await accept(); expect(loadJobs(localStorage)).toEqual([accepted]);
  });

  it('coalesces same-render repeated clicks before React can disable the button', async () => {
    render(<BuildYourOwnAIHub {...props} />); const button = await ready();
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(startCalls()).toHaveLength(1); await accept();
    expect(loadJobs(localStorage)).toEqual([accepted]);
  });

  it('does not submit if this opening closes before the native import resolves', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); const button = await ready();
    act(() => {
      fireEvent.click(button);
      view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(startCalls()).toHaveLength(0);
    expect(loadJobs(localStorage)).toEqual([]);
  });

  it('revokes old presentation across a navigation and draft-value round trip', async () => {
    render(<BuildYourOwnAIHub {...props} />); await begin();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    act(() => {
      fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'Temporary draft' } });
      fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'Original draft' } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await accept();
    expect(screen.getByRole('button', { name: 'Begin local processing' })).toBeTruthy();
    expect(loadJobs(localStorage)).toEqual([accepted]);
  });

  it('keeps a submitted operation pending across close/reopen until its actual acknowledgement', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); await begin();
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />);
    for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const button = screen.getByRole('button', { name: 'Begin local processing' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(startCalls()).toHaveLength(1);
    expect(invoke.mock.calls.some(([command]) => command === 'model_foundry_cancel_job')).toBe(false);
    await accept();
    expect(screen.getByRole('button', { name: 'Begin local processing' })).toHaveProperty('disabled', false);
    expect(loadJobs(localStorage)).toEqual([accepted]);
  });

});

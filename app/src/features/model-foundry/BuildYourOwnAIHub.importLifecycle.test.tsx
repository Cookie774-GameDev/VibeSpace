import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import type { LocalTrainingWorkerStatus, VerifiedTrainingModel } from './trainingRuntime';

const { pick, read, invoke } = vi.hoisted(() => ({ pick: vi.fn(), read: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/lib/fs', () => ({ readTextFile: read }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: vi.fn() }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({ bootstrapOllamaConnection: async () => ({ ready: false }) }));

const worker: LocalTrainingWorkerStatus = { installed: true, attested: true, localOnly: true,
  protocol: 1, sourceSha256: 'a'.repeat(64), python: 'synthetic-python',
  methods: ['full'], modalities: ['text'], precisions: ['fp32'], reason: null };
const SOURCE = 'D:/synthetic/training.jsonl';
const READ = { ok: true, content: '{"prompt":"Synthetic input","completion":"Synthetic output"}' };
const props = { open: true, onOpenChange: vi.fn(), initialMethod: 'full' as const,
  trainingWorker: worker, verifiedTrainingModels: [] };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sources() { for (let index = 0; index < 3; index++) fireEvent.click(screen.getByRole('button', { name: 'Continue' })); }
function methodStep() { for (let index = 0; index < 3; index++) fireEvent.click(screen.getByRole('button', { name: 'Back' })); }
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value); await pending.promise;
    // The actual component has a Promise.all and React commit after the read.
    await new Promise<void>((done) => setTimeout(done, 0));
  });
}
beforeEach(() => {
  localStorage.clear(); pick.mockReset(); read.mockReset(); invoke.mockReset();
  pick.mockResolvedValue([SOURCE]); read.mockResolvedValue(READ);
  invoke.mockImplementation(async (command: string) => {
    if (command === 'model_foundry_list_jobs') return [];
    if (command === 'faster_whisper_status') return { ready: false };
    if (command === 'model_foundry_detect_hardware') return { cpu: 'Synthetic CPU', gpu: 'Synthetic GPU',
      ramGb: 32, vramGb: 12, freeStorageGb: 64, os: 'Synthetic', accelerators: ['CUDA'] };
    throw new Error(`Unexpected native command: ${command}`);
  });
});

describe('Hub imported source publication with injected picker/read IO', () => {
  it('keeps cancel/retry and duplicate path handling in the actual component', async () => {
    pick.mockResolvedValueOnce(null);
    render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await act(async () => { await Promise.resolve(); });
    expect(read).not.toHaveBeenCalled(); expect(screen.getByText(/^\d+ attached$/).textContent).toBe('0 attached');
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await screen.findByText('1 attached');
    pick.mockResolvedValueOnce(['d:\\SYNTHETIC\\training.jsonl']);
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByText('1 attached')).toBeTruthy();
  });

  it('does not publish a captured fine-tuning classification after the selected method changes', async () => {
    const pending = deferred<typeof READ>(); read.mockReturnValueOnce(pending.promise);
    render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    methodStep(); fireEvent.click(screen.getByRole('button', { name: /^Knowledge training/ })); sources();
    await settle(pending, READ);
    expect(screen.queryByText('fine tuning')).toBeNull();
  });

  it('revokes a pending read across a method round trip', async () => {
    const pending = deferred<typeof READ>(); read.mockReturnValueOnce(pending.promise);
    render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    methodStep();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Knowledge training/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Advanced full fine-tuning/ }));
    });
    sources(); await settle(pending, READ);
    expect(screen.getByText(/^\d+ attached$/).textContent).toBe('0 attached');
  });

  it('does not read a picker result from a closed opening after reopening the Hub', async () => {
    const pending = deferred<string[]>(); pick.mockReturnValueOnce(pending.promise);
    const view = render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(pick).toHaveBeenCalledOnce());
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />); sources();
    await settle(pending, [SOURCE]);
    expect(read).not.toHaveBeenCalled(); expect(screen.getByText(/^\d+ attached$/).textContent).toBe('0 attached');
  });

  it('does not append an old completed read after closing and reopening', async () => {
    const pending = deferred<typeof READ>(); read.mockReturnValueOnce(pending.promise);
    const view = render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />); sources();
    await settle(pending, READ); expect(screen.getByText(/^\d+ attached$/).textContent).toBe('0 attached');
  });

  it('preserves a source that was already attached before the Hub closes', async () => {
    const view = render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await screen.findByText('1 attached');
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />); sources();
    expect(screen.getByText('1 attached')).toBeTruthy();
    expect(screen.getByText(SOURCE)).toBeTruthy();
  });

  it('does not attach a read whose selected model changed', async () => {
    // Metadata-only fixtures; no model, GPU or download operation is invoked.
    const model: VerifiedTrainingModel = { id: 'synthetic-small', label: 'Synthetic Small Model',
      sourceId: 'synthetic/model', revision: 'a'.repeat(40), license: 'apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
      gated: false, parametersB: 0.1, downloadBytes: 100, expectedRamGb: 1, expectedVramGb: 1,
      contextTokens: 1024, precision: 'FP32', modalities: ['text'], speed: 'fast', quality: 'efficient',
      cpuPractical: true, installed: true, verified: true, installedBytes: 100, status: 'ready', localOnly: true };
    const pending = deferred<typeof READ>(); read.mockReturnValueOnce(pending.promise);
    render(<BuildYourOwnAIHub {...props} verifiedTrainingModels={[model, { ...model, id: 'synthetic-other', label: 'Synthetic Other Model', parametersB: 0.2 }]} />);
    sources(); fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const other = screen.getByRole('button', { name: /^Synthetic Other Model/ });
    expect(other.hasAttribute('disabled')).toBe(false); fireEvent.click(other);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await settle(pending, READ);
    expect(screen.getByText(/^\d+ attached$/).textContent).toBe('0 attached');
  });

  it('does not publish a stale picker error in the next opening', async () => {
    const pending = deferred<string[]>(); pick.mockReturnValueOnce(pending.promise);
    const view = render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(pick).toHaveBeenCalledOnce());
    view.rerender(<BuildYourOwnAIHub {...props} open={false} />);
    view.rerender(<BuildYourOwnAIHub {...props} />); sources();
    await act(async () => { pending.reject(new Error('Synthetic old picker failure')); await pending.promise.catch(() => undefined); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reports a current picker error and lets the user retry', async () => {
    pick.mockRejectedValueOnce(new Error('Synthetic picker failure'));
    render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The native file picker is unavailable. No private file was accessed.');
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await screen.findByText('1 attached'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not access an old picker selection after unmount', async () => {
    const pending = deferred<string[]>(); pick.mockReturnValueOnce(pending.promise);
    const view = render(<BuildYourOwnAIHub {...props} />); sources();
    fireEvent.click(screen.getByRole('button', { name: 'Browse local files' }));
    await waitFor(() => expect(pick).toHaveBeenCalledOnce());
    view.unmount(); await settle(pending, [SOURCE]);
    expect(read).not.toHaveBeenCalled();
  });
});

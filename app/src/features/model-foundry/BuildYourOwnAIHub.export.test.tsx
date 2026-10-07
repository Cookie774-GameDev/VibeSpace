import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { loadJobs, saveJobs, TRAINABLE_MODELS, type FoundryJob } from './modelHub';

const h = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: h.save }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: vi.fn() }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({ bootstrapOllamaConnection: async () => ({ ready: false }) }));

function completed(method: FoundryJob['method']): FoundryJob {
  return { id: `synthetic-${method}`, name: `Synthetic ${method}`, method,
    baseModelId: TRAINABLE_MODELS[0].id, status: 'completed', progress: 100,
    artifactVerified: true, artifactPath: `C:/synthetic/${method}/artifact`,
    createdAt: '2026-10-07T02:00:00Z', updatedAt: '2026-10-07T02:00:01Z' };
}

async function open(job: FoundryJob) {
  saveJobs(localStorage, [job]);
  h.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === 'model_foundry_list_jobs') return Promise.resolve([job]);
    if (command === 'plugin:dialog|save') return h.save(args);
    if (command === 'model_foundry_export_artifact') return Promise.resolve(undefined);
    if (command === 'faster_whisper_status') return Promise.resolve({ ready: false });
    if (command === 'model_foundry_detect_hardware') return Promise.resolve({ cpu: 'Synthetic CPU',
      gpu: null, ramGb: 16, vramGb: 0, freeStorageGb: 64, os: 'Synthetic', accelerators: [] });
    throw new Error(`Unexpected injected command: ${command}`);
  });
  render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} trainingWorker={null} verifiedTrainingModels={[]} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  await waitFor(() => expect(h.invoke.mock.calls.some(([name]) => name === 'model_foundry_list_jobs')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'View model library' }));
  return within(screen.getByText(job.name).parentElement!.parentElement!).getByRole('button', { name: 'Export' });
}

beforeEach(() => {
  localStorage.clear(); h.invoke.mockReset(); h.save.mockReset();
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string, args?: unknown) => h.invoke(command, args) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('method-specific Foundry export with synthetic dialog and native IO', () => {
  it.each([
    { method: 'knowledge' as const, extension: 'json' },
    { method: 'full' as const, extension: 'zip' },
    { method: 'lora' as const, extension: 'zip' },
    { method: 'qlora' as const, extension: 'zip' },
  ])('exports $method through the declared $extension destination', async ({ method, extension }) => {
    const job = completed(method); const destination = `C:/synthetic/export.${extension}`;
    h.save.mockResolvedValue(destination);
    fireEvent.click(await open(job));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: `Synthetic-${method}.${extension}`,
      filters: [{ name: 'Model Foundry artifact', extensions: [extension] }],
    }));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('model_foundry_export_artifact', {
      jobId: job.id, destination,
    }));
    expect(loadJobs(localStorage)).toEqual([job]);
  });

  it('does not dispatch or mutate a verified weight job when the real-picker boundary is cancelled', async () => {
    const job = completed('full'); h.save.mockResolvedValue(null);
    const button = await open(job); fireEvent.click(button);
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(h.invoke.mock.calls.filter(([name]) => name === 'model_foundry_export_artifact')).toEqual([]);
    expect(button).toHaveProperty('disabled', false);
    expect(loadJobs(localStorage)).toEqual([job]);
  });

  it('keeps the completed artifact available for a retry after native export rejects', async () => {
    const job = completed('full'); h.save.mockResolvedValue('C:/synthetic/export.zip');
    const button = await open(job); const original = h.invoke.getMockImplementation()!;
    let attempts = 0;
    h.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'model_foundry_export_artifact' && attempts++ === 0) {
        return Promise.reject(new Error('Export destination already exists; choose a new file.'));
      }
      return original(command, args);
    });
    fireEvent.click(button);
    await screen.findByText('Export destination already exists; choose a new file.');
    expect(button).toHaveProperty('disabled', false);
    expect(loadJobs(localStorage)).toEqual([job]);
    h.save.mockResolvedValue('C:/synthetic/retry.zip'); fireEvent.click(button);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('model_foundry_export_artifact', {
      jobId: job.id, destination: 'C:/synthetic/retry.zip',
    }));
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(loadJobs(localStorage)).toEqual([job]);
  });
});

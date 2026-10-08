import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIPage } from './BuildYourOwnAIPage';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/lib/utils', async (original) => ({ ...await original<typeof import('@/lib/utils')>(), isTauri: true }));
vi.mock('@/lib/ai/models', () => ({ syncFoundryModelOptions: vi.fn() }));
vi.mock('@/lib/ai/ollamaBootstrap', () => ({ bootstrapOllamaConnection: async () => ({ ready: false }) }));
vi.mock('./FoundryPage', () => ({ FoundryPage: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ready = { installed: true, attested: true, protocol: 1, sourceSha256: 'a'.repeat(64),
  python: 'synthetic-private-python', methods: ['full'], modalities: ['text'], precisions: ['fp32'],
  reason: 'Full training is ready; optional capabilities unavailable: lora, qlora.' };
const absent = { ...ready, installed: false, attested: false, python: null, methods: [],
  reason: 'The verified local training worker has not been installed.' };
let inspection: ReturnType<typeof deferred<typeof ready>>;
let previousInternals: PropertyDescriptor | undefined;
const statusCalls = () => invoke.mock.calls.filter(([command]) => command === 'model_foundry_training_worker_status');
const mutations = () => invoke.mock.calls.filter(([command]) => /install|start_training|download|repair/.test(String(command)));
async function settle(value: typeof ready) {
  await act(async () => { inspection.resolve(value); await inspection.promise; });
}
async function openFull() {
  fireEvent.click(screen.getByRole('button', { name: 'Full weight: Train all weights' }));
  await act(async () => { await vi.dynamicImportSettled(); });
  return screen.getByRole('dialog', { name: 'Build Your Own AI' });
}
beforeEach(() => {
  localStorage.clear(); invoke.mockReset(); inspection = deferred<typeof ready>();
  previousInternals = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
  // Vitest may resolve a later dynamic import to Tauri's real wrapper; keep its
  // only native boundary on the same synthetic IO, never a live application.
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  invoke.mockImplementation(async (command: string) => {
    if (command === 'model_foundry_training_worker_status') return inspection.promise;
    if (command === 'model_foundry_list_jobs' || command === 'model_foundry_training_catalog') return [];
    if (command === 'faster_whisper_status') return { ready: false };
    if (command === 'model_foundry_detect_hardware') return { cpu: 'Synthetic CPU', gpu: 'Synthetic GPU',
      ramGb: 32, vramGb: 12, freeStorageGb: 22, os: 'Synthetic', accelerators: ['CUDA'],
      storageRoot: 'D:/synthetic-foundry' };
    throw new Error(`Unexpected native operation: ${command}`);
  });
});
afterEach(async () => {
  cleanup();
  // A failed assertion must still retire the actual service's in-flight dedup entry.
  inspection.resolve(ready);
  await inspection.promise.catch(() => undefined);
  await vi.dynamicImportSettled();
  if (previousInternals) Object.defineProperty(window, '__TAURI_INTERNALS__', previousInternals);
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('joined Foundry page and Hub canonical runtime inspection', () => {
  it('does not turn a pending parent inspection into absent worker or installer admission', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    const dialog = await openFull();
    expect(within(dialog).queryAllByText('The verified local training worker is not installed.')).toHaveLength(0);
    expect(within(dialog).getAllByText(/Checking the verified local training worker/).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole('button', { name: 'Set up LoRA, QLoRA, and Full' })).toBeNull();
    expect(statusCalls()).toHaveLength(1);
    expect(mutations()).toHaveLength(0);
    await settle(ready);
    expect(within(dialog).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent).not.toContain('not installed');
  });

  it('shows rejected inspection as unknown and permits one explicit read-only recheck', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await act(async () => { inspection.reject(new Error('Synthetic inspection unavailable')); await inspection.promise.catch(() => undefined); });
    const failed = deferred<typeof ready>(); inspection = failed;
    const dialog = await openFull();
    // Reopening may start a new inspection; keep it held, then prove rejection remains truthful.
    await act(async () => { failed.reject(new Error('Synthetic inspection unavailable')); await failed.promise.catch(() => undefined); });
    expect(within(dialog).queryAllByText('The verified local training worker is not installed.')).toHaveLength(0);
    expect(within(dialog).getAllByText(/Synthetic inspection unavailable/).length).toBeGreaterThan(0);
    inspection = deferred<typeof ready>();
    const before = statusCalls().length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check training runtime' }));
    await waitFor(() => expect(statusCalls()).toHaveLength(before + 1));
    await settle(ready);
    expect(within(dialog).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent).not.toContain('not installed');
    expect(within(dialog).getByRole('button', { name: /^LoRA fine-tuning/ }).textContent).toContain('does not support LORA');
    expect(mutations()).toHaveLength(0);
  });

  it('refreshes a settled absent parent snapshot when the Full wizard is opened', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await settle(absent);
    inspection = deferred<typeof ready>();
    const dialog = await openFull();
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    expect(within(dialog).queryAllByText('The verified local training worker is not installed.')).toHaveLength(0);
    await settle(ready);
    expect(within(dialog).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent).not.toContain('not installed');
    expect(mutations()).toHaveLength(0);
  });

  it('keeps confirmed absence distinct from unknown without performing setup', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await settle(absent);
    const dialog = await openFull();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Set up LoRA, QLoRA, and Full' })).toBeTruthy());
    expect(within(dialog).getAllByText('The verified local training worker is not installed.')).toHaveLength(3);
    expect(mutations()).toHaveLength(0);
  });

  it('does not promote a Full-capable but unattested worker to ready', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await settle({ ...ready, attested: false, reason: 'Synthetic integrity failure' });
    const dialog = await openFull();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent)
      .toContain('not verified or attested'));
    expect(mutations()).toHaveLength(0);
  });

  it('does not expose a previous ready snapshot while a reopened inspection is held', async () => {
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    await settle(ready);
    inspection = deferred<typeof ready>();
    const first = await openFull();
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    fireEvent.keyDown(first, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const reopened = await openFull();
    expect(statusCalls()).toHaveLength(2);
    expect(within(reopened).getAllByText(/Checking the verified local training worker/).length).toBeGreaterThan(0);
    expect(within(reopened).queryByRole('button', { name: 'Set up LoRA, QLoRA, and Full' })).toBeNull();
    await settle(absent);
    expect(within(reopened).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent).toContain('not installed');
    expect(mutations()).toHaveLength(0);
  });

  it('retires the unmounted observer before a later mount inspects a new status', async () => {
    const old = render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(1));
    old.unmount(); await settle(ready);
    inspection = deferred<typeof ready>();
    render(<BuildYourOwnAIPage />);
    await waitFor(() => expect(statusCalls()).toHaveLength(2));
    const dialog = await openFull();
    expect(within(dialog).getAllByText(/Checking the verified local training worker/).length).toBeGreaterThan(0);
    await settle(absent);
    expect(within(dialog).getByRole('button', { name: /^Advanced full fine-tuning/ }).textContent).toContain('not installed');
    expect(mutations()).toHaveLength(0);
  });

});

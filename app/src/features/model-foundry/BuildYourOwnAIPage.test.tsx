import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIPage } from './BuildYourOwnAIPage';

const installWorker = vi.fn();
const workerState = vi.hoisted(() => ({ repair: false }));

vi.mock('./BuildYourOwnAIHub', () => ({
  detectHardware: () => new Promise(() => {}),
  BuildYourOwnAIHub: ({
    open,
    onOpenChange,
    initialMethod,
  }: {
    open: boolean;
    initialMethod?: string;
    onOpenChange(open: boolean): void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Create local model" data-method={initialMethod}>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close builder
        </button>
      </div>
    ) : null,
}));

vi.mock('./trainingRuntime', () => ({
  getLocalTrainingWorkerStatus: () =>
    Promise.resolve({
      installed: workerState.repair,
      attested: false,
      localOnly: true,
      protocol: 1,
      sourceSha256: '',
      python: workerState.repair ? 'D:/private/python.exe' : null,
      methods: [],
      modalities: [],
      precisions: [],
      reason: workerState.repair
        ? 'The local training worker failed integrity verification.'
        : 'The verified local training worker has not been installed.',
    }),
  installLocalTrainingWorker: (options: unknown) => installWorker(options),
}));

describe('BuildYourOwnAIPage', () => {
  it('repairs a stale worker without requesting package downloads', async () => {
    workerState.repair = true;
    installWorker.mockClear();
    try {
      render(<BuildYourOwnAIPage />);
      await screen.findByText(/failed integrity verification/i);
      fireEvent.click(screen.getByRole('button', { name: /Repair local worker/i }));
      expect(installWorker).toHaveBeenCalledWith({
        includeQlora: false,
        allowDependencyRepair: false,
      });
    } finally {
      workerState.repair = false;
    }
  });
  it('exposes a dedicated scenic canvas without replacing the real interface', async () => {
    render(<BuildYourOwnAIPage />);

    expect(
      await screen.findByText(/verified local training worker has not been installed/i),
    ).toBeTruthy();
    const page = screen.getByRole('main');
    expect(page.getAttribute('data-warm-surface')).toBe('model-foundry-canvas');
    expect(page.querySelector('[data-warm-surface="model-foundry-content"]')).toBeTruthy();
    const scenicImage = page.querySelector<HTMLImageElement>(
      '[data-warm-decoration="model-foundry-scene"] > img',
    );
    const scenicDecoration = scenicImage?.parentElement;
    expect(scenicDecoration?.className).toContain('hidden');
    expect(scenicDecoration?.className).toContain('[html[data-theme=warm]_&]:block');
    expect(scenicImage?.getAttribute('src')).toBe(
      '/assets/themes/warm/model-foundry/model-foundry-landscape-v3-selected.webp',
    );
    expect(scenicImage?.getAttribute('alt')).toBe('');
    expect(screen.getByRole('button', { name: 'Create a local model' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up local worker' })).toBeTruthy();
  });

  it('presents the dedicated local studio workflow and privacy boundary', async () => {
    render(<BuildYourOwnAIPage />);

    expect(
      await screen.findByText(/verified local training worker has not been installed/i),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Build Your Own AI' })).toBeTruthy();
    expect(screen.getByLabelText('Model Foundry workflow')).toBeTruthy();
    for (const label of ['Overview', 'Create', 'Data Studio', 'Train', 'Evaluate', 'My Models']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByLabelText('Local model blueprint')).toBeTruthy();
    expect(screen.getAllByText(/stays on this computer/i).length).toBeGreaterThan(0);
  });

  it('starts the existing verified creation flow from the page', async () => {
    render(<BuildYourOwnAIPage />);

    expect(
      await screen.findByText(/verified local training worker has not been installed/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create a local model' }));

    expect(screen.getByRole('dialog', { name: 'Create local model' })).toBeTruthy();
  });

  it('switches sections without leaving the route', async () => {
    render(<BuildYourOwnAIPage />);

    expect(
      await screen.findByText(/verified local training worker has not been installed/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Data Studio' }));

    expect(screen.getByRole('heading', { name: 'Prepare private training data' })).toBeTruthy();
    expect(screen.getByText(/images, video, audio, documents, code, and datasets/i)).toBeTruthy();
  });

  it('opens each of the four methods directly without claiming unverified readiness', async () => {
    render(<BuildYourOwnAIPage />);
    await screen.findByText(/verified local training worker has not been installed/i);
    for (const [label, method] of [
      ['RAG: Add knowledge', 'knowledge'],
      ['LoRA: Teach a specialty', 'lora'],
      ['QLoRA: Train efficiently', 'qlora'],
      ['Full weight: Train all weights', 'full'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByRole('dialog').getAttribute('data-method')).toBe(method);
      fireEvent.click(screen.getByRole('button', { name: 'Close builder' }));
    }
    expect(screen.queryByText('Hardware checked')).toBeNull();
    expect(await screen.findAllByText('Setup required')).toHaveLength(3);
  });

  it('shows the truthful local training runtime state', async () => {
    render(<BuildYourOwnAIPage />);

    expect(await screen.findByRole('heading', { name: 'Training runtime' })).toBeTruthy();
    expect(screen.getByText(/verified local training worker has not been installed/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up local worker' })).toBeTruthy();
  });

  it('requests verified QLoRA support during local runtime setup', async () => {
    installWorker.mockResolvedValue({
      installed: true,
      attested: true,
      localOnly: true,
      protocol: 1,
      sourceSha256: 'a'.repeat(64),
      python: 'python',
      methods: ['lora', 'qlora', 'full'],
      modalities: ['text'],
      precisions: ['bf16', 'int4'],
      reason: null,
    });
    render(<BuildYourOwnAIPage />);
    expect(
      await screen.findByText(/verified local training worker has not been installed/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Set up local worker' }));

    expect(installWorker).toHaveBeenCalledWith({ includeQlora: true });
  });
});

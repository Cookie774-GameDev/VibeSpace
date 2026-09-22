import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { saveJobs, TRAINABLE_MODELS } from './modelHub';
import type { LocalTrainingWorkerStatus, VerifiedTrainingModel } from './trainingRuntime';

const tauriInvoke = vi.hoisted(() => vi.fn());
const getTrainingWorkerStatus = vi.hoisted(() => vi.fn());
const installTrainingWorker = vi.hoisted(() => vi.fn());
const calibrateTraining = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));
vi.mock('./trainingRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./trainingRuntime')>()),
  calibrateLocalTraining: calibrateTraining,
  getLocalTrainingWorkerStatus: getTrainingWorkerStatus,
  installLocalTrainingWorker: installTrainingWorker,
}));

const verifiedModel: VerifiedTrainingModel = {
  id: 'smollm2-135m-instruct',
  label: 'SmolLM2 135M Instruct',
  sourceId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
  revision: '1'.repeat(40),
  license: 'apache-2.0',
  licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  gated: false,
  parametersB: 0.135,
  downloadBytes: 272_437_573,
  expectedRamGb: 4,
  expectedVramGb: 2,
  contextTokens: 8192,
  precision: 'BF16 safetensors',
  modalities: ['text'],
  speed: 'fast',
  quality: 'efficient',
  cpuPractical: true,
  installed: false,
  verified: false,
  installedBytes: 0,
  status: 'not-installed',
  localOnly: true,
};

describe('BuildYourOwnAIHub', () => {
  beforeEach(() => {
    window.localStorage.clear();
    tauriInvoke.mockReset();
    tauriInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_detect_hardware') {
        return {
          cpu: 'Test CPU',
          gpu: 'Test GPU',
          ramGb: 32,
          vramGb: 12,
          freeStorageGb: 100,
          os: 'Test OS',
          accelerators: ['CUDA'],
        };
      }
      if (command === 'model_foundry_list_jobs') return [];
      if (command === 'faster_whisper_status') return { ready: false };
      throw new Error(`Unexpected command: ${command}`);
    });
    getTrainingWorkerStatus.mockReset();
    installTrainingWorker.mockReset();
    calibrateTraining.mockReset();
    getTrainingWorkerStatus.mockResolvedValue({
      installed: false,
      attested: false,
      localOnly: true,
      protocol: 1,
      sourceSha256: '',
      python: null,
      methods: [],
      modalities: [],
      precisions: [],
      reason: 'The verified local training worker is not installed.',
    });
  });

  it('explains document and labeled media training without claiming media generation', () => {
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Purpose' })).toBeTruthy();

    expect(screen.getByText(/PDF and DOCX text are extracted locally/i)).toBeTruthy();
    expect(
      screen.getByText(/Scanned\/image-only PDFs need a verified OCR processor/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/produce text answers; image, audio, and video generation are not claimed/i),
    ).toBeTruthy();
  });

  it('does not overlap slow native job refreshes', async () => {
    let resolveJobs!: (jobs: unknown[]) => void;
    const pendingJobs = new Promise<unknown[]>((resolve) => {
      resolveJobs = resolve;
    });
    tauriInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_detect_hardware') {
        return {
          cpu: 'Test CPU',
          gpu: 'Test GPU',
          ramGb: 32,
          vramGb: 12,
          freeStorageGb: 100,
          os: 'Test OS',
          accelerators: ['CUDA'],
        };
      }
      if (command === 'model_foundry_list_jobs') return pendingJobs;
      if (command === 'faster_whisper_status') return { ready: false };
      throw new Error(`Unexpected command: ${command}`);
    });

    const view = render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={null}
        verifiedTrainingModels={[verifiedModel]}
      />,
    );

    try {
      await waitFor(
        () =>
          expect(
            tauriInvoke.mock.calls.filter(([command]) => command === 'model_foundry_list_jobs'),
          ).toHaveLength(1),
        { timeout: 5_000 },
      );
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 2_200));
      });
      expect(
        tauriInvoke.mock.calls.filter(([command]) => command === 'model_foundry_list_jobs'),
      ).toHaveLength(1);
    } finally {
      view.unmount();
      resolveJobs([]);
    }
  });

  it('presents a responsive source drop target with clear active feedback', () => {
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const dropZone = screen.getByTestId('foundry-source-drop-zone');
    fireEvent.dragEnter(dropZone);

    expect(screen.getByText(/Release to attach your local files/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Browse local files/i })).toBeTruthy();
  });

  it('does not pretend a browser-only drop has a native training path', async () => {
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    fireEvent.drop(screen.getByTestId('foundry-source-drop-zone'), {
      dataTransfer: { files: [new File(['private notes'], 'notes.md', { type: 'text/markdown' })] },
    });

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /needs each file's private local path/i,
    );
    expect(screen.getByText('0 attached')).toBeTruthy();
  });

  it('explains how to recover legacy provenance failures', () => {
    saveJobs(window.localStorage, [
      {
        id: 'job_provenance',
        name: 'Debater',
        baseModelId: TRAINABLE_MODELS[0].id,
        method: 'knowledge',
        status: 'failed',
        progress: 80,
        sourceCount: 0,
        error:
          'Artifact packaging failed: Artifact source provenance is incomplete or unsupported.',
        createdAt: '1',
        updatedAt: '2',
      },
    ]);

    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View model library' }));

    expect(screen.getByText(/Retry this job/i)).toBeTruthy();
    expect(screen.getByText(/Source verification incomplete/i)).toBeTruthy();
  });

  it('honors the method chosen on the overview without installing anything', async () => {
    render(<BuildYourOwnAIHub open initialMethod="full" onOpenChange={vi.fn()} />);
    expect(
      await screen.findByRole('button', { name: /^Advanced full fine-tuning/i, pressed: true }),
    ).toBeTruthy();
    expect(installTrainingWorker).not.toHaveBeenCalled();
  });

  it('offers one truthful setup path for all verified weight-training methods', async () => {
    installTrainingWorker.mockResolvedValue({
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
    render(
      <BuildYourOwnAIHub open onOpenChange={vi.fn()} verifiedTrainingModels={[verifiedModel]} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Set up LoRA, QLoRA, and Full/i }));

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /^QLoRA fine-tuning/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(installTrainingWorker).toHaveBeenCalledWith({ includeQlora: true });
  });

  it('resolves the same verified worker when a caller omits the capability prop', async () => {
    getTrainingWorkerStatus.mockResolvedValue({
      installed: true,
      attested: true,
      localOnly: true,
      protocol: 1,
      sourceSha256: 'a'.repeat(64),
      python: 'python',
      methods: ['lora', 'qlora', 'full'],
      modalities: ['text'],
      precisions: ['bf16'],
      reason: null,
    });

    render(
      <BuildYourOwnAIHub open onOpenChange={vi.fn()} verifiedTrainingModels={[verifiedModel]} />,
    );

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /^LoRA fine-tuning/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(getTrainingWorkerStatus).toHaveBeenCalledTimes(1);
  });

  it('does not install dependencies merely by selecting a training method', async () => {
    installTrainingWorker.mockResolvedValue({
      installed: true,
      attested: true,
      localOnly: true,
      protocol: 1,
      sourceSha256: 'a'.repeat(64),
      python: 'python',
      methods: ['lora', 'full'],
      modalities: ['text'],
      precisions: ['bf16'],
      reason: null,
    });
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    const lora = screen.getByRole('button', { name: /^LoRA fine-tuning/i });
    expect((lora as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(lora);
    expect(installTrainingWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Set up LoRA, QLoRA, and Full/i }));
    await waitFor(() => expect(installTrainingWorker).toHaveBeenCalledWith({ includeQlora: true }));
  });

  it('requires explicit setup before downloading QLoRA dependencies', async () => {
    installTrainingWorker.mockResolvedValue({
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
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^QLoRA fine-tuning/i }));
    expect(installTrainingWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Set up LoRA, QLoRA, and Full/i }));
    await waitFor(() => expect(installTrainingWorker).toHaveBeenCalledWith({ includeQlora: true }));
  });

  it('lets users choose GPU-only or CPU-only training and keeps QLoRA GPU-only', async () => {
    const worker: LocalTrainingWorkerStatus = {
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
    };
    const view = render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={worker}
        verifiedTrainingModels={[{ ...verifiedModel, installed: true, verified: true }]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^LoRA fine-tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const gpuOnly = screen.getByRole('button', { name: /^GPU only/i });
    const cpuOnly = screen.getByRole('button', { name: /^CPU only/i });
    expect(gpuOnly.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cpuOnly);
    expect(cpuOnly.getAttribute('aria-pressed')).toBe('true');
    expect(gpuOnly.getAttribute('aria-pressed')).toBe('false');

    view.unmount();
    render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={worker}
        verifiedTrainingModels={[{ ...verifiedModel, installed: true, verified: true }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^QLoRA fine-tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('button', { name: /^GPU only/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((screen.getByRole('button', { name: /^CPU only/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('activates only a verified completed artifact', () => {
    saveJobs(window.localStorage, [
      {
        id: 'job_12345',
        name: 'Release specialist',
        baseModelId: TRAINABLE_MODELS[0].id,
        method: 'knowledge',
        status: 'completed',
        progress: 100,
        artifactPath: 'C:\\private\\knowledge-artifact.json',
        artifactVerified: true,
        createdAt: '1',
        updatedAt: '2',
      },
    ]);
    const onActivateArtifact = vi.fn();
    render(
      <BuildYourOwnAIHub open onOpenChange={vi.fn()} onActivateArtifact={onActivateArtifact} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View model library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Release specialist with this agent' }));
    expect(onActivateArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job_12345', artifactVerified: true }),
    );
  });

  it('discloses hardware compatibility, runtime format, and the supported build path', () => {
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getAllByText(/Q4_K_M \(4-bit inference\)/)).toHaveLength(TRAINABLE_MODELS.length);
    expect(screen.getAllByText(/Supported build path: Knowledge\/RAG/)).toHaveLength(
      TRAINABLE_MODELS.length,
    );
    expect(screen.getByText(/Operating system:/)).toBeTruthy();
    expect(screen.getByText(/GPU:/)).toBeTruthy();
    expect(screen.getByText(/Acceleration:/)).toBeTruthy();
    expect(screen.getByText(/Managed storage:/)).toBeTruthy();
  });

  it('shows the native managed storage root and a higher-capacity recommendation', async () => {
    tauriInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_detect_hardware') {
        return {
          cpu: 'Test CPU',
          gpu: 'Test GPU',
          ramGb: 32,
          vramGb: 12,
          freeStorageGb: 100,
          os: 'Test OS',
          accelerators: ['CUDA'],
          storageRoot: 'C:\\Users\\test\\AppData\\Roaming\\VibeSpace\\model-foundry',
          recommendedStorageRoot: 'D:\\VibeSpace-Model-Foundry',
        };
      }
      if (command === 'model_foundry_list_jobs') return [];
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Managed storage: C:\\Users\\test/)).toBeTruthy();
    expect(screen.getByText(/Storage recommendation: D:\\VibeSpace-Model-Foundry/)).toBeTruthy();
  });

  it('shows the verified checkpoint catalog for attested weight training', () => {
    render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={{
          installed: true,
          attested: true,
          localOnly: true,
          protocol: 1,
          sourceSha256: 'a'.repeat(64),
          python: 'python',
          methods: ['lora', 'qlora', 'full'],
          modalities: ['text'],
          precisions: ['bf16'],
          reason: null,
        }}
        verifiedTrainingModels={[verifiedModel]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^LoRA fine-tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText('SmolLM2 135M Instruct')).toBeTruthy();
    expect(screen.getByText(/HuggingFaceTB\/SmolLM2-135M-Instruct/)).toBeTruthy();
    expect(screen.getByText(/LORA · QLORA · FULL/)).toBeTruthy();
    expect(screen.queryByText(/Q4_K_M \(4-bit inference\)/)).toBeNull();
  });

  it('requires and displays model-specific device calibration before weight training', async () => {
    tauriInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_detect_hardware') {
        return {
          cpu: 'Test CPU',
          gpu: 'RTX 4050 Laptop GPU',
          ramGb: 16,
          vramGb: 6,
          freeStorageGb: 100,
          os: 'Test OS',
          accelerators: ['CUDA'],
        };
      }
      if (command === 'model_foundry_list_jobs') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    calibrateTraining.mockResolvedValue({
      qualified: true,
      modelId: 'smollm2-135m-instruct',
      method: 'lora',
      computeDevice: 'gpu',
      device: 'cuda:0',
      precision: 'bf16',
      forwardBackward: true,
      optimizerStep: true,
      batchSize: 1,
      gradientAccumulation: 8,
      maxSequenceLength: 1024,
      warmupSteps: 3,
      measuredSteps: 10,
      stepTimeMs: 820,
      stepTimeMsP95: 910,
      peakVramMb: 1450,
      vramTotalMb: 6141,
      vramHeadroomMb: 4691,
      elapsedMs: 900,
      reason: null,
    });
    render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={{
          installed: true,
          attested: true,
          localOnly: true,
          protocol: 1,
          sourceSha256: 'a'.repeat(64),
          python: 'D:/foundry/python.exe',
          methods: ['lora', 'qlora', 'full'],
          modalities: ['text'],
          precisions: ['bf16'],
          reason: null,
        }}
        verifiedTrainingModels={[
          { ...verifiedModel, installed: true, verified: true, status: 'ready' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^LoRA fine-tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText(/Calibration is required before Start Training/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run calibration' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Qualified: LORA on cuda:0'),
    );
    expect(calibrateTraining).toHaveBeenCalledWith(
      'smollm2-135m-instruct',
      expect.objectContaining({
        method: 'lora',
        computeDevice: 'gpu',
        gradientAccumulation: 8,
        maxSequenceLength: 1024,
      }),
    );
  });

  it('exposes validated reproducible settings for weight training', () => {
    render(
      <BuildYourOwnAIHub
        open
        onOpenChange={vi.fn()}
        trainingWorker={{
          installed: true,
          attested: true,
          localOnly: true,
          protocol: 1,
          sourceSha256: 'a'.repeat(64),
          python: 'python',
          methods: ['lora', 'qlora', 'full'],
          modalities: ['text'],
          precisions: ['bf16'],
          reason: null,
        }}
        verifiedTrainingModels={[
          {
            ...verifiedModel,
            installed: true,
            verified: true,
            installedBytes: verifiedModel.downloadBytes,
            status: 'ready',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^LoRA fine-tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('button', { name: /^Low memory/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Balanced/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Faster/i })).toBeTruthy();
    expect(screen.getByText(/receive a measured prediction/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Low memory/i }));
    fireEvent.click(screen.getByText(/Advanced reproducible settings/i));
    expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('7');
    expect((screen.getByLabelText('Learning rate') as HTMLInputElement).value).toBe('0.0002');
    expect((screen.getByLabelText('LoRA rank') as HTMLInputElement).value).toBe('16');
    expect((screen.getByLabelText('Batch size') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Gradient accumulation') as HTMLInputElement).value).toBe('8');
    expect((screen.getByLabelText('Maximum sequence length') as HTMLInputElement).value).toBe(
      '1024',
    );
    fireEvent.change(screen.getByLabelText('Learning rate'), { target: { value: '' } });
    expect(screen.getByText(/Learning rate must be/)).toBeTruthy();
  });

  it('resumes an interrupted weight job only when native checkpoint evidence exists', async () => {
    const interrupted = {
      id: 'job_resume123',
      name: 'Local adapter',
      baseModelId: 'smollm2-135m-instruct',
      method: 'lora' as const,
      status: 'failed' as const,
      progress: 35,
      resumeAvailable: true,
      error: 'The previous local process was interrupted.',
      createdAt: '1',
      updatedAt: '2',
    };
    saveJobs(window.localStorage, [interrupted]);
    tauriInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_detect_hardware') {
        return {
          cpu: 'Test CPU',
          gpu: 'Test GPU',
          ramGb: 32,
          vramGb: 12,
          freeStorageGb: 100,
          os: 'Test OS',
          accelerators: ['CUDA'],
        };
      }
      if (command === 'model_foundry_list_jobs') return [interrupted];
      if (command === 'model_foundry_resume_job') {
        return {
          ...interrupted,
          status: 'queued',
          resumeAvailable: false,
          error: undefined,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'View model library' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume from checkpoint' }));

    await waitFor(() =>
      expect(tauriInvoke).toHaveBeenCalledWith('model_foundry_resume_job', {
        jobId: 'job_resume123',
      }),
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildYourOwnAIHub } from './BuildYourOwnAIHub';
import { saveJobs, TRAINABLE_MODELS } from './modelHub';
import type { VerifiedTrainingModel } from './trainingRuntime';

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));

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
  });

  it('disables training methods without an installed verified worker', async () => {
    render(<BuildYourOwnAIHub open onOpenChange={vi.fn()} />);

    expect(
      (screen.getByRole('button', { name: /^LoRA fine-tuning/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /^QLoRA fine-tuning/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: /Advanced full fine-tuning/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getAllByText(/verified local training worker is not installed/i).length,
    ).toBeGreaterThan(0);
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

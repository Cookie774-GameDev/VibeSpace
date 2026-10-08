import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('../../lib/utils', () => ({ isTauri: true }));

import {
  listenFoundryWorkerMessages,
  startFoundryTraining,
  type FoundryNativeTrainingRequest,
} from './nativeBridge';

describe('Model Foundry TrainingRequestV2 bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    invokeMock.mockResolvedValue({ id: 'job_native_1' });
  });

  it('commits the approved train and validation splits with every supported setting', async () => {
    const request: FoundryNativeTrainingRequest = {
      projectId: 'project-1',
      jobId: 'requested-job',
      modelId: 'smollm2-135m-instruct',
      datasetVersionId: 'dataset-v3',
      datasetManifestHash: 'a'.repeat(64),
      datasetFingerprint: 'b'.repeat(64),
      datasetApproved: true,
      trainExamples: [{ prompt: 'Train prompt', completion: 'Train completion' }],
      validationExamples: [{ prompt: 'Validation prompt', completion: 'Validation completion' }],
      trainingConfig: {
        method: 'lora',
        computeDevice: 'gpu',
        seed: 23,
        epochs: 3,
        maxSteps: 77,
        batchSize: 2,
        gradientAccumulation: 8,
        maxSequenceLength: 1024,
        learningRate: 0.00008,
        loraRank: 32,
        loraAlpha: 64,
        loraDropout: 0.1,
      },
      targetModules: ['q_proj', 'v_proj'],
    };

    await startFoundryTraining(request);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('model_foundry_start_training', {
      request: expect.objectContaining({
        schemaVersion: 2,
        projectId: 'project-1',
        datasetVersionId: 'dataset-v3',
        datasetJsonl: JSON.stringify({ prompt: 'Train prompt', completion: 'Train completion' }),
        validationDatasetJsonl: JSON.stringify({
          prompt: 'Validation prompt',
          completion: 'Validation completion',
        }),
        trainingConfig: request.trainingConfig,
        targetModules: ['q_proj', 'v_proj'],
      }),
    });
  });

  it('preserves the owning project on native job updates', async () => {
    const listener = vi.fn();
    const unlisten = vi.fn();
    let nativeListener: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listenMock.mockImplementation(async (_eventName, callback) => {
      nativeListener = callback;
      return unlisten;
    });

    await expect(listenFoundryWorkerMessages(listener)).resolves.toBe(unlisten);
    nativeListener?.({
      payload: {
        id: 'job_native_1',
        projectId: 'project-1',
        status: 'completed',
        progress: 100,
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        jobId: 'job_native_1',
      }),
    );
  });

  it('refuses an empty validation split instead of training without evaluation truth', async () => {
    const request = {
      projectId: 'project-1',
      jobId: 'requested-job',
      modelId: 'smollm2-135m-instruct',
      datasetVersionId: 'dataset-v3',
      datasetManifestHash: 'a'.repeat(64),
      datasetFingerprint: 'b'.repeat(64),
      datasetApproved: true,
      trainExamples: [{ prompt: 'Train prompt', completion: 'Train completion' }],
      validationExamples: [],
      trainingConfig: {
        method: 'lora' as const,
        computeDevice: 'gpu' as const,
        seed: 23,
        epochs: 3,
        batchSize: 2,
        gradientAccumulation: 8,
        maxSequenceLength: 1024,
        learningRate: 0.00008,
        loraRank: 32,
        loraAlpha: 64,
        loraDropout: 0.1,
      },
    };

    await expect(startFoundryTraining(request)).rejects.toThrow(/validation/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('native training event contract consumed by Foundry Studio', () => {
  it.each([
    ['training', 35, 'progress', null],
    ['completed', 100, 'result', null],
    ['failed', 35, 'result', 'Synthetic worker failure'],
    ['cancelled', 35, 'result', 'Cancelled by the owner'],
  ])('maps native %s status and percent into the existing UI contract', async (status, progress, type, error) => {
    const listener = vi.fn();
    let receive!: (event: { payload: Record<string, unknown> }) => void;
    listenMock.mockImplementation(async (_name, callback) => { receive = callback; return vi.fn(); });
    await listenFoundryWorkerMessages(listener);
    receive({ payload: { id: 'job_native_event', projectId: 'project-1', status, progress, error } });
    expect(listener).toHaveBeenCalledWith({
      projectId: 'project-1', jobId: 'job_native_event',
      message: expect.objectContaining({ type, phase: status, progress: Number(progress) / 100,
        ...(error ? { message: error } : {}) }),
    });
  });

  it('refuses an artifact summary from a foreign project before registration', async () => {
    const { inspectFoundryArtifact } = await import('./nativeBridge');
    invokeMock.mockResolvedValue([{ id: 'foreign-job', projectId: 'project-b', status: 'completed',
      artifactVerified: true, artifactSha256: 'a'.repeat(64), artifactPath: '/synthetic/weights',
      method: 'lora', name: 'Foreign', version: 1, storageBytes: 24 }]);
    await expect(inspectFoundryArtifact('project-a', 'foreign-job')).rejects.toThrow(/project/i);
  });
});

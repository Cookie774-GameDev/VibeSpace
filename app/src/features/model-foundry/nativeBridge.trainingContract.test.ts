import canonicalVectors from './inlineDatasetCanonicalV2.fixture.json';
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
        datasetJsonl: JSON.stringify({ prompt: 'Train prompt', response: 'Train completion' }),
        validationDatasetJsonl: JSON.stringify({
          prompt: 'Validation prompt',
          response: 'Validation completion',
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


describe('separate logical identity and canonical training payload digests', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ id: 'job_native_digest' });
  });

  const request = (): FoundryNativeTrainingRequest => ({
    projectId: 'project-1', jobId: 'requested-job', modelId: 'smollm2-135m-instruct',
    datasetVersionId: 'dataset-v3', datasetManifestHash: 'a'.repeat(64),
    datasetFingerprint: 'b'.repeat(64), datasetApproved: true,
    trainExamples: [{ prompt: '  Say hi  ', completion: ' Hello. ' }],
    validationExamples: [{ prompt: 'Color?', completion: 'blue' }],
    trainingConfig: { method: 'lora', computeDevice: 'gpu', seed: 7, epochs: 3,
      batchSize: 1, gradientAccumulation: 1, maxSequenceLength: 256,
      learningRate: 0.00002, loraRank: 8, loraAlpha: 16, loraDropout: 0 },
  });

  it('retains logical provenance while committing the exact canonical bytes of each split', async () => {
    const input = request();
    await startFoundryTraining(input);
    expect(invokeMock).toHaveBeenCalledWith('model_foundry_start_training', {
      request: expect.objectContaining({
        schemaVersion: 2,
        datasetVersionId: input.datasetVersionId,
        datasetManifestHash: input.datasetManifestHash,
        datasetFingerprint: input.datasetFingerprint,
        datasetJsonl: '{"prompt":"Say hi","response":"Hello."}',
        validationDatasetJsonl: '{"prompt":"Color?","response":"blue"}',
        datasetPayloadSha256: '9c400c28703586fc716233ab30678181bc718e43006f3a30e7f0933cd2c0a30f',
        validationPayloadSha256: '9a68a7b44c11e37bcf9d53271f47ddc86078ff33e58c50e30c4490eb8328a411',
      }),
    });
  });
  it.each(canonicalVectors.vectors.filter((vector) => 'expectedCanonicalJsonl' in vector))(
    'matches the shared canonical byte vector $id', async (vector) => {
      const rows = vector.inputJsonl.split('\n').filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, string>);
      const input = request();
      await startFoundryTraining({ ...input,
        trainExamples: rows.map((row) => ({ prompt: row.prompt!,
          completion: Object.hasOwn(row, 'response') ? row.response! : row.completion! })),
      });
      expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ request: {
        datasetJsonl: vector.expectedCanonicalJsonl,
        datasetPayloadSha256: vector.expectedCanonicalSha256,
        datasetFingerprint: input.datasetFingerprint,
      } });
    },
  );

  it.each([
    ['empty prompt after Rust whitespace trim', '\u0085', 'Valid response'],
    ['lone leading surrogate', '\ud800', 'Valid response'],
    ['lone trailing surrogate', 'Valid prompt', '\udfff'],
    ['empty completion', 'Valid prompt', '  '],
  ])('rejects %s before native submission', async (_name, prompt, completion) => {
    await expect(startFoundryTraining({ ...request(), trainExamples: [{ prompt: prompt!, completion: completion! }] }))
      .rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('pins C0 control escaping without changing interior text or adding a final newline', async () => {
    await startFoundryTraining({ ...request(), trainExamples: [{
      prompt: 'a\u0000\b\f\n\r\t\u001fb', completion: 'B',
    }] });
    expect(invokeMock.mock.calls[0]?.[1].request.datasetJsonl)
      .toBe('{"prompt":"a\\u0000\\b\\f\\n\\r\\t\\u001fb","response":"B"}');
  });

  it('rechecks preparation ownership after the native IPC module finishes loading', async () => {
    vi.resetModules();
    let release!: () => void;
    let entered = false;
    let current = true;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.doMock('@tauri-apps/api/core', async () => {
      entered = true; await held; return { invoke: invokeMock };
    });
    try {
      const fresh = await import('./nativeBridge');
      const result = fresh.startFoundryTraining(request(), () => current);
      await vi.waitFor(() => expect(entered).toBe(true));
      current = false; release();
      await expect(result).resolves.toMatchObject({ started: false });
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      release(); vi.doMock('@tauri-apps/api/core', () => ({ invoke: invokeMock })); vi.resetModules();
    }
  });

});

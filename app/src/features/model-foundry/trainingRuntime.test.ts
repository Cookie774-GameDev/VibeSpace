import { describe, expect, it, vi } from 'vitest';
import {
  cancelVerifiedTrainingModelDownload,
  downloadVerifiedTrainingModel,
  getLocalTrainingWorkerStatus,
  installLocalTrainingWorker,
  listVerifiedTrainingModels,
  repairVerifiedTrainingModel,
  removeVerifiedTrainingModel,
  verifiedTrainingModelToTrainableModel,
  type TrainingRuntimeInvoke,
  type VerifiedTrainingModel,
} from './trainingRuntime';

describe('trainingRuntime', () => {
  it('reports a truthful web-preview boundary without invoking native code', async () => {
    const invoke = vi.fn();

    const status = await getLocalTrainingWorkerStatus({ native: false, invoke });

    expect(invoke).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      installed: false,
      attested: false,
      localOnly: true,
      methods: [],
    });
    expect(status.reason).toMatch(/desktop app/i);
  });

  it('normalizes the attested native worker capability response', async () => {
    const invoke = vi.fn<TrainingRuntimeInvoke>().mockResolvedValue({
      installed: true,
      attested: true,
      protocol: 1,
      sourceSha256: 'a'.repeat(64),
      python: 'python',
      methods: ['lora', 'qlora', 'full', 'unknown'],
      modalities: ['text', 'image', 'video', 'audio', 'unknown'],
      precisions: ['fp32', 'fp16', 'bf16', 'int4', 'unknown'],
      reason: null,
    });

    const status = await getLocalTrainingWorkerStatus({ native: true, invoke });

    expect(invoke).toHaveBeenCalledWith('model_foundry_training_worker_status');
    expect(status.methods).toEqual(['lora', 'qlora', 'full']);
    expect(status.modalities).toEqual(['text', 'image', 'video', 'audio']);
    expect(status.precisions).toEqual(['fp32', 'fp16', 'bf16', 'int4']);
    expect(status.localOnly).toBe(true);
  });

  it('installs only through the explicit native worker command', async () => {
    const invoke = vi.fn<TrainingRuntimeInvoke>().mockResolvedValue({
      installed: true,
      attested: true,
      protocol: 1,
      sourceSha256: 'b'.repeat(64),
      python: 'python3',
      methods: [],
      modalities: [],
      precisions: [],
      reason: 'Verified local training libraries are incomplete.',
    });

    const status = await installLocalTrainingWorker({ native: true, invoke });

    expect(invoke).toHaveBeenCalledWith('model_foundry_install_training_worker');
    expect(status.installed).toBe(true);
    expect(status.attested).toBe(true);
    expect(status.reason).toMatch(/libraries are incomplete/i);
  });

  it('loads the five pinned trainable models from native authority', async () => {
    const invoke = vi.fn().mockResolvedValue([
      {
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
        files: [],
      },
    ]);

    const models = await listVerifiedTrainingModels({ native: true, invoke });

    expect(invoke).toHaveBeenCalledWith('model_foundry_training_catalog');
    expect(models[0]).toMatchObject({
      id: 'smollm2-135m-instruct',
      sourceId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      localOnly: true,
      license: 'apache-2.0',
    });
  });

  it('routes download, repair, removal, and cancellation through bounded native commands', async () => {
    const model: VerifiedTrainingModel = {
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
      installed: true,
      verified: true,
      installedBytes: 272_437_573,
      status: 'ready',
      localOnly: true,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(model)
      .mockResolvedValueOnce(model)
      .mockResolvedValueOnce({
        ...model,
        installed: false,
        verified: false,
        installedBytes: 0,
        status: 'not-installed',
      })
      .mockResolvedValueOnce(true);

    await downloadVerifiedTrainingModel(model.id, { native: true, invoke });
    await repairVerifiedTrainingModel(model.id, { native: true, invoke });
    await removeVerifiedTrainingModel(model.id, { native: true, invoke });
    await cancelVerifiedTrainingModelDownload({ native: true, invoke });

    expect(invoke.mock.calls).toEqual([
      ['model_foundry_download_training_model', { modelId: model.id }],
      ['model_foundry_repair_training_model', { modelId: model.id }],
      ['model_foundry_remove_training_model', { modelId: model.id }],
      ['model_foundry_cancel_training_model_download'],
    ]);
    expect(verifiedTrainingModelToTrainableModel(model)).toMatchObject({
      id: model.id,
      downloadGb: 0.25,
      ramGb: 4,
      vramGb: 2,
      quantization: 'BF16 safetensors',
      methods: ['lora', 'qlora', 'full'],
    });
  });
});

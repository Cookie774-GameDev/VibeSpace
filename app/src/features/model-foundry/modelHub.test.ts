import { describe, expect, it } from 'vitest';
import {
  classifySource,
  compatibleModels,
  applyTrainingComputePreset,
  defaultFoundryTrainingConfiguration,
  estimateFoundryTrainingDuration,
  measureTrainingJsonl,
  measureTrainingText,
  TRAINING_COMPUTE_PRESETS,
  validateFoundryTrainingConfiguration,
  formatFoundryStorageBytes,
  foundryModelOptions,
  foundryAgentModelSelection,
  newlyCompletedJobId,
  loadJobs,
  mayStartTraining,
  modelFoundryMethodAvailability,
  planLocalTrainingMethod,
  isModelInstalled,
  TRAINABLE_MODELS,
  type TrainingMethod,
} from './modelHub';

const workstation = {
  cpu: 'CPU',
  gpu: 'GPU',
  ramGb: 64,
  vramGb: 24,
  freeStorageGb: 500,
  os: 'Windows',
  accelerators: ['cuda'],
};

describe('model foundry domain', () => {
  it('fits a small text adapter on modest CUDA hardware without CPU fallback', () => {
    const worker = {
      installed: true,
      attested: true,
      version: '1',
      methods: ['lora'] as const,
      modalities: ['text'] as const,
      precisions: ['bf16'] as const,
    };
    const hardware = { ...workstation, ramGb: 16, vramGb: 6, freeStorageGb: 32 };
    const plan = planLocalTrainingMethod({
      method: 'lora',
      parametersB: 0.135,
      hardware,
      worker,
      computeDevice: 'gpu',
    });
    expect(plan).toMatchObject({
      available: true,
      fallbackMethod: null,
      requiredVramGb: 2,
      requiredRamGb: 4,
      requiredStorageGb: 2,
    });
    expect(
      planLocalTrainingMethod({
        method: 'lora',
        parametersB: 1,
        hardware,
        worker,
        computeDevice: 'gpu',
      }).available,
    ).toBe(false);
    expect(
      planLocalTrainingMethod({
        method: 'lora',
        parametersB: 0.135,
        hardware: { ...hardware, vramGb: 0, accelerators: [] },
        worker,
        computeDevice: 'gpu',
      }).available,
    ).toBe(false);
  });
  it('blocks unknown capacity and requires actual RAM for knowledge indexing', () => {
    for (const hardware of [
      { ...workstation, ramGb: 0, vramGb: 0 },
      { ...workstation, freeStorageGb: Number.NaN },
      { ...workstation, ramGb: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        planLocalTrainingMethod({ method: 'knowledge', parametersB: 1, hardware, worker: null })
          .available,
      ).toBe(false);
    }
  });
  it('measures plain local training text without inventing a fixed source count', () => {
    const measurement = measureTrainingText('a'.repeat(12_001));
    expect(measurement).toMatchObject({
      examples: 3,
      textTokens: 3_001,
      totalBytes: 12_001,
      measured: true,
    });
  });
  it('creates an explicit reproducible baseline instead of relying on worker defaults', () => {
    expect(defaultFoundryTrainingConfiguration('lora')).toEqual({
      method: 'lora',
      computeDevice: 'gpu',
      seed: 7,
      epochs: 1,
      batchSize: 1,
      gradientAccumulation: 8,
      maxSequenceLength: 1024,
      learningRate: 0.0002,
      loraRank: 16,
      loraAlpha: 32,
      loraDropout: 0.05,
    });
    expect(defaultFoundryTrainingConfiguration('full').learningRate).toBe(0.00002);
    expect(
      validateFoundryTrainingConfiguration(defaultFoundryTrainingConfiguration('lora')),
    ).toBeNull();
    expect(
      validateFoundryTrainingConfiguration({
        ...defaultFoundryTrainingConfiguration('qlora'),
        learningRate: Number.NaN,
      }),
    ).toMatch(/Learning rate/);
    expect(
      validateFoundryTrainingConfiguration({
        ...defaultFoundryTrainingConfiguration('lora'),
        computeDevice: 'auto' as 'gpu',
      }),
    ).toMatch(/training device/i);
  });

  it('applies real low-memory, balanced, and faster compute profiles', () => {
    expect(TRAINING_COMPUTE_PRESETS.map((preset) => preset.id)).toEqual([
      'low-memory',
      'balanced',
      'faster',
    ]);
    expect(applyTrainingComputePreset('lora', 'low-memory')).toMatchObject({
      method: 'lora',
      batchSize: 1,
      gradientAccumulation: 8,
      maxSequenceLength: 1024,
    });
    expect(applyTrainingComputePreset('qlora', 'balanced')).toMatchObject({
      method: 'qlora',
      batchSize: 1,
      gradientAccumulation: 4,
      maxSequenceLength: 2048,
    });
    expect(applyTrainingComputePreset('full', 'faster')).toMatchObject({
      method: 'full',
      batchSize: 2,
      gradientAccumulation: 2,
      maxSequenceLength: 2048,
      learningRate: 0.00002,
    });
  });

  it('uses measured examples and tokens and keeps low-memory slower on identical hardware', () => {
    const measurement = measureTrainingJsonl(
      [
        JSON.stringify({ prompt: 'Describe the component', completion: 'A bounded answer.' }),
        JSON.stringify({ prompt: 'Explain the test', completion: 'A second reviewed answer.' }),
      ].join('\n'),
    );
    expect(measurement).toMatchObject({ examples: 2, mediaExamples: 0 });
    expect(measurement.textTokens).toBeGreaterThan(10);
    const lowMemory = estimateFoundryTrainingDuration({
      method: 'qlora',
      parametersB: 1.5,
      configuration: applyTrainingComputePreset('qlora', 'low-memory'),
      hardware: workstation,
      measurement,
    });
    const balanced = estimateFoundryTrainingDuration({
      method: 'qlora',
      parametersB: 1.5,
      configuration: applyTrainingComputePreset('qlora', 'balanced'),
      hardware: workstation,
      measurement,
    });
    const faster = estimateFoundryTrainingDuration({
      method: 'qlora',
      parametersB: 1.5,
      configuration: applyTrainingComputePreset('qlora', 'faster'),
      hardware: workstation,
      measurement,
    });

    expect(lowMemory.minimumHours).toBeGreaterThan(0);
    expect(lowMemory.maximumHours).toBeGreaterThan(lowMemory.minimumHours);
    expect(lowMemory.maximumHours).toBeGreaterThan(balanced.maximumHours);
    expect(balanced.maximumHours).toBeGreaterThan(faster.maximumHours);
    expect(lowMemory.maximumHours).toBeGreaterThan(faster.maximumHours);
    expect(lowMemory.basis).toMatch(/2 measured examples/i);
    expect(lowMemory.disclaimer).toMatch(/planning estimate/i);
    expect(lowMemory.disclaimer).toMatch(/verified training telemetry/i);
  });

  it('keeps LoRA bounds aligned with the verified worker contract', () => {
    const baseline = defaultFoundryTrainingConfiguration('lora');
    expect(
      validateFoundryTrainingConfiguration({ ...baseline, loraRank: 512, loraAlpha: 1024 }),
    ).toBeNull();
    expect(validateFoundryTrainingConfiguration({ ...baseline, loraRank: 513 })).toMatch(
      /LoRA rank.*512/,
    );
    expect(validateFoundryTrainingConfiguration({ ...baseline, loraAlpha: 1025 })).toMatch(
      /LoRA alpha.*1024/,
    );
  });

  it('estimates the explicitly selected device and never treats GPU-only as a CPU fallback', () => {
    const measurement = measureTrainingText('reviewed local sample');
    const gpu = estimateFoundryTrainingDuration({
      method: 'lora',
      parametersB: 7,
      configuration: {
        ...defaultFoundryTrainingConfiguration('lora'),
        computeDevice: 'gpu',
      },
      hardware: workstation,
      measurement,
    });
    const cpu = estimateFoundryTrainingDuration({
      method: 'lora',
      parametersB: 7,
      configuration: {
        ...defaultFoundryTrainingConfiguration('lora'),
        computeDevice: 'cpu',
      },
      hardware: workstation,
      measurement,
    });

    expect(gpu.basis).toMatch(/selected GPU/i);
    expect(cpu.basis).toMatch(/selected CPU/i);
    expect(cpu.maximumHours).toBeGreaterThan(gpu.maximumHours);
  });

  it('preflights only the explicitly selected compute device', () => {
    const worker = {
      installed: true,
      attested: true,
      version: '1',
      methods: ['lora', 'qlora', 'full'] as const,
      modalities: ['text'] as const,
      precisions: ['bf16', 'int4'] as const,
    };
    expect(
      planLocalTrainingMethod({
        method: 'lora',
        parametersB: 0.135,
        hardware: { ...workstation, vramGb: 0 },
        worker,
        computeDevice: 'gpu',
      }).reason,
    ).toMatch(/GPU-only/i);
    expect(
      validateFoundryTrainingConfiguration({
        ...defaultFoundryTrainingConfiguration('qlora'),
        computeDevice: 'cpu',
      }),
    ).toMatch(/QLoRA requires GPU-only/i);
  });

  it('exposes all four build modes when the verified worker attests every weight method', () => {
    const worker = {
      installed: true,
      attested: true,
      version: '1',
      methods: ['lora', 'qlora', 'full'] as const,
      modalities: ['text'] as const,
      precisions: ['bf16', 'int4'] as const,
    };
    expect(
      (['knowledge', 'lora', 'qlora', 'full'] as const).map(
        (method) => modelFoundryMethodAvailability(method, worker).available,
      ),
    ).toEqual([true, true, true, true]);
  });

  it('recommends the strongest model that genuinely fits', () => {
    const assessed = compatibleModels(workstation);
    expect(assessed.filter((item) => item.recommended)).toHaveLength(1);
    expect(assessed.find((item) => item.recommended)?.model.id).toBe('llama3.1:8b-instruct-q4_K_M');
  });

  it('rejects image training for a text-only base model', () => {
    expect(classifySource('photo.png', 'qlora', ['text']).use).toBe('unsupported');
    expect(classifySource('photo.png', 'qlora', ['text', 'image', 'video']).use).toBe(
      'fine_tuning',
    );
    expect(classifySource('clip.mp4', 'qlora', ['text', 'image', 'video']).use).toBe('fine_tuning');
    expect(classifySource('notes.md', 'knowledge', ['text']).use).toBe('retrieval');
    expect(classifySource('notes.md', 'full', ['text'])).toMatchObject({
      use: 'fine_tuning',
      explanation: expect.stringMatching(/text-continuation/i),
    });
    expect(classifySource('manual.pdf', 'knowledge', ['text'])).toMatchObject({
      kind: 'document',
      use: 'retrieval',
    });
    expect(classifySource('examples.jsonl', 'qlora', ['text']).use).toBe('fine_tuning');
  });

  it('fails closed for unsupported full tuning and insufficient hardware', () => {
    const source = classifySource('examples.jsonl', 'qlora', ['text']);
    expect(
      mayStartTraining({
        name: 'Specialist',
        model: TRAINABLE_MODELS[0],
        method: 'full',
        hardware: workstation,
        sources: [source],
        worker: {
          installed: true,
          attested: true,
          version: '1',
          methods: ['full'],
          modalities: ['text'],
          precisions: ['bf16'],
        },
      }),
    ).toContain('does not support');
    expect(
      mayStartTraining({
        name: 'Specialist',
        model: TRAINABLE_MODELS[2],
        method: 'knowledge',
        hardware: { ...workstation, ramGb: 4, vramGb: 0 },
        sources: [source],
      }),
    ).toContain('Requires');
  });

  it('advertises only training paths backed by the installed native runtime', () => {
    expect(modelFoundryMethodAvailability('knowledge')).toEqual({
      available: true,
      reason: null,
    });
    expect(modelFoundryMethodAvailability('lora')).toEqual({
      available: false,
      reason: 'The verified local training worker is not installed.',
    });
    expect(
      modelFoundryMethodAvailability('lora', {
        installed: true,
        attested: true,
        version: '1',
        methods: ['lora'],
        modalities: ['text'],
        precisions: ['bf16'],
      }),
    ).toEqual({ available: true, reason: null });
    expect(TRAINABLE_MODELS.every((model) => model.methods.includes('knowledge'))).toBe(true);
    expect(TRAINABLE_MODELS.some((model) => model.methods.includes('lora'))).toBe(false);
    expect(
      TRAINABLE_MODELS.every((model) => model.quantization === 'Q4_K_M (4-bit inference)'),
    ).toBe(true);
  });

  it('validates weight training against the selected verified model and worker', () => {
    const model = {
      ...TRAINABLE_MODELS[0],
      id: 'smollm2-135m-instruct',
      methods: ['lora', 'qlora', 'full'] as TrainingMethod[],
      quantization: 'BF16 safetensors',
      downloadGb: 0.26,
      ramGb: 4,
      vramGb: 2,
    };
    const worker = {
      installed: true,
      attested: true,
      version: '1',
      methods: ['lora', 'qlora', 'full'] as const,
      modalities: ['text'] as const,
      precisions: ['bf16'] as const,
    };
    expect(
      mayStartTraining({
        name: 'Specialist',
        model,
        method: 'lora',
        hardware: workstation,
        sources: [
          classifySource('examples.jsonl', 'lora', ['text'], 'C:\\training\\examples.jsonl'),
        ],
        worker,
      }),
    ).toBeNull();
  });

  it('requires picker-authorized filesystem paths instead of accepting pathless browser rows', () => {
    expect(
      mayStartTraining({
        name: 'Private specialist',
        model: TRAINABLE_MODELS[0],
        method: 'knowledge',
        hardware: workstation,
        sources: [classifySource('notes.md', 'knowledge', ['text'])],
      }),
    ).toMatch(/native picker|drop/i);
  });

  it('plans attested local LoRA and QLoRA without silently changing the selected method', () => {
    const worker = {
      installed: true,
      attested: true,
      version: '1.0.0',
      methods: ['lora', 'qlora', 'full'] as const,
      modalities: ['text', 'image', 'video', 'audio'] as const,
      precisions: ['fp16', 'bf16', 'int4'] as const,
    };

    expect(
      planLocalTrainingMethod({
        method: 'lora',
        parametersB: 0.5,
        hardware: workstation,
        worker,
      }),
    ).toMatchObject({ method: 'lora', available: true, localOnly: true });
    expect(
      planLocalTrainingMethod({
        method: 'qlora',
        parametersB: 1.5,
        hardware: { ...workstation, vramGb: 8, ramGb: 32 },
        worker,
      }),
    ).toMatchObject({ method: 'qlora', available: true, localOnly: true });

    expect(
      planLocalTrainingMethod({
        method: 'qlora',
        parametersB: 1.5,
        hardware: { ...workstation, vramGb: 5.997, ramGb: 16 },
        worker,
      }),
    ).toMatchObject({ method: 'qlora', available: true, localOnly: true });

    expect(
      planLocalTrainingMethod({
        method: 'qlora',
        parametersB: 1.5,
        hardware: { ...workstation, vramGb: 5.8, ramGb: 64 },
        worker,
      }),
    ).toMatchObject({ method: 'qlora', available: false, localOnly: true });
  });

  it('keeps full-weight visible with a measured reason when hardware does not fit', () => {
    const result = planLocalTrainingMethod({
      method: 'full',
      parametersB: 1.5,
      hardware: { ...workstation, vramGb: 6, ramGb: 16, freeStorageGb: 40 },
      worker: {
        installed: true,
        attested: true,
        version: '1.0.0',
        methods: ['full'],
        modalities: ['text'],
        precisions: ['fp16'],
      },
    });

    expect(result).toMatchObject({ method: 'full', available: false, localOnly: true });
    expect(result.reason).toMatch(/VRAM|RAM|storage/i);
    expect(result.fallbackMethod).toBeNull();
  });

  it('sizes full-weight GPU requirements from the selected model instead of a workstation-class floor', () => {
    const worker = {
      installed: true,
      attested: true,
      version: '1.0.0',
      methods: ['full'] as const,
      modalities: ['text'] as const,
      precisions: ['bf16'] as const,
    };

    expect(
      planLocalTrainingMethod({
        method: 'full',
        parametersB: 0.135,
        hardware: { ...workstation, vramGb: 6, ramGb: 16, freeStorageGb: 12 },
        worker,
        computeDevice: 'gpu',
      }),
    ).toMatchObject({ available: true, requiredVramGb: 4 });

    expect(
      planLocalTrainingMethod({
        method: 'full',
        parametersB: 1,
        hardware: { ...workstation, vramGb: 6, ramGb: 16, freeStorageGb: 40 },
        worker,
        computeDevice: 'gpu',
      }),
    ).toMatchObject({ available: false, requiredVramGb: 16 });
  });

  it('fails closed when the local training worker is missing or unattested', () => {
    expect(
      planLocalTrainingMethod({
        method: 'qlora',
        parametersB: 0.5,
        hardware: workstation,
        worker: null,
      }),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/worker/i),
      fallbackMethod: null,
    });
    expect(
      planLocalTrainingMethod({
        method: 'lora',
        parametersB: 0.5,
        hardware: workstation,
        worker: {
          installed: true,
          attested: false,
          version: 'unknown',
          methods: ['lora'],
          modalities: ['text'],
          precisions: ['fp16'],
        },
      }),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/verified|attested/i),
      fallbackMethod: null,
    });
  });

  it('supports packaged document extraction and fails closed when media processors are unavailable', () => {
    const pdf = classifySource('manual.pdf', 'knowledge', ['text']);
    const docx = classifySource('manual.docx', 'knowledge', ['text']);
    const audio = classifySource('recording.wav', 'knowledge', ['text']);
    const video = classifySource('demo.mp4', 'knowledge', ['text']);
    expect(pdf).toMatchObject({ kind: 'document', use: 'retrieval' });
    expect(pdf.explanation).toContain('locally');
    expect(docx).toMatchObject({ kind: 'document', use: 'retrieval' });
    expect(audio).toMatchObject({ kind: 'audio', use: 'unsupported' });
    expect(audio.explanation).toContain('transcription');
    expect(video).toMatchObject({ kind: 'video', use: 'unsupported' });
    expect(video.explanation).toContain('frame');
    expect(
      classifySource('recording.mp3', 'knowledge', ['text'], 'C:\\recording.mp3', {
        transcriptionReady: true,
      }),
    ).toMatchObject({ kind: 'audio', use: 'retrieval' });
    expect(
      classifySource('demo.mp4', 'knowledge', ['text'], 'C:\\demo.mp4', {
        transcriptionReady: true,
      }),
    ).toMatchObject({
      kind: 'video',
      use: 'retrieval',
      explanation: expect.stringMatching(/audio track|frames/i),
    });
    expect(
      classifySource('recording.mp3', 'lora', ['text'], 'C:\\recording.mp3', {
        transcriptionReady: true,
      }).use,
    ).toBe('unsupported');
    expect(classifySource('notes.md', 'knowledge', ['text']).use).toBe('retrieval');
  });

  it('recovers safely from corrupted persisted jobs', () => {
    expect(loadJobs({ getItem: () => '{broken' })).toEqual([]);
  });

  it('exposes only verified completed artifacts as selectable local models', () => {
    const base = {
      id: 'job_12345',
      name: 'Release specialist',
      baseModelId: TRAINABLE_MODELS[0].id,
      method: 'knowledge' as const,
      progress: 100,
      artifactPath: 'C:\\private\\artifact.json',
      artifactVerified: true,
      status: 'completed' as const,
      createdAt: '1',
      updatedAt: '2',
    };
    expect(
      foundryModelOptions([
        base,
        {
          ...base,
          id: 'job_weight',
          name: 'Release adapter',
          method: 'lora',
          artifactPath: 'C:\\private\\weight-artifact',
        },
        { ...base, id: 'job_unverified', artifactVerified: false },
        { ...base, id: 'job_failed', status: 'failed', artifactVerified: false },
      ]),
    ).toEqual([
      {
        id: 'artifact--job_12345',
        label: 'Release specialist',
        subtitle: 'Verified local knowledge · Qwen 2.5 1.5B Instruct',
        method: 'knowledge',
      },
      {
        id: 'artifact--job_weight',
        label: 'Release adapter',
        subtitle: 'Verified local LoRA model · Qwen 2.5 1.5B Instruct',
        method: 'lora',
      },
    ]);
  });

  it('builds a dedicated Foundry selection only for a verified completed native artifact', () => {
    const completed = {
      id: 'job_12345',
      name: 'Release specialist',
      baseModelId: TRAINABLE_MODELS[0].id,
      method: 'knowledge' as const,
      progress: 100,
      artifactPath: 'C:\\private\\artifact.json',
      artifactVerified: true,
      status: 'completed' as const,
      createdAt: '1',
      updatedAt: '2',
    };

    expect(foundryAgentModelSelection(completed)).toEqual({
      providerChoice: 'foundry',
      provider: 'foundry',
      model: 'artifact--job_12345',
    });
    expect(() => foundryAgentModelSelection({ ...completed, artifactVerified: false })).toThrow(
      /verified completed/i,
    );
    expect(() => foundryAgentModelSelection({ ...completed, id: '../escape' })).toThrow(
      /identity/i,
    );
  });

  it('fails closed when the native job response is malformed', () => {
    expect(foundryModelOptions(undefined)).toEqual([]);
    expect(foundryModelOptions({ jobs: [] })).toEqual([]);
  });

  it('matches only the exact verified Ollama model tag', () => {
    expect(isModelInstalled(TRAINABLE_MODELS[0].id, ['QWEN2.5:1.5B-INSTRUCT-Q4_K_M'])).toBe(true);
    expect(isModelInstalled(TRAINABLE_MODELS[0].id, ['qwen2.5:1.5b'])).toBe(false);
  });

  it('reveals only a newly verified completed artifact', () => {
    const queued = {
      id: 'job_12345',
      name: 'Release specialist',
      baseModelId: TRAINABLE_MODELS[0].id,
      method: 'knowledge' as const,
      status: 'queued' as const,
      progress: 5,
      createdAt: '1',
      updatedAt: '1',
    };
    const completed = {
      ...queued,
      status: 'completed' as const,
      progress: 100,
      artifactPath: 'C:\\private\\artifact.json',
      artifactVerified: true,
      updatedAt: '2',
    };

    expect(newlyCompletedJobId([queued], [completed])).toBe('job_12345');
    expect(newlyCompletedJobId([completed], [completed])).toBeNull();
    expect(newlyCompletedJobId([queued], [{ ...completed, artifactVerified: false }])).toBeNull();
  });

  it('formats measured local artifact storage without guessing', () => {
    expect(formatFoundryStorageBytes(undefined)).toBe('Not measured');
    expect(formatFoundryStorageBytes(1_536)).toBe('1.5 KB');
    expect(formatFoundryStorageBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

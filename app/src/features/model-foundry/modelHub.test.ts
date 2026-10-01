import { describe, expect, it } from 'vitest';
import {
  classifySource,
  compatibleModels,
  formatFoundryStorageBytes,
  foundryModelOptions,
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
  it('recommends the strongest model that genuinely fits', () => {
    const assessed = compatibleModels(workstation);
    expect(assessed.filter((item) => item.recommended)).toHaveLength(1);
    expect(assessed.find((item) => item.recommended)?.model.id).toBe('llama3.1:8b-instruct-q4_K_M');
  });

  it('rejects image training for a text-only base model', () => {
    expect(classifySource('photo.png', 'qlora', false).use).toBe('unsupported');
    expect(classifySource('notes.md', 'knowledge', false).use).toBe('retrieval');
    expect(classifySource('examples.jsonl', 'qlora', false).use).toBe('fine_tuning');
  });

  it('fails closed for unsupported full tuning and insufficient hardware', () => {
    const source = classifySource('examples.jsonl', 'qlora', false);
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
        sources: [classifySource('examples.jsonl', 'lora', false)],
        worker,
      }),
    ).toBeNull();
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

  it('fails closed with source-specific recovery guidance when an extractor is unavailable', () => {
    const pdf = classifySource('manual.pdf', 'knowledge', false);
    const audio = classifySource('recording.wav', 'knowledge', false);
    const video = classifySource('demo.mp4', 'knowledge', false);
    expect(pdf).toMatchObject({ kind: 'document', use: 'unsupported' });
    expect(pdf.explanation).toContain('document extractor');
    expect(audio).toMatchObject({ kind: 'audio', use: 'unsupported' });
    expect(audio.explanation).toContain('transcription');
    expect(video).toMatchObject({ kind: 'video', use: 'unsupported' });
    expect(video.explanation).toContain('frame');
    expect(classifySource('notes.md', 'knowledge', false).use).toBe('retrieval');
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
        id: 'foundry:job_12345',
        label: 'Release specialist',
        subtitle: 'Verified local knowledge · Qwen 2.5 1.5B Instruct',
      },
      {
        id: 'foundry:job_weight',
        label: 'Release adapter',
        subtitle: 'Verified local LoRA model · Qwen 2.5 1.5B Instruct',
      },
    ]);
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

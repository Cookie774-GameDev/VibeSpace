import { describe, expect, it } from 'vitest';
import { planMediaPreparation, type MediaWorkerCapability } from './mediaPreparation';

const worker: MediaWorkerCapability = {
  attested: true,
  imagePreparation: true,
  ffmpeg: true,
  transcription: true,
  documentExtraction: true,
  nativeModalities: ['image', 'video', 'audio'],
};

describe('Model Foundry media preparation', () => {
  it('prepares supported images as native multimodal examples', () => {
    expect(
      planMediaPreparation({
        source: { name: 'product.png', sizeBytes: 2_000_000 },
        requestedModality: 'image',
        worker,
      }),
    ).toMatchObject({
      status: 'ready',
      kind: 'image',
      strategy: 'native_multimodal',
      localOnly: true,
      preservesOriginal: true,
    });
  });

  it('bounds video frame sampling and aligned audio extraction', () => {
    const plan = planMediaPreparation({
      source: { name: 'demo.mp4', sizeBytes: 500_000_000, durationSeconds: 600 },
      requestedModality: 'video',
      worker,
    });

    expect(plan).toMatchObject({
      status: 'ready',
      kind: 'video',
      strategy: 'native_multimodal',
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining(['inspect_container', 'sample_frames', 'extract_audio']),
    );
    expect(plan.limits.maxFrames).toBeGreaterThan(0);
    expect(plan.limits.maxFrames).toBeLessThanOrEqual(512);
  });

  it('offers local transcription for audio used by a text model', () => {
    expect(
      planMediaPreparation({
        source: { name: 'interview.wav', sizeBytes: 25_000_000, durationSeconds: 180 },
        requestedModality: 'text',
        worker,
      }),
    ).toMatchObject({
      status: 'ready',
      kind: 'audio',
      strategy: 'extract_to_text',
      operations: expect.arrayContaining(['transcribe_audio']),
    });
  });

  it.each(['manual.pdf', 'brief.docx'])(
    'extracts %s locally without mutating the original',
    (name) => {
      expect(
        planMediaPreparation({
          source: { name, sizeBytes: 3_000_000 },
          requestedModality: 'text',
          worker,
        }),
      ).toMatchObject({
        status: 'ready',
        kind: 'document',
        strategy: 'extract_to_text',
        preservesOriginal: true,
      });
    },
  );

  it('accepts structured training data without a media worker', () => {
    expect(
      planMediaPreparation({
        source: { name: 'examples.jsonl', sizeBytes: 4_000_000 },
        requestedModality: 'text',
        worker: null,
      }),
    ).toMatchObject({
      status: 'ready',
      kind: 'dataset',
      strategy: 'structured_examples',
    });
  });

  it('fails closed for oversized or unattested media', () => {
    expect(
      planMediaPreparation({
        source: { name: 'movie.mp4', sizeBytes: 9 * 1024 ** 3, durationSeconds: 300 },
        requestedModality: 'video',
        worker,
      }),
    ).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/size|GB/i) });
    expect(
      planMediaPreparation({
        source: { name: 'voice.wav', sizeBytes: 4_000_000, durationSeconds: 30 },
        requestedModality: 'audio',
        worker: { ...worker, attested: false },
      }),
    ).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/verified|attested/i) });
  });
});

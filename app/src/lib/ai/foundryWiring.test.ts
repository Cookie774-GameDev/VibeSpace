import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_REGISTRY,
  getProviderConnectionStatus,
  isLocalProvider,
} from './providerRegistry';
import { getModelLabelForProvider } from './providerModelCatalog';
import { LocalAdapterRegistry } from '@/features/model-foundry/adapterRegistry';

const CTX = { apiKeys: {}, offlineMode: false, plan: 'free' as const, defaultLocalModel: '' };

describe('foundry provider wiring', () => {
  it('registers foundry as a local, credential-free, non-hive provider', () => {
    expect(PROVIDER_DISPLAY_NAMES.foundry).toBe('Build Your Own AI');
    const entry = PROVIDER_REGISTRY.find((candidate) => candidate.id === 'foundry');
    expect(entry).toMatchObject({
      requiresApiKey: false,
      supportsDynamicListing: false,
      hiveEligible: false,
    });
    expect(isLocalProvider('foundry')).toBe(true);
  });

  it('fails closed to offline outside the desktop native boundary', () => {
    // jsdom has no Tauri runtime: foundry must not report a usable connection.
    expect(getProviderConnectionStatus('foundry', CTX)).toBe('offline');
  });

  it('labels promoted adapters with their reviewed project name', () => {
    window.localStorage.clear();
    const registry = new LocalAdapterRegistry(window.localStorage, () => '2026-08-16T00:00:00.000Z');
    registry.upsert(
      'proj-1',
      'job_9',
      {
        projectId: 'proj-1',
        jobId: 'job_9',
        manifestSha256: 'd'.repeat(64),
        adapterFiles: {},
        metrics: {},
        trainingConfig: {},
      },
      'Data extractor',
    );
    registry.recordEvaluation('proj-1', 'job_9', 'd'.repeat(64), {
      suite: 'private-dataset-studio',
      caseCount: 1,
      baseScore: 0,
      candidateScore: 1,
      championScore: null,
      delta: 1,
      safetyFailures: [],
      gate: 'pass',
      caseEvidence: [],
    });
    registry.promote('proj-1', 'job_9');

    expect(getModelLabelForProvider('foundry', 'proj-1--job_9', CTX)).toBe('Data extractor');
    expect(getModelLabelForProvider('foundry', 'proj-1--job_other', CTX)).toBe(
      'VibeModel adapter · proj-1--job_other',
    );
    expect(getModelLabelForProvider('foundry', '../escape', CTX)).toBe(
      'VibeModel adapter · ../escape',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { assertObservedSelection, assertPersistentServerGeneration } from './contracts';

describe('harness invariants', () => {
  it('rejects a session from another server generation', () => {
    expect(() => assertPersistentServerGeneration(
      { runtimeId: 'one', runtimeVersion: '1', serverGeneration: 'g2', healthy: true },
      { id: 's', scope: { accountId: 'a' }, serverGeneration: 'g1' },
    )).toThrow('HARNESS_SERVER_GENERATION_MISMATCH');
  });

  it('rejects silent model or effort fallback', () => {
    expect(() => assertObservedSelection(
      { connectionId: 'c', providerId: 'openai', modelId: 'gpt-5.6-sol', variant: 'max' },
      { connectionId: 'c', providerId: 'openai', modelId: 'gpt-5.6-luna', variant: 'medium' },
    )).toThrow('MODEL_OBSERVED_MISMATCH');
  });
});

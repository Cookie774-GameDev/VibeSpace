import { describe, expect, it } from 'vitest';
import { parseArtificialAnalysisPayload, validateBenchmarkRows } from './benchmarkPipeline';

function model(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `model-${index}`,
    provider: { name: index % 2 === 0 ? 'Provider A' : 'Provider B' },
    display_name: `Model ${index}`,
    intelligence_index: 70 - index,
    pricing: {
      price_1m_input_tokens: index + 1,
      price_1m_output_tokens: (index + 1) * 3,
      cost_per_task_usd: (index + 1) / 10,
    },
    median_output_tokens_per_second: 100 - index,
    median_time_to_first_token_seconds: 0.5 + index / 10,
    context_window_tokens: 128000 + index,
    is_open_weights: index % 2 === 0,
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    methodology_version: '2026.08',
    updated_at: '2026-08-14T23:00:00Z',
    data: Array.from({ length: 10 }, (_, index) => model(index)),
    ...overrides,
  };
}

describe('Artificial Analysis benchmark ingestion', () => {
  it('normalizes the supported source scale and exact row metadata', async () => {
    const dataset = await parseArtificialAnalysisPayload(validPayload());
    expect(dataset.source).toBe('Artificial Analysis');
    expect(dataset.metric).toBe('Artificial Analysis Intelligence Index');
    expect(dataset.methodologyVersion).toBe('2026.08');
    expect(dataset.sourceObservedAt).toBe('2026-08-14T23:00:00.000Z');
    expect(dataset.rows).toHaveLength(10);
    expect(dataset.rows[0]).toMatchObject({
      rank: 1,
      intelligenceIndex: 70,
      inputPricePer1MTokensUsd: 1,
      outputPricePer1MTokensUsd: 3,
      outputTokensPerSecond: 100,
      timeToFirstTokenSeconds: 0.5,
    });
  });

  it('keeps nested reasoning efforts as separate stable rows', async () => {
    const data = Array.from({ length: 9 }, (_, index) => model(index + 1));
    data.push(
      model(0, {
        display_name: 'Reasoning Model',
        intelligence_index: undefined,
        variants: [
          {
            id: 'reasoning-max',
            variant_label: 'Adaptive Reasoning',
            reasoning_effort: 'max',
            intelligence_index: 80,
          },
          {
            id: 'reasoning-xhigh',
            variant_label: 'Adaptive Reasoning',
            reasoning_effort: 'xhigh',
            intelligence_index: 79,
          },
        ],
      }),
    );
    const dataset = await parseArtificialAnalysisPayload(validPayload({ data }));
    const reasoning = dataset.rows.filter((row) => row.model === 'Reasoning Model');
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((row) => row.effort)).toEqual(['max', 'xhigh']);
    expect(new Set(reasoning.map((row) => row.id)).size).toBe(2);
  });

  it('rejects Arena/Elo values mapped into Intelligence Index', async () => {
    const data = Array.from({ length: 10 }, (_, index) =>
      model(index, { intelligence_index: index === 0 ? 1587 : 70 - index }),
    );
    await expect(parseArtificialAnalysisPayload(validPayload({ data }))).rejects.toMatchObject({
      code: 'AA_SCALE_ANOMALY',
    });
  });

  it('rejects malformed and HTML-like payloads', async () => {
    await expect(parseArtificialAnalysisPayload({ data: 'not-an-array' })).rejects.toMatchObject({
      code: 'AA_PAYLOAD_MALFORMED',
    });
    await expect(parseArtificialAnalysisPayload('<html>upstream error</html>')).rejects.toMatchObject({
      code: 'AA_PAYLOAD_MALFORMED',
    });
  });

  it('rejects duplicate exact variants instead of silently folding them', async () => {
    const data = Array.from({ length: 10 }, (_, index) => model(index));
    data[1] = { ...data[0], intelligence_index: 69 };
    await expect(parseArtificialAnalysisPayload(validPayload({ data }))).rejects.toMatchObject({
      code: 'AA_DUPLICATE_VARIANT',
    });
  });

  it('requires monotonic contiguous ranks after normalization', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: `row-${index}`,
      rank: index + 1,
      provider: index % 2 ? 'A' : 'B',
      model: `Model ${index}`,
      intelligenceIndex: index === 5 ? 90 : 70 - index,
      priceProvenance: {},
      metadata: {},
    }));
    expect(() => validateBenchmarkRows(rows)).toThrow(/increased after a lower rank/i);
  });
});

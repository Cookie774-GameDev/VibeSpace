import {
  PipelineError,
  acquirePipelineLease,
  boundedFetch,
  completePipelineRun,
  freshnessFromTimestamp,
  nowIso,
  recordSkippedLease,
  runKeyFor,
  safeErrorCode,
  sha256,
  stableJson,
  startPipelineRun,
  type Env,
  type PipelineRunResult,
} from './runtime';

export const ARTIFICIAL_ANALYSIS_API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const ARTIFICIAL_ANALYSIS_SOURCE_URL = 'https://artificialanalysis.ai/leaderboards/models';
export const ARTIFICIAL_ANALYSIS_METRIC = 'Artificial Analysis Intelligence Index' as const;

export interface BenchmarkModelRowV2 {
  id: string;
  rank: number;
  provider: string;
  model: string;
  variantLabel?: string;
  effort?: string;
  intelligenceIndex: number;
  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  endToEndSeconds?: number;
  inputPricePer1MTokensUsd?: number;
  outputPricePer1MTokensUsd?: number;
  cacheWritePricePer1MUsd?: number;
  cacheHitPricePer1MUsd?: number;
  costPerTaskUsd?: number;
  contextWindowTokens?: number;
  openWeights?: boolean;
  releaseDate?: string;
  priceProvenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ParsedBenchmarkDataset {
  source: 'Artificial Analysis';
  metric: typeof ARTIFICIAL_ANALYSIS_METRIC;
  sourceUrl: string;
  methodologyVersion: string;
  sourceObservedAt: string;
  rows: BenchmarkModelRowV2[];
  checksum: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const part of path.split('.')) {
    const next = record(cursor);
    if (!next) return undefined;
    cursor = next[part];
  }
  return cursor;
}

function firstValue(values: readonly unknown[], paths: readonly string[]): unknown {
  for (const source of values) {
    for (const path of paths) {
      const candidate = readPath(source, path);
      if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
    }
  }
  return undefined;
}

function text(values: readonly unknown[], paths: readonly string[]): string | undefined {
  const value = firstValue(values, paths);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const nested = record(value);
  if (nested) {
    for (const key of ['name', 'label', 'display_name', 'value']) {
      if (typeof nested[key] === 'string' && nested[key].trim()) return nested[key].trim();
    }
  }
  return undefined;
}

function numberValue(values: readonly unknown[], paths: readonly string[]): number | undefined {
  const value = firstValue(values, paths);
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegative(values: readonly unknown[], paths: readonly string[]): number | undefined {
  const value = numberValue(values, paths);
  return value !== undefined && value >= 0 ? value : undefined;
}

function booleanValue(values: readonly unknown[], paths: readonly string[]): boolean | undefined {
  const value = firstValue(values, paths);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === 'string') {
    if (/^(?:true|yes|open|open-weights|1)$/i.test(value)) return true;
    if (/^(?:false|no|closed|proprietary|0)$/i.test(value)) return false;
  }
  return undefined;
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function modelArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  if (!root) throw new PipelineError('AA_PAYLOAD_MALFORMED', 'Artificial Analysis returned a non-object payload.');
  for (const path of ['data', 'models', 'results', 'data.models', 'data.data', 'response.data']) {
    const value = readPath(root, path);
    if (Array.isArray(value)) return value;
  }
  throw new PipelineError('AA_PAYLOAD_MALFORMED', 'Artificial Analysis payload did not contain a model array.');
}

function nestedVariants(model: UnknownRecord): UnknownRecord[] {
  for (const key of ['variants', 'configurations', 'reasoning_variants']) {
    const value = model[key];
    if (Array.isArray(value)) {
      const variants = value.map(record).filter((entry): entry is UnknownRecord => Boolean(entry));
      if (variants.length) return variants;
    }
  }
  return [model];
}

function effortFromName(modelName: string): string | undefined {
  const match = /(?:^|[,(\s])(?:reasoning\s+)?(max|xhigh|high|medium|low|min)(?:\s+effort)?(?:[),\s]|$)/i.exec(
    modelName,
  );
  return match?.[1]?.toLowerCase();
}

function slug(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function rowFrom(sourceModel: UnknownRecord, variant: UnknownRecord): Omit<BenchmarkModelRowV2, 'rank'> {
  const values = variant === sourceModel ? [sourceModel] : [variant, sourceModel];
  const provider = text(values, [
    'provider.name',
    'provider',
    'model_creator.name',
    'model_creator',
    'creator.name',
    'creator',
    'organization.name',
    'organization',
    'company',
  ]);
  const model = text(values, [
    'display_name',
    'model_name',
    'name',
    'model.display_name',
    'model.name',
    'slug',
  ]);
  const intelligenceIndex = numberValue(values, [
    'artificial_analysis_intelligence_index',
    'intelligence_index',
    'evaluations.artificial_analysis_intelligence_index',
    'evaluations.intelligence_index',
    'scores.artificial_analysis_intelligence_index',
    'scores.intelligence_index',
    'metrics.artificial_analysis_intelligence_index',
    'metrics.intelligence_index',
  ]);
  if (!provider || !model || intelligenceIndex === undefined) {
    throw new PipelineError('AA_ROW_MISSING_REQUIRED_FIELD', 'Artificial Analysis row omitted provider, model, or Intelligence Index.');
  }
  if (intelligenceIndex < 0 || intelligenceIndex >= 200) {
    throw new PipelineError(
      'AA_SCALE_ANOMALY',
      `Artificial Analysis Intelligence Index value ${intelligenceIndex} is outside the accepted source scale.`,
    );
  }

  const variantLabel = text(values, [
    'variant_label',
    'variant_name',
    'variant',
    'configuration.label',
    'configuration.name',
    'reasoning_mode',
    'reasoning.mode',
  ]);
  const effort =
    text(values, ['effort', 'reasoning_effort', 'reasoning.effort', 'configuration.effort'])?.toLowerCase() ??
    effortFromName(`${model} ${variantLabel ?? ''}`);
  const sourceId = text(values, ['id', 'model_id', 'slug', 'uuid']);
  const id = [provider, model, variantLabel ?? '', effort ?? '', sourceId ?? '']
    .map(slug)
    .filter(Boolean)
    .join('|');
  if (!id) throw new PipelineError('AA_ROW_ID_INVALID', 'Artificial Analysis row identity was empty.');

  const inputPricePer1MTokensUsd = nonNegative(values, [
    'pricing.price_1m_input_tokens',
    'pricing.input_price_per_1m_tokens',
    'pricing.input',
    'price_1m_input_tokens',
    'input_price_per_1m_tokens',
    'input_price',
  ]);
  const outputPricePer1MTokensUsd = nonNegative(values, [
    'pricing.price_1m_output_tokens',
    'pricing.output_price_per_1m_tokens',
    'pricing.output',
    'price_1m_output_tokens',
    'output_price_per_1m_tokens',
    'output_price',
  ]);
  const priceProvenance: Record<string, unknown> = {};
  if (inputPricePer1MTokensUsd !== undefined || outputPricePer1MTokensUsd !== undefined) {
    priceProvenance.source = 'Artificial Analysis API v2';
    priceProvenance.sourceUrl = ARTIFICIAL_ANALYSIS_SOURCE_URL;
  }

  const releaseDate = text(values, ['release_date', 'released_at', 'model.release_date']);
  return {
    id,
    provider,
    model,
    ...(variantLabel ? { variantLabel } : {}),
    ...(effort ? { effort } : {}),
    intelligenceIndex,
    outputTokensPerSecond: nonNegative(values, [
      'median_output_tokens_per_second',
      'output_tokens_per_second',
      'performance.output_tokens_per_second',
      'speed.output_tokens_per_second',
    ]),
    timeToFirstTokenSeconds: nonNegative(values, [
      'median_time_to_first_token_seconds',
      'time_to_first_token_seconds',
      'performance.time_to_first_token_seconds',
      'latency.time_to_first_token_seconds',
    ]),
    endToEndSeconds: nonNegative(values, [
      'median_end_to_end_seconds',
      'end_to_end_seconds',
      'performance.end_to_end_seconds',
    ]),
    inputPricePer1MTokensUsd,
    outputPricePer1MTokensUsd,
    cacheWritePricePer1MUsd: nonNegative(values, [
      'pricing.cache_write_price_per_1m_tokens',
      'cache_write_price_per_1m_tokens',
    ]),
    cacheHitPricePer1MUsd: nonNegative(values, [
      'pricing.cache_hit_price_per_1m_tokens',
      'pricing.cached_input_price_per_1m_tokens',
      'cache_hit_price_per_1m_tokens',
    ]),
    costPerTaskUsd: nonNegative(values, [
      'cost_per_task_usd',
      'evaluations.cost_per_task_usd',
      'pricing.cost_per_task_usd',
    ]),
    contextWindowTokens: nonNegative(values, [
      'context_window_tokens',
      'context_window',
      'model.context_window_tokens',
    ]),
    openWeights: booleanValue(values, ['open_weights', 'is_open_weights', 'model.open_weights']),
    ...(releaseDate ? { releaseDate } : {}),
    priceProvenance,
    metadata: {
      sourceModelId: text([sourceModel], ['id', 'model_id', 'slug', 'uuid']) ?? null,
      sourceVariantId: text([variant], ['id', 'variant_id', 'slug', 'uuid']) ?? null,
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export function validateBenchmarkRows(rows: readonly BenchmarkModelRowV2[]): void {
  if (rows.length < 10 || rows.length > 500) {
    throw new PipelineError('AA_ROW_COUNT_ANOMALY', `Artificial Analysis returned ${rows.length} usable rows.`);
  }
  const ids = new Set<string>();
  const ranks = new Set<number>();
  const providers = new Set<string>();
  let priorScore = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!row.id || !row.provider || !row.model || !Number.isFinite(row.intelligenceIndex)) {
      throw new PipelineError('AA_ROW_MISSING_REQUIRED_FIELD', 'A benchmark row failed required-field validation.');
    }
    if (row.intelligenceIndex < 0 || row.intelligenceIndex >= 200) {
      throw new PipelineError('AA_SCALE_ANOMALY', 'Arena/Elo-style values cannot be promoted as Intelligence Index.');
    }
    if (ids.has(row.id)) throw new PipelineError('AA_DUPLICATE_VARIANT', `Duplicate exact variant identity: ${row.id}`);
    if (ranks.has(row.rank)) throw new PipelineError('AA_DUPLICATE_RANK', `Duplicate rank: ${row.rank}`);
    ids.add(row.id);
    ranks.add(row.rank);
    providers.add(row.provider);
    if (row.intelligenceIndex > priorScore) {
      throw new PipelineError('AA_RANK_ORDER_ANOMALY', 'Intelligence scores increased after a lower rank.');
    }
    priorScore = row.intelligenceIndex;
  }
  if (providers.size < 2) throw new PipelineError('AA_PROVIDER_ANOMALY', 'Artificial Analysis payload contained fewer than two providers.');
  const scoreMedian = median(rows.map((row) => row.intelligenceIndex));
  if (scoreMedian >= 150) throw new PipelineError('AA_SCALE_ANOMALY', 'Median score resembles Arena/Elo rather than Intelligence Index.');
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.rank !== index + 1) {
      throw new PipelineError('AA_RANK_GAP', 'Artificial Analysis ranks are not contiguous after normalization.');
    }
  }
}

export async function parseArtificialAnalysisPayload(
  payload: unknown,
  observedAt = nowIso(),
): Promise<ParsedBenchmarkDataset> {
  const root = record(payload);
  const flattened: Array<Omit<BenchmarkModelRowV2, 'rank'> & { explicitRank?: number }> = [];
  for (const rawModel of modelArray(payload)) {
    const sourceModel = record(rawModel);
    if (!sourceModel) throw new PipelineError('AA_ROW_MALFORMED', 'Artificial Analysis model row was not an object.');
    for (const variant of nestedVariants(sourceModel)) {
      const normalized = rowFrom(sourceModel, variant);
      const explicitRank = numberValue([variant, sourceModel], ['rank', 'ranking', 'intelligence_rank']);
      flattened.push({
        ...normalized,
        ...(explicitRank && Number.isInteger(explicitRank) && explicitRank >= 1 ? { explicitRank } : {}),
      });
    }
  }

  const allExplicit = flattened.length > 0 && flattened.every((row) => row.explicitRank !== undefined);
  flattened.sort((left, right) => {
    if (allExplicit) return (left.explicitRank ?? 0) - (right.explicitRank ?? 0);
    return (
      right.intelligenceIndex - left.intelligenceIndex ||
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model) ||
      (left.effort ?? '').localeCompare(right.effort ?? '')
    );
  });
  const rows: BenchmarkModelRowV2[] = flattened.map(({ explicitRank: _explicitRank, ...row }, index) => ({
    ...row,
    rank: index + 1,
  }));
  validateBenchmarkRows(rows);

  const sourceObservedAt = timestamp(
    firstValue([root], [
      'last_updated',
      'updated_at',
      'generated_at',
      'data_updated_at',
      'metadata.updated_at',
      'meta.updated_at',
    ]),
    observedAt,
  );
  const methodologyVersion =
    text([root], [
      'methodology_version',
      'methodology.version',
      'metadata.methodology_version',
      'meta.methodology_version',
      'version',
    ]) ?? 'not-exposed-by-api-v2';
  const checksum = await sha256(
    stableJson(
      rows.map((row) => ({
        id: row.id,
        rank: row.rank,
        intelligenceIndex: row.intelligenceIndex,
        outputTokensPerSecond: row.outputTokensPerSecond ?? null,
        timeToFirstTokenSeconds: row.timeToFirstTokenSeconds ?? null,
        inputPricePer1MTokensUsd: row.inputPricePer1MTokensUsd ?? null,
        outputPricePer1MTokensUsd: row.outputPricePer1MTokensUsd ?? null,
        costPerTaskUsd: row.costPerTaskUsd ?? null,
        contextWindowTokens: row.contextWindowTokens ?? null,
      })),
    ),
  );

  return {
    source: 'Artificial Analysis',
    metric: ARTIFICIAL_ANALYSIS_METRIC,
    sourceUrl: ARTIFICIAL_ANALYSIS_SOURCE_URL,
    methodologyVersion,
    sourceObservedAt,
    rows,
    checksum,
  };
}

async function promoteDataset(
  db: D1Database,
  dataset: ParsedBenchmarkDataset,
  ingestedAt: string,
): Promise<string> {
  const datasetId = `aa-${dataset.sourceObservedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${dataset.checksum.slice(0, 16)}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO benchmark_datasets_v2
          (id, source, metric, source_url, methodology_version, source_observed_at,
           ingested_at, row_count, status, checksum, metadata_json)
         VALUES (?, 'Artificial Analysis', ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ingested_at = excluded.ingested_at,
           row_count = excluded.row_count,
           status = 'candidate',
           checksum = excluded.checksum,
           error_code = NULL,
           metadata_json = excluded.metadata_json`,
      )
      .bind(
        datasetId,
        dataset.metric,
        dataset.sourceUrl,
        dataset.methodologyVersion,
        dataset.sourceObservedAt,
        ingestedAt,
        dataset.rows.length,
        dataset.checksum,
        JSON.stringify({ api: 'v2', validated: true }),
      ),
    db.prepare('DELETE FROM benchmark_rows_v2 WHERE dataset_id = ?').bind(datasetId),
  ];
  for (const row of dataset.rows) {
    statements.push(
      db
        .prepare(
          `INSERT INTO benchmark_rows_v2
            (dataset_id, row_id, rank, provider, model, variant_label, effort,
             intelligence_index, output_tokens_per_second, time_to_first_token_seconds,
             end_to_end_seconds, input_price_per_1m_usd, output_price_per_1m_usd,
             cache_write_price_per_1m_usd, cache_hit_price_per_1m_usd,
             cost_per_task_usd, context_window_tokens, open_weights, release_date,
             price_provenance_json, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          datasetId,
          row.id,
          row.rank,
          row.provider,
          row.model,
          row.variantLabel ?? null,
          row.effort ?? null,
          row.intelligenceIndex,
          row.outputTokensPerSecond ?? null,
          row.timeToFirstTokenSeconds ?? null,
          row.endToEndSeconds ?? null,
          row.inputPricePer1MTokensUsd ?? null,
          row.outputPricePer1MTokensUsd ?? null,
          row.cacheWritePricePer1MUsd ?? null,
          row.cacheHitPricePer1MUsd ?? null,
          row.costPerTaskUsd ?? null,
          row.contextWindowTokens ?? null,
          row.openWeights === undefined ? null : row.openWeights ? 1 : 0,
          row.releaseDate ?? null,
          JSON.stringify(row.priceProvenance),
          JSON.stringify(row.metadata),
        ),
    );
  }
  statements.push(
    db
      .prepare("UPDATE benchmark_datasets_v2 SET status = 'superseded' WHERE status = 'current' AND id <> ?")
      .bind(datasetId),
    db.prepare("UPDATE benchmark_datasets_v2 SET status = 'current' WHERE id = ?").bind(datasetId),
    db
      .prepare(
        `INSERT INTO benchmark_current_v2(singleton, dataset_id, promoted_at)
         VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           dataset_id = excluded.dataset_id,
           promoted_at = excluded.promoted_at`,
      )
      .bind(datasetId, ingestedAt),
  );
  await db.batch(statements);
  return datasetId;
}

export async function runBenchmarkIngestion(
  env: Env,
  scheduledAt: string,
): Promise<PipelineRunResult> {
  const pipeline = 'benchmarks-hourly' as const;
  const runKey = runKeyFor(pipeline, scheduledAt);
  const lease = await acquirePipelineLease(env.DB, pipeline, runKey, nowIso());
  if (!lease) {
    await recordSkippedLease(env.DB, pipeline);
    return {
      pipeline,
      runKey,
      status: 'skipped',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 0,
      metadata: { reason: 'lease-held-or-duplicate' },
    };
  }
  const runId = await startPipelineRun(env.DB, lease, scheduledAt);
  if (!runId) {
    await recordSkippedLease(env.DB, pipeline);
    return {
      pipeline,
      runKey,
      status: 'skipped',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 0,
      metadata: { reason: 'duplicate-run' },
    };
  }

  let result: PipelineRunResult;
  try {
    if (!env.AA_API_KEY?.trim()) {
      throw new PipelineError(
        'AA_API_KEY_MISSING',
        'Artificial Analysis API access is not configured. The last-known-good dataset remains current.',
      );
    }
    const fetched = await boundedFetch(ARTIFICIAL_ANALYSIS_API_URL, {
      headers: { 'x-api-key': env.AA_API_KEY.trim() },
      accept: 'application/json',
      timeoutMs: 10_000,
      maxBytes: 4_000_000,
      maxRedirects: 2,
      retries: 1,
    });
    if (/text\/html/i.test(fetched.contentType) || /^\s*</.test(fetched.text)) {
      throw new PipelineError('AA_HTML_RESPONSE', 'Artificial Analysis returned HTML instead of model data.');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(fetched.text);
    } catch {
      throw new PipelineError('AA_JSON_INVALID', 'Artificial Analysis returned invalid JSON.');
    }
    const dataset = await parseArtificialAnalysisPayload(payload, nowIso());
    const datasetId = await promoteDataset(env.DB, dataset, nowIso());
    result = {
      pipeline,
      runKey,
      status: 'success',
      fetchedCount: dataset.rows.length,
      storedCount: dataset.rows.length,
      succeededSources: 1,
      failedSources: 0,
      metadata: {
        datasetId,
        checksum: dataset.checksum,
        sourceObservedAt: dataset.sourceObservedAt,
        methodologyVersion: dataset.methodologyVersion,
        topRow: dataset.rows[0]
          ? {
              id: dataset.rows[0].id,
              rank: dataset.rows[0].rank,
              intelligenceIndex: dataset.rows[0].intelligenceIndex,
            }
          : null,
      },
    };
  } catch (error) {
    result = {
      pipeline,
      runKey,
      status: 'failed',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 1,
      metadata: { retainedLastKnownGood: true },
      errors: [{ code: safeErrorCode(error, 'AA_INGESTION_FAILED') }],
    };
  }
  await completePipelineRun(env.DB, lease, runId, result);
  return result;
}

interface DatasetRow {
  id: string;
  source: string;
  metric: string;
  source_url: string;
  methodology_version: string | null;
  source_observed_at: string;
  ingested_at: string;
  row_count: number;
  checksum: string | null;
  promoted_at: string;
}

interface StoredBenchmarkRow {
  row_id: string;
  rank: number;
  provider: string;
  model: string;
  variant_label: string | null;
  effort: string | null;
  intelligence_index: number;
  output_tokens_per_second: number | null;
  time_to_first_token_seconds: number | null;
  end_to_end_seconds: number | null;
  input_price_per_1m_usd: number | null;
  output_price_per_1m_usd: number | null;
  cache_write_price_per_1m_usd: number | null;
  cache_hit_price_per_1m_usd: number | null;
  cost_per_task_usd: number | null;
  context_window_tokens: number | null;
  open_weights: number | null;
  release_date: string | null;
}

export async function readBenchmarkApi(env: Env): Promise<Record<string, unknown>> {
  const dataset = await env.DB
    .prepare(
      `SELECT d.*, c.promoted_at
       FROM benchmark_current_v2 c
       JOIN benchmark_datasets_v2 d ON d.id = c.dataset_id
       WHERE c.singleton = 1 AND d.status = 'current'
       LIMIT 1`,
    )
    .first<DatasetRow>();
  const generatedAt = nowIso();
  if (!dataset) {
    return {
      generatedAt,
      freshness: freshnessFromTimestamp(null),
      dataset: null,
      rows: [],
    };
  }
  const stored = await env.DB
    .prepare('SELECT * FROM benchmark_rows_v2 WHERE dataset_id = ? ORDER BY rank ASC')
    .bind(dataset.id)
    .all<StoredBenchmarkRow>();
  const slaMinutes = Number.parseInt(env.FRESHNESS_SLA_MINUTES ?? '120', 10) || 120;
  return {
    generatedAt,
    freshness: freshnessFromTimestamp(dataset.promoted_at, Date.now(), slaMinutes),
    dataset: {
      source: 'Artificial Analysis',
      metric: ARTIFICIAL_ANALYSIS_METRIC,
      sourceUrl: dataset.source_url,
      methodologyVersion: dataset.methodology_version ?? undefined,
      sourceObservedAt: dataset.source_observed_at,
      ingestedAt: dataset.ingested_at,
      rowCount: dataset.row_count,
      checksum: dataset.checksum ?? undefined,
    },
    rows: stored.results.map((row) => ({
      id: row.row_id,
      rank: row.rank,
      provider: row.provider,
      model: row.model,
      variantLabel: row.variant_label ?? undefined,
      effort: row.effort ?? undefined,
      intelligenceIndex: row.intelligence_index,
      outputTokensPerSecond: row.output_tokens_per_second ?? undefined,
      timeToFirstTokenSeconds: row.time_to_first_token_seconds ?? undefined,
      endToEndSeconds: row.end_to_end_seconds ?? undefined,
      inputPricePer1MTokensUsd: row.input_price_per_1m_usd ?? undefined,
      outputPricePer1MTokensUsd: row.output_price_per_1m_usd ?? undefined,
      cacheWritePricePer1MUsd: row.cache_write_price_per_1m_usd ?? undefined,
      cacheHitPricePer1MUsd: row.cache_hit_price_per_1m_usd ?? undefined,
      costPerTaskUsd: row.cost_per_task_usd ?? undefined,
      contextWindowTokens: row.context_window_tokens ?? undefined,
      openWeights: row.open_weights == null ? undefined : row.open_weights === 1,
      releaseDate: row.release_date ?? undefined,
      sourceName: 'Artificial Analysis',
      sourceUrl: dataset.source_url,
      methodologyVersion: dataset.methodology_version ?? undefined,
      sourceObservedAt: dataset.source_observed_at,
      ingestedAt: dataset.ingested_at,
    })),
  };
}

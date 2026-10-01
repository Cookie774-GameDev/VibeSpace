const SAFE_CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export const MAX_ADDRESSABLE_CORPUS_TOKENS = 10_000_000_000_000_000n;

export interface CorpusScaleMetadata {
  corpusId: string;
  totalTokens: bigint;
  indexedTokens: bigint;
  chunkCount: bigint;
  shardCount: bigint;
  contentDigest: `sha256:${string}`;
  generatedAt: number;
}

export interface SerializedCorpusScaleMetadata {
  version: 1;
  corpusId: string;
  totalTokens: string;
  indexedTokens: string;
  chunkCount: string;
  shardCount: string;
  contentDigest: `sha256:${string}`;
  generatedAt: number;
}

export type CorpusTokenCountInput = bigint | number | string;
export type CorpusTokenAddress = Readonly<{
  position: string;
  shard: string;
  offset: string;
}>;

export class CorpusScaleError extends Error {
  constructor(readonly detail: string) {
    super(`invalid_corpus_scale_metadata:${detail}`);
    this.name = 'CorpusScaleError';
  }
}

export function parseCorpusTokenCount(value: CorpusTokenCountInput, field = 'token_count'): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CorpusScaleError(field);
    parsed = BigInt(value);
  } else if (typeof value === 'string' && CANONICAL_DECIMAL.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new CorpusScaleError(field);
  }
  if (parsed < 0n || parsed > MAX_ADDRESSABLE_CORPUS_TOKENS) {
    throw new CorpusScaleError(field);
  }
  return parsed;
}

function safeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

export function createCorpusScaleMetadata(input: {
  corpusId: string;
  totalTokens: CorpusTokenCountInput;
  indexedTokens: CorpusTokenCountInput;
  chunkCount: CorpusTokenCountInput;
  shardCount: CorpusTokenCountInput;
  contentDigest: string;
  generatedAt: number;
}): Readonly<CorpusScaleMetadata> {
  if (!SAFE_CORPUS_ID.test(input.corpusId)) throw new CorpusScaleError('corpus_id');
  if (!SHA256_DIGEST.test(input.contentDigest)) throw new CorpusScaleError('content_digest');
  if (!safeTimestamp(input.generatedAt)) throw new CorpusScaleError('generated_at');
  const totalTokens = parseCorpusTokenCount(input.totalTokens, 'total_tokens');
  const indexedTokens = parseCorpusTokenCount(input.indexedTokens, 'indexed_tokens');
  const chunkCount = parseCorpusTokenCount(input.chunkCount, 'chunk_count');
  const shardCount = parseCorpusTokenCount(input.shardCount, 'shard_count');
  if (indexedTokens > totalTokens) throw new CorpusScaleError('indexed_tokens_exceed_total');
  if (indexedTokens > 0n && (chunkCount === 0n || shardCount === 0n)) {
    throw new CorpusScaleError('indexed_corpus_requires_chunks_and_shards');
  }
  if (indexedTokens === 0n && (chunkCount !== 0n || shardCount !== 0n)) {
    throw new CorpusScaleError('empty_index_has_counts');
  }
  return Object.freeze({
    corpusId: input.corpusId,
    totalTokens,
    indexedTokens,
    chunkCount,
    shardCount,
    contentDigest: input.contentDigest as `sha256:${string}`,
    generatedAt: input.generatedAt,
  });
}

export function serializeCorpusScaleMetadata(
  metadata: Readonly<CorpusScaleMetadata>,
): Readonly<SerializedCorpusScaleMetadata> {
  const validated = createCorpusScaleMetadata(metadata);
  return Object.freeze({
    version: 1,
    corpusId: validated.corpusId,
    totalTokens: validated.totalTokens.toString(10),
    indexedTokens: validated.indexedTokens.toString(10),
    chunkCount: validated.chunkCount.toString(10),
    shardCount: validated.shardCount.toString(10),
    contentDigest: validated.contentDigest,
    generatedAt: validated.generatedAt,
  });
}

export function parseSerializedCorpusScaleMetadata(
  value: Readonly<SerializedCorpusScaleMetadata>,
): Readonly<CorpusScaleMetadata> {
  if (value.version !== 1) throw new CorpusScaleError('version');
  return createCorpusScaleMetadata(value);
}

export function locateCorpusTokenPosition(
  metadata: Readonly<CorpusScaleMetadata>,
  positionInput: CorpusTokenCountInput,
  shardSizeInput: CorpusTokenCountInput,
): CorpusTokenAddress {
  const validated = createCorpusScaleMetadata(metadata);
  const position = parseCorpusTokenCount(positionInput, 'position');
  const shardSize = parseCorpusTokenCount(shardSizeInput, 'shard_size');
  if (shardSize === 0n) throw new CorpusScaleError('shard_size');
  if (position >= validated.totalTokens) throw new CorpusScaleError('position_out_of_range');
  return Object.freeze({
    position: position.toString(10),
    shard: (position / shardSize).toString(10),
    offset: (position % shardSize).toString(10),
  });
}

export function parseCorpusTokenAddressQuery(
  metadata: Readonly<CorpusScaleMetadata>,
  query: string,
  shardSize: CorpusTokenCountInput,
): CorpusTokenAddress {
  const match = /^token:(0|[1-9][0-9]*)$/u.exec(query);
  if (!match) throw new CorpusScaleError('token_query');
  return locateCorpusTokenPosition(metadata, match[1]!, shardSize);
}

export function serializeCorpusTokenAddressRoute(address: CorpusTokenAddress): string {
  const position = parseCorpusTokenCount(address.position, 'position');
  const shard = parseCorpusTokenCount(address.shard, 'shard');
  const offset = parseCorpusTokenCount(address.offset, 'offset');
  return `token:${position.toString(10)};shard:${shard.toString(10)};offset:${offset.toString(10)}`;
}

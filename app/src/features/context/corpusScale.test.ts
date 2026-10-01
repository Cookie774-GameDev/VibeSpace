import { describe, expect, it } from 'vitest';
import {
  CorpusScaleError,
  MAX_ADDRESSABLE_CORPUS_TOKENS,
  createCorpusScaleMetadata,
  locateCorpusTokenPosition,
  parseCorpusTokenAddressQuery,
  parseCorpusTokenCount,
  parseSerializedCorpusScaleMetadata,
  serializeCorpusTokenAddressRoute,
  serializeCorpusScaleMetadata,
} from './corpusScale';

const digest = `sha256:${'a'.repeat(64)}`;

function metadata(totalTokens: bigint) {
  return createCorpusScaleMetadata({
    corpusId: 'vibespace-pr31-addressing',
    totalTokens,
    indexedTokens: totalTokens,
    chunkCount: totalTokens / 2_048n + 1n,
    shardCount: totalTokens / 1_000_000n + 1n,
    contentDigest: digest,
    generatedAt: 1_700_000_000_000,
  });
}

describe('corpus-scale metadata', () => {
  it.each([
    1_000_000_000n,
    10_000_000_000n,
    10_000_000_001n,
    100_000_000_000n,
    9_007_199_254_740_993n,
  ])('round-trips the exact logical token address %s canonically', (tokenCount) => {
    const serialized = serializeCorpusScaleMetadata(metadata(tokenCount));
    expect(serialized.totalTokens).toBe(tokenCount.toString(10));
    expect(parseSerializedCorpusScaleMetadata(serialized).totalTokens).toBe(tokenCount);
  });

  it('rejects overflow, unsafe numbers, negative and non-canonical inputs', () => {
    expect(() => parseCorpusTokenCount(MAX_ADDRESSABLE_CORPUS_TOKENS + 1n)).toThrow(
      CorpusScaleError,
    );
    expect(() => parseCorpusTokenCount(Number.MAX_SAFE_INTEGER + 1)).toThrow(CorpusScaleError);
    expect(() => parseCorpusTokenCount(-1n)).toThrow(CorpusScaleError);
    expect(() => parseCorpusTokenCount('01')).toThrow(CorpusScaleError);
    expect(() => parseCorpusTokenCount('1e10')).toThrow(CorpusScaleError);
  });

  it.each([
    [999_999_999n, '999', '999999'],
    [1_000_000_000n, '1000', '0'],
    [10_000_000_000n, '10000', '0'],
    [10_000_000_001n, '10000', '1'],
    [9_007_199_254_740_993n, '9007199254', '740993'],
  ])(
    'selects the exact deterministic shard and offset for logical position %s',
    (position, shard, offset) => {
      expect(
        locateCorpusTokenPosition(metadata(10_000_000_000_000_000n), position, 1_000_000n),
      ).toEqual({
        position: position.toString(10),
        shard,
        offset,
      });
    },
  );

  it('fails closed when indexed counts contradict the corpus total', () => {
    expect(() =>
      createCorpusScaleMetadata({
        corpusId: 'vibespace-pr31-addressing',
        totalTokens: 10n,
        indexedTokens: 11n,
        chunkCount: 1n,
        shardCount: 1n,
        contentDigest: digest,
        generatedAt: 1,
      }),
    ).toThrowError('invalid_corpus_scale_metadata:indexed_tokens_exceed_total');
  });

  it.each([
    [1_000_000_000n, 999_999_999n],
    [10_000_000_000n, 9_999_999_999n],
    [10_000_000_001n, 10_000_000_000n],
    [100_000_000_000n, 99_999_999_999n],
  ])('accepts the last exact address and rejects corpus size %s as out of range', (size, last) => {
    expect(locateCorpusTokenPosition(metadata(size), last, 1_000_000n).position).toBe(
      last.toString(10),
    );
    expect(() => locateCorpusTokenPosition(metadata(size), size, 1_000_000n)).toThrowError(
      'invalid_corpus_scale_metadata:position_out_of_range',
    );
  });

  it.each([
    [1_000_000_002n, 999_999_999n, '999', '999999'],
    [1_000_000_002n, 1_000_000_000n, '1000', '0'],
    [1_000_000_002n, 1_000_000_001n, '1000', '1'],
    [10_000_000_002n, 9_999_999_999n, '9999', '999999'],
    [10_000_000_002n, 10_000_000_000n, '10000', '0'],
    [10_000_000_002n, 10_000_000_001n, '10000', '1'],
    [100_000_000_002n, 99_999_999_999n, '99999', '999999'],
    [100_000_000_002n, 100_000_000_000n, '100000', '0'],
    [100_000_000_002n, 100_000_000_001n, '100000', '1'],
    [MAX_ADDRESSABLE_CORPUS_TOKENS, 9_007_199_254_740_991n, '9007199254', '740991'],
    [MAX_ADDRESSABLE_CORPUS_TOKENS, 9_007_199_254_740_992n, '9007199254', '740992'],
    [MAX_ADDRESSABLE_CORPUS_TOKENS, 9_007_199_254_740_993n, '9007199254', '740993'],
  ])('parses and routes canonical token address %s/%s exactly', (size, position, shard, offset) => {
    const address = parseCorpusTokenAddressQuery(
      metadata(size),
      `token:${position.toString(10)}`,
      1_000_000n,
    );
    expect(address).toEqual({
      position: position.toString(10),
      shard,
      offset,
    });
    expect(serializeCorpusTokenAddressRoute(address)).toBe(
      `token:${position.toString(10)};shard:${shard};offset:${offset}`,
    );
  });

  it.each(['token:01', 'token:1e10', 'token:+1', 'token:1.0', ' token:1', 'token:1 '])(
    'rejects noncanonical logical token query %s',
    (query) => {
      expect(() => parseCorpusTokenAddressQuery(metadata(100n), query, 10n)).toThrow(
        CorpusScaleError,
      );
    },
  );

  it('serializes every bigint field as canonical decimal JSON data', () => {
    const serialized = serializeCorpusScaleMetadata(metadata(10_000_000_001n));
    expect(serialized).toEqual({
      version: 1,
      corpusId: 'vibespace-pr31-addressing',
      totalTokens: '10000000001',
      indexedTokens: '10000000001',
      chunkCount: '4882813',
      shardCount: '10001',
      contentDigest: digest,
      generatedAt: 1_700_000_000_000,
    });
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });
});

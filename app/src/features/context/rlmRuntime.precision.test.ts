import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRlmRuntime, type RlmChildRequest, type RlmSynthesisRequest } from './rlmRuntime';
import { createContextPointer, createContextRecord } from './losslessContext';

const scope = { accountId: 'precision-account', projectId: 'precision-project' };
const executionIdentity = {
  transportConnectionId: 'opencode-cli', transportAdapterId: 'opencode-persistent',
  upstreamProviderId: 'openai', upstreamModelId: 'gpt-6-luna',
  providerQualifiedModelId: 'openai/gpt-6-luna', authBillingRoute: 'opencode-provider-session',
  effort: 'low', fastVariant: 'standard', catalogRevision: `sha256:${'b'.repeat(64)}`,
  observedProviderIdentity: 'openai/gpt-6-luna',
};
const budget = { maxDepth: 1, maxSubcalls: 1, maxConcurrentSubcalls: 1,
  maxWallTimeMs: 1000, maxToolCalls: 8, maxOpenBytes: 200000 };

function fixture(name: string, text: string) {
  const hash = createHash('sha256').update(text).digest('hex');
  const record = createContextRecord({ id: name, ...scope, sourceKind: 'file_version',
    sourceId: name, createdAt: 1, contentHash: hash, contentRef: `asset://${name}`,
    trustLevel: 'app_verified' });
  const pointer = createContextPointer({ id: `ptr:${name}`, recordId: name,
    byteStart: 0, byteEnd: Buffer.byteLength(text), sourceVersion: `sha256:${hash}`,
    contentHash: hash });
  return { record, pointer, text, preview: text.slice(0, 100), score: 1 };
}

async function run(question: string, documents: ReturnType<typeof fixture>[]) {
  // Production literal index queries intersect their words. Preserve that
  // property so losing the requested attribute admits the unrelated source.
  const search = vi.fn(async ({ query }: { query: string }) => ({
    items: documents.filter(document => query.toLowerCase().split(/\s+/u)
      .every(term => document.text.toLowerCase().includes(term))),
    truncated: false, indexAvailable: true, stale: false,
  }));
  const open = vi.fn(async ({ pointer }: { pointer: { recordId: string } }) => {
    const document = documents.find(item => item.record.id === pointer.recordId)!;
    return { status: 'current' as const, record: document.record, pointer: document.pointer,
      text: document.text, byteStart: 0, byteEnd: Buffer.byteLength(document.text),
      lineStart: 1, lineEnd: document.text.split('\n').length, truncated: false };
  });
  const childRunner = vi.fn(async (request: RlmChildRequest) => ({
    answer: 'source-only fixture analysis', citations: request.sourcePointers,
  }));
  const runtime = createRlmRuntime({ contextTools: { search, open }, childRunner,
    synthesize: async (request: RlmSynthesisRequest) => ({
      answer: 'source-only fixture analysis', citations: request.evidence.map(item => item.pointer),
    }) });
  const result = await runtime.investigate({ question, scope, executionIdentity, budget });
  return { search, open, childRunner, result };
}

describe('factual attribute survives acronym retrieval narrowing', () => {
  it('retrieves the owner charter without the irrelevant long inspection log', async () => {
    const charter = 'PROJECT: BLUE KITE\nOwner: Mira Chen\nDepot: Cedar\nCurrent launch date: 2026-10-20\nAuthority: signed release record overrides planning notes.\n';
    const longLog = Array.from({ length: 2500 }, (_, index) =>
      `Log ${index + 1}: Routine synthetic inspection, no launch authority.\n`).join('') +
      'Log 2501: BLUE KITE cold-chain maximum is 7 hours.\n';
    const documents = [fixture('charter.txt', charter), fixture('long-log.txt', longLog)];
    const question = 'Who owns BLUE KITE? Please ground this in the project records and cite the source.';
    const result = await run(question, documents);
    expect(Buffer.byteLength(charter)).toBe(140);
    expect(result.search.mock.calls[0][0].query).toMatch(/\bowner\b/iu);
    expect(result.open.mock.calls.map(call => call[0].pointer.recordId)).toEqual(['charter.txt']);
    expect(result.result.trace.usage.openBytes).toBe(140);
    expect(result.childRunner.mock.calls[0][0].question).toBe(question);
  });

  it.each(['Who owns DELTA ORBIT?', 'Who is the owner of DELTA ORBIT records?',
    'Which depot is current for DELTA ORBIT?'])('keeps factual scope for another entity: %s', async question => {
    const attribute = /depot/iu.test(question) ? 'depot' : 'owner';
    const result = await run(question, [
      fixture('answer', 'PROJECT: DELTA ORBIT. Owner: Lena. Depot: Willow.'),
      fixture('irrelevant', 'DELTA ORBIT routine inspection.'),
    ]);
    expect(result.search.mock.calls[0][0].query).toMatch(new RegExp(`\\b${attribute}\\b`, 'iu'));
    expect(result.search.mock.calls[0][0].query).toContain('DELTA ORBIT');
    expect(result.open.mock.calls.map(call => call[0].pointer.recordId)).toEqual(['answer']);
  });
});

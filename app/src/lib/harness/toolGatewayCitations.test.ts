import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalContextUri,
  clearToolGatewayContextCitationItems,
  consumeToolGatewayContextCitationItems,
  contextCitationItem,
  registerToolGatewayFallbackCitations,
  replaceToolGatewayContextCitationItems,
} from './toolGatewayCitations';

describe('tool Gateway citation authority', () => {
  beforeEach(() => clearToolGatewayContextCitationItems());

  it('creates canonical private app-verified citation handles without exposing receipt text', () => {
    expect(canonicalContextUri('receipt', 'abc')).toBe('vibespace:context/receipt/616263');
    expect(canonicalContextUri('source', 'source:one')).toBe(
      'vibespace:context/source/source%3Aone',
    );
    const item = contextCitationItem({
      id: 'receipt-private',
      kind: 'receipt',
      label: 'Context receipt',
      accountId: 'account-1',
      projectId: 'project-1',
      observedAt: 123,
    });
    expect(item).toMatchObject({
      purpose: 'citation',
      freshness: 'current',
      truncated: false,
      source: {
        id: 'receipt-private',
        kind: 'tool_result',
        accountId: 'account-1',
        projectId: 'project-1',
        trust: 'app_verified',
        origin: 'app_observed',
        sensitivity: 'private',
        observedAt: 123,
      },
    });
    expect(item.source.uri).toBe(
      'vibespace:context/receipt/726563656970742d70726976617465',
    );
  });

  it('consumes citations exactly once and returns a detached frozen snapshot', () => {
    const original = contextCitationItem({
      id: 'ptr:one',
      kind: 'evidence',
      label: 'Context evidence handle',
      accountId: 'account-1',
      projectId: 'project-1',
      observedAt: 456,
    });
    replaceToolGatewayContextCitationItems('session-1', [original]);
    const consumed = consumeToolGatewayContextCitationItems('session-1');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).not.toBe(original);
    expect(consumed[0]!.source).not.toBe(original.source);
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed[0])).toBe(true);
    expect(consumeToolGatewayContextCitationItems('session-1')).toEqual([]);
  });

  it('registers validated fallback evidence once and rejects unsafe identifiers atomically', () => {
    const valid = {
      pointerId: 'ptr:rlm:abc123:0:512',
      recordId: 'record-fallback',
      sourceRevision: 'sha256:' + 'a'.repeat(64),
      contentHash: 'a'.repeat(64),
    };
    registerToolGatewayFallbackCitations(
      'session-fallback',
      [valid, valid],
      { accountId: 'account-1', projectId: 'project-1' },
    );
    const items = consumeToolGatewayContextCitationItems('session-fallback');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      purpose: 'citation',
      source: {
        id: valid.pointerId,
        trust: 'app_verified',
        accountId: 'account-1',
        projectId: 'project-1',
      },
    });
    expect(items[0]!.source.uri).toBe(
      'vibespace:context/evidence/ptr%3Arlm%3Aabc123%3A0%3A512',
    );

    registerToolGatewayFallbackCitations(
      'session-unsafe',
      [
        valid,
        { ...valid, pointerId: 'ptr:bad\nvalue' },
      ],
      { accountId: 'account-1', projectId: 'project-1' },
    );
    expect(consumeToolGatewayContextCitationItems('session-unsafe')).toEqual([]);
  });

  it('bounds retained session citation records and evicts the oldest record', () => {
    const item = contextCitationItem({
      id: 'ptr:bounded',
      kind: 'evidence',
      label: 'Context evidence handle',
      accountId: 'account-1',
      projectId: 'project-1',
      observedAt: 789,
    });
    for (let index = 0; index < 129; index += 1) {
      replaceToolGatewayContextCitationItems(`session-${index}`, [item]);
    }
    expect(consumeToolGatewayContextCitationItems('session-0')).toEqual([]);
    expect(consumeToolGatewayContextCitationItems('session-128')).toHaveLength(1);
  });
});


describe('fallback Context citation retention', () => {
  beforeEach(() => clearToolGatewayContextCitationItems());
  const scope = { accountId: 'account-1', projectId: 'project-1' };
  const pointer = (id: string) => ({
    pointerId: `ptr:${id}`, recordId: `record:${id}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`, contentHash: 'a'.repeat(64),
  });

  it('applies the existing 128-session bound to fallback registrations', () => {
    for (let index = 0; index < 129; index += 1) {
      registerToolGatewayFallbackCitations(`fallback-${index}`, [pointer(String(index))], scope);
    }
    expect(consumeToolGatewayContextCitationItems('fallback-0')).toEqual([]);
    expect(consumeToolGatewayContextCitationItems('fallback-128')).toHaveLength(1);
  });

  it('refreshes fallback session recency without losing its previous evidence', () => {
    for (let index = 0; index < 128; index += 1) {
      registerToolGatewayFallbackCitations(`fallback-${index}`, [pointer(String(index))], scope);
    }
    registerToolGatewayFallbackCitations('fallback-0', [pointer('new-0')], scope);
    registerToolGatewayFallbackCitations('fallback-128', [pointer('128')], scope);
    expect(consumeToolGatewayContextCitationItems('fallback-1')).toEqual([]);
    expect(consumeToolGatewayContextCitationItems('fallback-0').map((item) => item.source.id))
      .toEqual(['ptr:0', 'ptr:new-0']);
    expect(consumeToolGatewayContextCitationItems('fallback-128')).toHaveLength(1);
  });

  it('does not trim or duplicate evidence inside a retained session', () => {
    const pointers = Array.from({ length: 180 }, (_, index) => pointer(`evidence-${index}`));
    registerToolGatewayFallbackCitations('active', [...pointers, ...pointers], scope);
    const items = consumeToolGatewayContextCitationItems('active');
    expect(items).toHaveLength(180);
    expect(items.at(-1)?.source.id).toBe('ptr:evidence-179');
  });

  it('shares the same retention boundary between receipts and fallback evidence', () => {
    const receipt = contextCitationItem({
      id: 'receipt-test', kind: 'receipt', label: 'Context receipt', ...scope, observedAt: 123,
    });
    replaceToolGatewayContextCitationItems('oldest', [receipt]);
    for (let index = 0; index < 127; index += 1) {
      registerToolGatewayFallbackCitations(`fallback-${index}`, [pointer(String(index))], scope);
    }
    registerToolGatewayFallbackCitations('latest', [pointer('latest')], scope);
    expect(consumeToolGatewayContextCitationItems('oldest')).toEqual([]);
    replaceToolGatewayContextCitationItems('receipt-new', [receipt]);
    expect(consumeToolGatewayContextCitationItems('receipt-new')).toHaveLength(1);
    expect(consumeToolGatewayContextCitationItems('latest')).toHaveLength(1);
  });
});

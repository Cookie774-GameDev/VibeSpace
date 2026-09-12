import { describe, expect, it } from 'vitest';
import { ContextPointerAuthority, PointerAuthorityError, type ContextScope } from './pointerAuthority';

const scope: ContextScope = { accountId: 'a', projectId: 'p' };
const row = {
  sourceId: 's',
  recordId: 'r',
  sourceVersion: 'v1',
  contentHash: 'h1',
  byteStart: '9007199254740993',
  byteEnd: '9007199254741093',
  sourceByteLength: '10000000000000000',
};

function context() {
  return {
    scope,
    leaseId: 'l1',
    repositoryGeneration: 'g1',
    currentSourceVersion: 'v1',
    currentContentHash: 'h1',
    currentSourceByteLength: row.sourceByteLength,
  };
}

describe('ContextPointerAuthority', () => {
  it('accepts the exact BigInt-safe tuple that was visibly issued', () => {
    const authority = new ContextPointerAuthority(scope, 'l1', 'g1');
    const pointer = authority.issueVisiblePointer({
      pointerId: 'p1', leaseId: 'l1', scope, repositoryGeneration: 'g1', row, issuedAt: 1,
    });
    expect(authority.validate(pointer, context())).toEqual(pointer);
  });

  it('rejects hybrid, forged, stale, out-of-range, cancelled and cross-scope pointers', () => {
    const authority = new ContextPointerAuthority(scope, 'l1', 'g1');
    const pointer = authority.issueVisiblePointer({
      pointerId: 'p1', leaseId: 'l1', scope, repositoryGeneration: 'g1', row, issuedAt: 1,
    });
    expect(() => authority.validate({ ...pointer, byteStart: '1', byteEnd: '2' }, context()))
      .toThrow(PointerAuthorityError);
    expect(() => authority.validate(pointer, { ...context(), currentSourceVersion: 'v2' }))
      .toThrow('pointer_stale');
    expect(() => authority.validate(pointer, { ...context(), currentSourceByteLength: '10' }))
      .toThrow('pointer_out_of_bounds');
    expect(() => authority.validate(pointer, { ...context(), cancelled: true }))
      .toThrow('pointer_cancelled');
    expect(() => authority.validate(pointer, { ...context(), scope: { accountId: 'other', projectId: 'p' } }))
      .toThrow('pointer_scope_mismatch');
  });

  it('never permits an opaque pointer ID to retarget another tuple', () => {
    const authority = new ContextPointerAuthority(scope, 'l1', 'g1');
    authority.issueVisiblePointer({
      pointerId: 'p1', leaseId: 'l1', scope, repositoryGeneration: 'g1', row, issuedAt: 1,
    });
    expect(() => authority.issueVisiblePointer({
      pointerId: 'p1',
      leaseId: 'l1',
      scope,
      repositoryGeneration: 'g1',
      row: { ...row, recordId: 'r2', byteStart: '5', byteEnd: '10' },
      issuedAt: 2,
    })).toThrow('pointer_invalid');
  });

  it('does not publish hidden or cancelled result rows', () => {
    const authority = new ContextPointerAuthority(scope, 'l1', 'g1');
    const pointer = {
      pointerId: 'p1', leaseId: 'l1', ...scope, sourceId: 's', recordId: 'r',
      sourceVersion: 'v1', contentHash: 'h1', byteStart: '0', byteEnd: '1',
      repositoryGeneration: 'g1', issuedAt: 1,
    };
    expect(() => authority.issueVisibleResults([{
      pointer, sourceLengthBytes: '2', visible: false, completed: true, cancelled: false,
    }])).toThrow('pointer_hidden');
    expect(authority.size).toBe(0);
  });
});

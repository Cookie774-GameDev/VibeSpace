export interface ContextScope {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}

export interface ContextPointer extends ContextScope {
  pointerId: string;
  leaseId: string;
  sourceId: string;
  recordId: string;
  sourceVersion: string;
  contentHash: string;
  byteStart: string;
  byteEnd: string;
  repositoryGeneration: string;
  issuedAt: number;
}

export interface VisibleSearchResult {
  pointer: ContextPointer;
  sourceLengthBytes: string;
  visible: boolean;
  completed: boolean;
  cancelled: boolean;
}

export interface VisibleSearchRow {
  sourceId: string;
  recordId: string;
  sourceVersion: string;
  contentHash: string;
  byteStart: string;
  byteEnd: string;
  sourceByteLength: string;
}

export type PointerFailureCode =
  | 'pointer_invalid'
  | 'pointer_never_issued'
  | 'pointer_hidden'
  | 'pointer_cancelled'
  | 'pointer_scope_mismatch'
  | 'pointer_lease_mismatch'
  | 'pointer_generation_mismatch'
  | 'pointer_stale'
  | 'pointer_out_of_bounds';

export class PointerAuthorityError extends Error {
  constructor(readonly code: PointerFailureCode, message = code) {
    super(message);
  }
}

function boundedIdentifier(value: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new PointerAuthorityError('pointer_invalid');
  }
  return clean;
}

function decimalBigInt(value: string): bigint {
  const clean = value.trim();
  if (!/^(0|[1-9]\d*)$/u.test(clean) || clean.length > 80) {
    throw new PointerAuthorityError('pointer_invalid');
  }
  return BigInt(clean);
}

function exactScopeMatch(expected: ContextScope, actual: ContextScope): boolean {
  return expected.accountId === actual.accountId
    && expected.workspaceId === actual.workspaceId
    && expected.projectId === actual.projectId
    && expected.worktreeId === actual.worktreeId;
}

function encodeTupleField(value: string | number | undefined): string {
  if (value === undefined) return 'n:';
  const text = typeof value === 'number' ? String(value) : value;
  return `s${text.length}:${text}`;
}

/** Collision-safe serialization: missing values cannot collide with literal sentinels. */
function pointerTuple(pointer: ContextPointer): string {
  return [
    pointer.pointerId,
    pointer.leaseId,
    pointer.accountId,
    pointer.workspaceId,
    pointer.projectId,
    pointer.worktreeId,
    pointer.sourceId,
    pointer.recordId,
    pointer.sourceVersion,
    pointer.contentHash,
    pointer.byteStart,
    pointer.byteEnd,
    pointer.repositoryGeneration,
    pointer.issuedAt,
  ].map(encodeTupleField).join('|');
}

interface IssuedPointerRecord {
  pointer: ContextPointer;
  sourceLengthBytes: string;
  tuple: string;
}

export interface PointerValidationContext {
  scope: ContextScope;
  leaseId: string;
  repositoryGeneration: string;
  currentSourceVersion: string;
  currentContentHash: string;
  currentSourceByteLength: string;
  cancelled?: boolean;
}

/**
 * Bounded issued-capability registry. Authority is published only after final
 * filtering, pagination, visibility and cancellation checks. The exact tuple is
 * required at open time, preventing hybrid/forged/never-returned pointers.
 */
export class ContextPointerAuthority {
  readonly #issuedByTuple = new Map<string, IssuedPointerRecord>();
  readonly #tupleByPointerId = new Map<string, string>();
  readonly #order: string[] = [];

  constructor(
    readonly scope?: ContextScope,
    readonly leaseId?: string,
    readonly repositoryGeneration?: string,
    readonly maxEntries = 2_000,
  ) {
    if (scope) boundedIdentifier(scope.accountId);
    if (leaseId) boundedIdentifier(leaseId);
    if (repositoryGeneration) boundedIdentifier(repositoryGeneration);
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
      throw new Error('invalid_pointer_registry_limit');
    }
  }

  issueVisibleResults(results: readonly VisibleSearchResult[]): void {
    for (const result of results) {
      if (!result.visible) throw new PointerAuthorityError('pointer_hidden');
      if (!result.completed) throw new PointerAuthorityError('pointer_invalid');
      if (result.cancelled) throw new PointerAuthorityError('pointer_cancelled');
      this.#validateStatic(result.pointer, result.sourceLengthBytes);
      this.#publish(result.pointer, result.sourceLengthBytes);
    }
  }

  /** Convenience adapter for a query service emitting one visible row. */
  issueVisiblePointer(input: {
    pointerId: string;
    leaseId: string;
    scope: ContextScope;
    repositoryGeneration: string;
    row: VisibleSearchRow;
    issuedAt?: number;
    cancelled?: boolean;
  }): ContextPointer {
    const pointer: ContextPointer = {
      pointerId: input.pointerId,
      leaseId: input.leaseId,
      ...input.scope,
      sourceId: input.row.sourceId,
      recordId: input.row.recordId,
      sourceVersion: input.row.sourceVersion,
      contentHash: input.row.contentHash,
      byteStart: input.row.byteStart,
      byteEnd: input.row.byteEnd,
      repositoryGeneration: input.repositoryGeneration,
      issuedAt: input.issuedAt ?? Date.now(),
    };
    this.issueVisibleResults([{
      pointer,
      sourceLengthBytes: input.row.sourceByteLength,
      visible: true,
      completed: true,
      cancelled: Boolean(input.cancelled),
    }]);
    return structuredClone(pointer);
  }

  assertOpenable(pointer: ContextPointer, current: {
    sourceVersion: string;
    contentHash: string;
    sourceLengthBytes: string;
    cancelled?: boolean;
  }): ContextPointer {
    if (current.cancelled) throw new PointerAuthorityError('pointer_cancelled');
    this.#validateStatic(pointer, current.sourceLengthBytes);
    const tuple = pointerTuple(pointer);
    const issued = this.#issuedByTuple.get(tuple);
    if (!issued) throw new PointerAuthorityError('pointer_never_issued');
    if (this.#tupleByPointerId.get(pointer.pointerId) !== tuple) {
      throw new PointerAuthorityError('pointer_never_issued');
    }
    if (pointer.sourceVersion !== current.sourceVersion || pointer.contentHash !== current.contentHash) {
      throw new PointerAuthorityError('pointer_stale');
    }
    if (issued.sourceLengthBytes !== current.sourceLengthBytes) {
      throw new PointerAuthorityError('pointer_stale');
    }
    return structuredClone(issued.pointer);
  }

  validate(pointer: ContextPointer, context: PointerValidationContext): ContextPointer {
    if (context.cancelled) throw new PointerAuthorityError('pointer_cancelled');
    if (!exactScopeMatch(context.scope, pointer)) {
      throw new PointerAuthorityError('pointer_scope_mismatch');
    }
    if (context.leaseId !== pointer.leaseId) {
      throw new PointerAuthorityError('pointer_lease_mismatch');
    }
    if (context.repositoryGeneration !== pointer.repositoryGeneration) {
      throw new PointerAuthorityError('pointer_generation_mismatch');
    }
    return this.assertOpenable(pointer, {
      sourceVersion: context.currentSourceVersion,
      contentHash: context.currentContentHash,
      sourceLengthBytes: context.currentSourceByteLength,
    });
  }

  revokeLease(leaseId: string): void {
    for (const [tuple, issued] of this.#issuedByTuple) {
      if (issued.pointer.leaseId !== leaseId) continue;
      this.#issuedByTuple.delete(tuple);
      this.#tupleByPointerId.delete(issued.pointer.pointerId);
      const index = this.#order.indexOf(tuple);
      if (index >= 0) this.#order.splice(index, 1);
    }
  }

  clear(): void {
    this.#issuedByTuple.clear();
    this.#tupleByPointerId.clear();
    this.#order.length = 0;
  }

  get size(): number {
    return this.#issuedByTuple.size;
  }

  #publish(pointer: ContextPointer, sourceLengthBytes: string): void {
    const tuple = pointerTuple(pointer);
    const existingForId = this.#tupleByPointerId.get(pointer.pointerId);
    if (existingForId && existingForId !== tuple) {
      // Never let one opaque pointer ID silently retarget another source/range.
      throw new PointerAuthorityError('pointer_invalid');
    }
    if (!this.#issuedByTuple.has(tuple)) this.#order.push(tuple);
    this.#issuedByTuple.set(tuple, {
      pointer: structuredClone(pointer),
      sourceLengthBytes,
      tuple,
    });
    this.#tupleByPointerId.set(pointer.pointerId, tuple);
    while (this.#order.length > this.maxEntries) {
      const oldest = this.#order.shift();
      if (!oldest) break;
      const issued = this.#issuedByTuple.get(oldest);
      this.#issuedByTuple.delete(oldest);
      if (issued && this.#tupleByPointerId.get(issued.pointer.pointerId) === oldest) {
        this.#tupleByPointerId.delete(issued.pointer.pointerId);
      }
    }
  }

  #validateStatic(pointer: ContextPointer, sourceLengthBytes: string): void {
    if (this.scope && !exactScopeMatch(this.scope, pointer)) {
      throw new PointerAuthorityError('pointer_scope_mismatch');
    }
    if (this.leaseId && pointer.leaseId !== this.leaseId) {
      throw new PointerAuthorityError('pointer_lease_mismatch');
    }
    if (this.repositoryGeneration && pointer.repositoryGeneration !== this.repositoryGeneration) {
      throw new PointerAuthorityError('pointer_generation_mismatch');
    }
    for (const value of [
      pointer.pointerId,
      pointer.leaseId,
      pointer.accountId,
      pointer.sourceId,
      pointer.recordId,
      pointer.sourceVersion,
      pointer.contentHash,
      pointer.repositoryGeneration,
    ]) boundedIdentifier(value);
    if (!Number.isFinite(pointer.issuedAt) || pointer.issuedAt < 0) {
      throw new PointerAuthorityError('pointer_invalid');
    }
    const start = decimalBigInt(pointer.byteStart);
    const end = decimalBigInt(pointer.byteEnd);
    const length = decimalBigInt(sourceLengthBytes);
    if (end <= start || end > length) {
      // Deliberately reject. Never clamp to EOF.
      throw new PointerAuthorityError('pointer_out_of_bounds');
    }
  }
}

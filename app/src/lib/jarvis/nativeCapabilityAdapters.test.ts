import { describe, expect, it } from 'vitest';
import { createNativeCapabilityAdapterDescriptor } from './nativeCapabilityAdapters';

describe('native capability adapter descriptors', () => {
  it.each([
    ['file', 'file.read', 'file_action'],
    ['terminal', 'terminal.spawn', 'terminal'],
    ['git', 'git.status', 'terminal'],
    ['browser', 'browser.snapshot', 'action'],
    ['mcp', 'mcp.invoke', 'mcp'],
  ] as const)('creates a deep-frozen closed %s descriptor', (kind, operation, producerKind) => {
    const descriptor = createNativeCapabilityAdapterDescriptor({
      schemaVersion: 1,
      id: `${kind}.primary`,
      version: 1,
      kind,
      operations: [
        {
          name: operation,
          risk: 'read-only',
          approval: 'never',
          producerKind,
          evidence: 'canonical_result',
          cancellation: 'required',
        },
      ],
    });

    expect(descriptor).toMatchObject({ schemaVersion: 1, kind });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.operations)).toBe(true);
    expect(Object.isFrozen(descriptor.operations[0])).toBe(true);
  });

  it('fails closed on unknown, duplicate, mismatched-producer, or cancellation-free operations', () => {
    const base = {
      schemaVersion: 1 as const,
      id: 'file.primary',
      version: 1,
      kind: 'file' as const,
    };
    expect(() =>
      createNativeCapabilityAdapterDescriptor({
        ...base,
        operations: [
          {
            name: 'file.unknown',
            risk: 'read-only',
            approval: 'never',
            producerKind: 'file_action',
            evidence: 'canonical_result',
            cancellation: 'required',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createNativeCapabilityAdapterDescriptor({
        ...base,
        operations: [
          {
            name: 'file.read',
            risk: 'read-only',
            approval: 'never',
            producerKind: 'file_action',
            evidence: 'canonical_result',
            cancellation: 'required',
          },
          {
            name: 'file.read',
            risk: 'read-only',
            approval: 'never',
            producerKind: 'file_action',
            evidence: 'canonical_result',
            cancellation: 'required',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createNativeCapabilityAdapterDescriptor({
        ...base,
        operations: [
          {
            name: 'file.read',
            risk: 'read-only',
            approval: 'never',
            producerKind: 'mcp',
            evidence: 'canonical_result',
            cancellation: 'required',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createNativeCapabilityAdapterDescriptor({
        ...base,
        operations: [
          {
            name: 'file.read',
            risk: 'read-only',
            approval: 'never',
            producerKind: 'file_action',
            evidence: 'canonical_result',
            cancellation: 'not_applicable',
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps Git authority classes separate and excludes pull as an implicit compound mutation', () => {
    const operations = [
      'git.status',
      'git.diff',
      'git.worktree',
      'git.index',
      'git.commit',
      'git.fetch',
      'git.push',
      'git.ref',
    ] as const;
    const descriptor = createNativeCapabilityAdapterDescriptor({
      schemaVersion: 1,
      id: 'git.primary',
      version: 1,
      kind: 'git',
      operations: operations.map((name) => ({
        name,
        risk: name === 'git.status' || name === 'git.diff' ? 'read-only' : 'safe-write',
        approval: name === 'git.status' || name === 'git.diff' ? 'never' : 'always',
        producerKind: 'terminal',
        evidence: 'canonical_result',
        cancellation: 'required',
      })),
    });
    expect(descriptor.operations.map(({ name }) => name)).toEqual(operations);
    expect(() =>
      createNativeCapabilityAdapterDescriptor({
        schemaVersion: 1,
        id: 'git.primary',
        version: 1,
        kind: 'git',
        operations: [
          {
            name: 'git.pull',
            risk: 'safe-write',
            approval: 'always',
            producerKind: 'terminal',
            evidence: 'canonical_result',
            cancellation: 'required',
          },
        ],
      }),
    ).toThrow(/operation/i);
  });
});

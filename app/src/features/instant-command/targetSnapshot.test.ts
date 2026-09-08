import { describe, expect, it } from 'vitest';
import { fromLeaves, newLeaf } from '@/features/terminals/paneTree';
import type { SessionTranscript } from '@/features/terminals/transcriptStore';
import { buildLiveTargetSnapshot } from './targetSnapshot';

function native(sessionId: string, projectId: string | null = 'project-a') {
  return {
    sessionId,
    command: 'powershell',
    cwd: 'C:\\workspace',
    rows: 30,
    cols: 100,
    startedAt: 1,
    projectId,
    processInstanceId: `process-${sessionId}`,
    pid: 4242,
    processStartedAt: 1_723_456_789_000,
    runtimeGeneration: 'runtime-a',
  };
}

function transcript(sessionId: string, paneId: string, command: string): SessionTranscript {
  return {
    sessionId,
    paneId,
    projectId: 'project-a',
    agentSlug: null,
    command,
    text: '',
    lastWriteAt: 1,
    bytesSeen: 0,
  };
}

describe('buildLiveTargetSnapshot', () => {
  it.each([307, 327])(
    'does not lose live targets because a saved launch command has %i characters',
    (length) => {
      const tree = fromLeaves([
        { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'powershell.exe' },
      ]);
      const command = `powershell.exe\n${'x'.repeat(length - 15)}`;
      const snapshot = buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: {
          'tty-a': transcript('tty-a', 'pane-a', 'powershell.exe'),
          other: { ...transcript('other', 'other-pane', command), projectId: 'project-b' },
        },
        nativeSessions: [native('tty-a')],
      });
      expect(snapshot.map((target) => target.sessionId)).toEqual(['tty-a']);
    },
  );
  it.each(['x'.repeat(32_769), 'cmd\u0000.exe'])(
    'rejects unbounded or unsafe command metadata',
    (command) => {
      const tree = fromLeaves([{ ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a' }]);
      expect(
        buildLiveTargetSnapshot({
          projectId: 'project-a',
          tree,
          transcripts: { 'tty-a': transcript('tty-a', 'pane-a', command) },
          nativeSessions: [native('tty-a')],
        }),
      ).toEqual([]);
    },
  );
  it('uses visual tree order and only uses native sessions to reject stale targets', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-b', sessionId: 'tty-b', command: 'claude' },
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);
    const snapshot = buildLiveTargetSnapshot({
      projectId: 'project-a',
      tree,
      transcripts: {
        'tty-a': transcript('tty-a', 'pane-a', 'codex'),
        'tty-b': transcript('tty-b', 'pane-b', 'claude'),
      },
      nativeSessions: [native('tty-a'), native('tty-b')],
    });

    expect(snapshot.map(({ paneId, ordinal }) => ({ paneId, ordinal }))).toEqual([
      { paneId: 'pane-b', ordinal: 1 },
      { paneId: 'pane-a', ordinal: 2 },
    ]);
    expect(snapshot[0]?.processIdentity).toEqual({
      projectId: 'project-a',
      processInstanceId: 'process-tty-b',
      pid: 4242,
      processStartedAt: 1_723_456_789_000,
      runtimeGeneration: 'runtime-a',
    });
  });

  it('drops stale, missing, and multiply-mapped session identities', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'stale', sessionId: 'tty-stale', command: 'codex' },
      { ...newLeaf(), kind: 'leaf', id: 'ambiguous', sessionId: null, command: 'codex' },
    ]);
    const first = transcript('tty-1', 'ambiguous', 'codex');
    const second = transcript('tty-2', 'ambiguous', 'codex');

    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { first, second },
        nativeSessions: [native('tty-1'), native('tty-2')],
      }),
    ).toEqual([]);
  });

  it('drops one native session mapped onto more than one visual pane', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-shared', command: 'codex' },
      { ...newLeaf(), kind: 'leaf', id: 'pane-b', sessionId: 'tty-shared', command: 'codex' },
    ]);

    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: {},
        nativeSessions: [native('tty-shared')],
      }),
    ).toEqual([]);
  });

  it('rejects a live native session owned by another project', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);

    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { 'tty-a': transcript('tty-a', 'pane-a', 'codex') },
        nativeSessions: [native('tty-a', 'project-b')],
      }),
    ).toEqual([]);
  });

  it('rejects duplicate native session ids with replaced process bindings', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);

    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { 'tty-a': transcript('tty-a', 'pane-a', 'codex') },
        nativeSessions: [
          native('tty-a'),
          { ...native('tty-a'), processInstanceId: 'replacement-process' },
        ],
      }),
    ).toEqual([]);
  });

  it.each([
    null,
    {},
    [null],
    [native('tty-a'), ...Array.from({ length: 1_024 }, (_, index) => native(`tty-${index}`))],
  ])('fails closed on malformed or unbounded native session registries', (nativeSessions) => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);
    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { 'tty-a': transcript('tty-a', 'pane-a', 'codex') },
        nativeSessions: nativeSessions as never,
      }),
    ).toEqual([]);
  });

  it('contains corrupt transcript rows and bounded stable identifiers', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);
    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { corrupt: null } as never,
        nativeSessions: [native('tty-a')],
      }),
    ).toEqual([]);
    expect(
      buildLiveTargetSnapshot({
        projectId: 'project-a',
        tree,
        transcripts: { 'tty-a': transcript('tty-a', 'pane-a', 'codex') },
        nativeSessions: [{ ...native('tty-a'), processInstanceId: `process-${'x'.repeat(256)}` }],
      }),
    ).toEqual([]);
  });

  it('returns frozen target snapshots detached from mutable native input', () => {
    const tree = fromLeaves([
      { ...newLeaf(), kind: 'leaf', id: 'pane-a', sessionId: 'tty-a', command: 'codex' },
    ]);
    const nativeSession = native('tty-a');
    const snapshot = buildLiveTargetSnapshot({
      projectId: 'project-a',
      tree,
      transcripts: { 'tty-a': transcript('tty-a', 'pane-a', 'codex') },
      nativeSessions: [nativeSession],
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.processIdentity)).toBe(true);
    nativeSession.processInstanceId = 'changed-later';
    expect(snapshot[0]?.processIdentity.processInstanceId).toBe('process-tty-a');
  });
});

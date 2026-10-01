import { describe, expect, it } from 'vitest';
import {
  applySecondBrainChangesWithRollback,
  canonicalSecondBrainRun,
  parseSecondBrainProposal,
  scopedSecondBrainMessages,
  scopedSecondBrainTerminalSessions,
  resolveContextMapChangeTarget,
  assertRelatedMarkdownChangePath,
  selectedContextMapForCapturedScope,
  secondBrainMarkdownUpdate,
} from './nightlySecondBrainRuntime';
import type { ContextMapRecord } from './tree';
import type { SecondBrainChange } from './nightlySecondBrain';

describe('nightly second-brain production runtime helpers', () => {
  it('accepts only bounded proposals with real source provenance', () => {
    expect(
      parseSecondBrainProposal(
        'prefix {"updates":[{"target":"related_markdown","content":"Remember the launch checklist.","provenance":["chat:1"],"confidence":0.9}]} suffix',
        new Set(['chat:1']),
      ),
    ).toEqual([
      {
        target: 'related_markdown',
        content: 'Remember the launch checklist.',
        provenance: ['chat:1'],
        confidence: 0.9,
      },
    ]);
  });

  it('deduplicates markdown facts instead of rewriting the document', () => {
    const before = '# Second Brain\n\n- Keep builds green.\n';
    expect(secondBrainMarkdownUpdate(before, 'Keep builds green.')).toBe(before);
    expect(secondBrainMarkdownUpdate(before, 'Ship the accessibility pass.')).toContain(
      '- Ship the accessibility pass.',
    );
  });

  it('admits chat and terminal evidence only from the captured workspace/project scope', () => {
    const messages = [
      { id: 'message-a', chat_id: 'chat-a', updated_at: 200 },
      { id: 'message-b', chat_id: 'chat-b', updated_at: 210 },
      { id: 'message-old', chat_id: 'chat-a', updated_at: 99 },
    ];
    expect(scopedSecondBrainMessages(messages, new Set(['chat-a']), 100)).toEqual([messages[0]]);

    const sessions = [
      {
        id: 'terminal-a',
        workspace_id: 'workspace-a',
        project_id: 'project-a',
        last_active_at: 200,
      },
      {
        id: 'terminal-other-account',
        workspace_id: 'workspace-b',
        project_id: 'project-a',
        last_active_at: 210,
      },
      {
        id: 'terminal-other-project',
        workspace_id: 'workspace-a',
        project_id: 'project-b',
        last_active_at: 220,
      },
    ];
    expect(
      scopedSecondBrainTerminalSessions(
        sessions,
        { workspaceId: 'workspace-a', projectId: 'project-a' },
        100,
      ),
    ).toEqual([sessions[0]]);
  });

  it('reuses the canonical run for a schedule while allowing an explicit retry', () => {
    const original = {
      id: 'run-original',
      scheduledFor: 100,
      retryOf: undefined,
    };
    const retry = {
      id: 'run-retry',
      scheduledFor: 100,
      retryOf: 'run-original',
    };

    expect(canonicalSecondBrainRun([retry, original], 100)).toBe(original);
    expect(canonicalSecondBrainRun([retry], 100)).toBeUndefined();
  });

  it('uses only the exact account/project selected persisted map without a fallback', () => {
    const map = {
      id: 'map-a',
      status: 'active',
      projectId: 'project-a',
    } as ContextMapRecord;
    const state = {
      accountId: 'account-a',
      projectId: 'project-a',
      selectedMapId: 'map-a',
      maps: [map],
    };

    expect(
      selectedContextMapForCapturedScope(state, {
        accountId: 'account-a',
        projectId: 'project-a',
      }),
    ).toBe(map);
    expect(() =>
      selectedContextMapForCapturedScope(state, {
        accountId: 'account-b',
        projectId: 'project-a',
      }),
    ).toThrow(/scope changed/i);
    expect(
      selectedContextMapForCapturedScope(
        { ...state, selectedMapId: null },
        { accountId: 'account-a', projectId: 'project-a' },
      ),
    ).toBeNull();
  });

  it('checks scope before every change and compensates earlier writes after a switch', async () => {
    const changes = [
      { id: 'change-a', target: 'related_markdown' },
      { id: 'change-b', target: 'related_markdown' },
    ] as SecondBrainChange[];
    const capturedScope = { accountId: 'account-a', projectId: 'project-a' };
    let activeScope = capturedScope;
    const writes: string[] = [];

    await expect(
      applySecondBrainChangesWithRollback(changes, {
        assertActive: () => {
          if (
            activeScope.accountId !== capturedScope.accountId ||
            activeScope.projectId !== capturedScope.projectId
          ) {
            throw new Error('scope changed');
          }
        },
        write: async (change, direction) => {
          writes.push(`${change.id}:${direction}`);
          if (change.id === 'change-a' && direction === 'apply') {
            activeScope = { accountId: 'account-b', projectId: 'project-b' };
          }
        },
      }),
    ).rejects.toThrow(/scope changed/i);

    expect(writes).toEqual(['change-a:apply', 'change-a:rollback']);
  });

  it('binds a reviewed Context change to its exact map and rejects selection or path drift', () => {
    const mapA = {
      id: 'map-a',
      status: 'active',
      projectId: 'project-a',
      rootDir: 'C:\\project-a',
      filePath: 'C:\\project-a\\context_map.json',
    } as ContextMapRecord;
    const mapB = {
      ...mapA,
      id: 'map-b',
      rootDir: 'C:\\project-b',
      filePath: 'C:\\project-b\\context_map.json',
    };
    const change = {
      id: 'change-a',
      target: 'context_map',
      targetMapId: 'map-a',
      path: mapA.filePath,
    } as SecondBrainChange;

    expect(
      resolveContextMapChangeTarget({ selectedMapId: 'map-a', maps: [mapA, mapB] }, change),
    ).toBe(mapA);
    expect(() =>
      resolveContextMapChangeTarget({ selectedMapId: 'map-b', maps: [mapA, mapB] }, change),
    ).toThrow(/selection changed/i);
    expect(() =>
      resolveContextMapChangeTarget(
        {
          selectedMapId: 'map-a',
          maps: [{ ...mapA, filePath: 'C:\\elsewhere\\context_map.json' }],
        },
        change,
      ),
    ).toThrow(/path/i);
  });

  it('fails closed when a legacy Context change path has no unique selected target', () => {
    const map = {
      id: 'map-a',
      status: 'active',
      projectId: 'project-a',
      rootDir: '/project',
      filePath: '/project/context_map.json',
    } as ContextMapRecord;
    const legacy = {
      id: 'legacy-change',
      target: 'context_map',
      path: '/project/context_map.json',
    } as SecondBrainChange;

    expect(resolveContextMapChangeTarget({ selectedMapId: 'map-a', maps: [map] }, legacy)).toBe(
      map,
    );
    expect(() =>
      resolveContextMapChangeTarget(
        { selectedMapId: 'map-a', maps: [map, { ...map, id: 'map-b' }] },
        legacy,
      ),
    ).toThrow(/ambiguous/i);
    expect(() =>
      resolveContextMapChangeTarget({ selectedMapId: null, maps: [map] }, legacy),
    ).toThrow(/selection changed/i);
  });

  it('recomputes and validates the exact related markdown target', () => {
    expect(assertRelatedMarkdownChangePath('/project', '/project/.vibespace/second-brain.md')).toBe(
      '/project/.vibespace/second-brain.md',
    );
    expect(() => assertRelatedMarkdownChangePath('/project', '/project/../private.md')).toThrow(
      /path/i,
    );
    expect(() =>
      assertRelatedMarkdownChangePath('/different-project', '/project/.vibespace/second-brain.md'),
    ).toThrow(/path/i);
  });
});

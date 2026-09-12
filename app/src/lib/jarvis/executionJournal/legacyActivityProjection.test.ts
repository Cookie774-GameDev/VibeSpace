import { describe, expect, it } from 'vitest';

import type { JarvisEvent, JarvisRun } from '@/lib/jarvis/contracts/execution';

import { projectJarvisEventsForLegacyActivity } from './legacyActivityProjection';

const NOW = 1_784_435_200_000;

function run(overrides: Partial<JarvisRun> = {}): JarvisRun {
  return {
    id: 'jrun_alpha',
    accountId: 'account-alpha',
    chatId: 'chat-alpha',
    source: 'typed_chat',
    status: 'running',
    agentId: 'jarvis-protected',
    identityVersion: 3,
    profileRevisionId: 'profile-revision',
    model: {
      providerId: 'openai',
      modelId: 'gpt-test',
      connectionMode: 'native-api',
      capabilities: {},
      capturedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function event(seq: number, overrides: Partial<JarvisEvent> = {}): JarvisEvent {
  return {
    runId: 'jrun_alpha',
    seq,
    idempotencyKey: `event-${seq}`,
    type: 'tool',
    status: 'running',
    title: `PRIVATE ROW TITLE ${seq}`,
    safeSummary: `Safe activity ${seq}`,
    sourceRefs: [],
    artifactIds: [],
    createdAt: NOW + seq,
    ...overrides,
  };
}

describe('projectJarvisEventsForLegacyActivity', () => {
  it('orders exact-run events and preserves source/artifact identity only in internal keys', () => {
    const projected = projectJarvisEventsForLegacyActivity({
      run: run(),
      events: [
        event(3, { runId: 'jrun_foreign', safeSummary: 'Foreign summary.' }),
        event(2, {
          type: 'artifact',
          sourceRefs: [
            {
              id: 'source-alpha',
              kind: 'project_file',
              label: 'PRIVATE SOURCE LABEL',
              uri: 'file:///private/path',
              accountId: 'account-alpha',
              trust: 'app_verified',
              sensitivity: 'private',
            },
            {
              id: 'source-foreign',
              kind: 'project_file',
              label: 'FOREIGN LABEL',
              accountId: 'account-foreign',
              trust: 'app_verified',
              sensitivity: 'private',
            },
          ],
          artifactIds: ['artifact-alpha'],
        }),
        event(1, { type: 'run_state', status: 'queued' }),
      ],
    });

    expect(projected.map((item) => item.ts)).toEqual([NOW + 1, NOW + 2]);
    expect(projected[1]?.id).toContain('run:jrun_alpha');
    expect(projected[1]?.id).toContain('source:source-alpha');
    expect(projected[1]?.id).toContain('artifact:artifact-alpha');
    expect(projected[1]?.id).not.toContain('source-foreign');
    expect(projected[1]).toMatchObject({
      chatId: 'chat-alpha',
      kind: 'file',
      detail: 'Safe activity 2',
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /PRIVATE ROW TITLE|PRIVATE SOURCE LABEL|FOREIGN LABEL|file:\/\/\/private\/path|Foreign summary/,
    );
  });

  it('clamps explicit and default limits to 1 through 500', () => {
    const events = Array.from({ length: 510 }, (_, index) => event(index + 1));

    expect(projectJarvisEventsForLegacyActivity({ run: run(), events })).toHaveLength(500);
    expect(projectJarvisEventsForLegacyActivity({ run: run(), events, limit: 0 })).toHaveLength(1);
    expect(projectJarvisEventsForLegacyActivity({ run: run(), events, limit: 900 })).toHaveLength(
      500,
    );
    expect(
      projectJarvisEventsForLegacyActivity({ run: run(), events, limit: Number.NaN }),
    ).toHaveLength(500);
  });

  it('uses canonical status truth and never creates activity without canonical events', () => {
    const projected = projectJarvisEventsForLegacyActivity({
      run: run({ status: 'cancelled' }),
      events: [
        event(1, { type: 'run_state', status: 'queued' }),
        event(2, { type: 'run_state', status: 'cancelled' }),
        event(3, { type: 'error', status: 'failed' }),
      ],
    });

    expect(projected.map((item) => item.status)).toEqual(['pending', 'cancelled', 'error']);
    expect(projectJarvisEventsForLegacyActivity({ run: run(), events: [] })).toEqual([]);
  });

  it('projects canonical event types into structured activity categories', () => {
    const projected = projectJarvisEventsForLegacyActivity({
      run: run(),
      events: [
        event(1, { type: 'run_state' }),
        event(2, { type: 'context' }),
        event(3, { type: 'retrieval' }),
        event(4, { type: 'tool' }),
        event(5, { type: 'terminal' }),
        event(6, { type: 'artifact' }),
        event(7, { type: 'message' }),
      ],
    });

    expect(projected.map(({ category }) => category)).toEqual([
      'thinking',
      'context',
      'file',
      'thinking',
      'thinking',
      'file',
      'response',
    ]);
  });
});

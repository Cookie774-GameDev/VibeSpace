import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    appDataDir: vi.fn(async () => 'C:/VibeSpaceData/'),
    createDirectory: vi.fn(async (path: string) => ({ ok: true as const, path, created: true })),
    readTextFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      return content === undefined
        ? { ok: false as const, error: { code: 'not_found' as const }, path }
        : { ok: true as const, content, path };
    }),
    writeTextFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return { ok: true as const, path };
    }),
    files,
    isTauri: true,
  };
});

vi.mock('@tauri-apps/api/path', () => ({ appDataDir: mocks.appDataDir }));
vi.mock('@/lib/fs', () => ({
  createDirectory: mocks.createDirectory,
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
}));
vi.mock('@/lib/utils', () => ({
  get isTauri() {
    return mocks.isTauri;
  },
}));

import {
  createVoiceNativeTaskRequestId,
  formatVoiceNativeTaskContext,
  getLastVoiceWorkerParentSession,
  listVoiceNativeTasks,
  upsertVoiceNativeTask,
  VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_CHARS,
  VOICE_NATIVE_TASK_INDEX_MAX_RECORDS,
  type VoiceNativeTaskScope,
} from './voiceNativeTaskIndex';

const scope: VoiceNativeTaskScope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
};

function taskUpdate(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'voice-request-1',
    parentChatId: 'voice-chat-1',
    requestedMainProvider: 'codex' as const,
    requestedWorkerProvider: 'opencode' as const,
    status: 'submitted' as const,
    summary: 'Review the selected files',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.isTauri = true;
});

describe('voice native task index', () => {
  it('creates stable request IDs suitable for a single task identity', () => {
    const requestId = createVoiceNativeTaskRequestId();

    expect(requestId).toMatch(/^voice-[a-zA-Z0-9-]{16,80}$/u);
    expect(createVoiceNativeTaskRequestId()).not.toBe(requestId);
  });

  it('isolates the persisted records by account, workspace, and project', async () => {
    await upsertVoiceNativeTask(scope, taskUpdate());
    await upsertVoiceNativeTask(
      { ...scope, projectId: 'project-b' },
      taskUpdate({ summary: 'Different project request' }),
    );

    const result = await listVoiceNativeTasks(scope);
    expect(result).toMatchObject({ ok: true, records: [{ summary: 'Review the selected files' }] });
    if (result.ok) expect(result.records).toHaveLength(1);
  });

  it('upserts by request ID, preserving creation and proven native identity', async () => {
    await upsertVoiceNativeTask(scope, taskUpdate({ createdAt: '2026-09-28T05:00:00.000Z' }));
    const launched = await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        status: 'launched',
        updatedAt: '2026-09-28T05:00:01.000Z',
        statusEvidence: {
          source: 'provider_native_task_tool',
          observedAt: '2026-09-28T05:00:01.000Z',
        },
        actualWorker: {
          provider: 'opencode',
          modelId: 'opencode/model-x',
          nativeTaskId: 'task-native-9',
          evidence: 'provider_native_task_tool',
        },
      }),
    );
    const running = await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        status: 'running',
        updatedAt: '2026-09-28T05:00:02.000Z',
        statusEvidence: {
          source: 'provider_native_activity',
          observedAt: '2026-09-28T05:00:02.000Z',
        },
      }),
    );

    expect(launched.ok).toBe(true);
    expect(running).toMatchObject({
      ok: true,
      record: {
        createdAt: '2026-09-28T05:00:00.000Z',
        status: 'running',
        actualWorker: { provider: 'opencode', nativeTaskId: 'task-native-9' },
      },
    });
    expect(mocks.files.size).toBe(1);
  });

  it('rejects launch and native terminal claims without correlated native evidence', async () => {
    const launch = await upsertVoiceNativeTask(scope, taskUpdate({ status: 'launched' }));
    const done = await upsertVoiceNativeTask(
      scope,
      taskUpdate({ status: 'done', statusEvidence: { source: 'voice_route_result' } }),
    );

    expect(launch).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
    expect(done).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
    expect(mocks.files.size).toBe(0);
  });

  it('keeps preflight failures truthful without native task identities', async () => {
    const blocked = await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        status: 'blocked',
        statusEvidence: {
          source: 'voice_route_result',
          code: 'cross_provider_native_session_unavailable',
        },
      }),
    );

    expect(blocked).toMatchObject({ ok: true, record: { status: 'blocked' } });
    if (blocked.ok) expect(blocked.record).not.toHaveProperty('actualWorker');
  });

  it('redacts common credentials from the bounded summary before persistence', async () => {
    const result = await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        summary: 'Update this API key=sk-proj-123456789012345678901234 after review',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      record: { summary: 'Update this API key=[redacted] after review' },
    });
    const persisted = [...mocks.files.values()][0] ?? '';
    expect(persisted).not.toContain('sk-proj-123456789012345678901234');
  });

  it('looks up only a separately verified parent session for the selected worker provider', async () => {
    await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        status: 'launched',
        statusEvidence: { source: 'provider_native_task_tool' },
        actualWorker: {
          provider: 'opencode',
          nativeTaskId: 'child-session-1',
          evidence: 'provider_native_task_tool',
        },
      }),
    );

    await expect(getLastVoiceWorkerParentSession(scope, 'opencode')).resolves.toMatchObject({
      ok: true,
      session: null,
    });
    await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        status: 'running',
        statusEvidence: { source: 'provider_native_activity' },
        workerParentSession: {
          provider: 'opencode',
          sessionId: 'verified-parent-1',
          evidence: 'verified_runtime_affinity',
        },
      }),
    );

    await expect(getLastVoiceWorkerParentSession(scope, 'opencode')).resolves.toMatchObject({
      ok: true,
      session: { provider: 'opencode', sessionId: 'verified-parent-1' },
    });
    await expect(getLastVoiceWorkerParentSession(scope, 'codex')).resolves.toMatchObject({
      ok: true,
      session: null,
    });
  });

  it('bounds summaries, record count, and formatted context without copying prompts', async () => {
    const summary = 'x'.repeat(2000);
    for (let index = 0; index < VOICE_NATIVE_TASK_INDEX_MAX_RECORDS; index += 1) {
      const record = await upsertVoiceNativeTask(
        scope,
        taskUpdate({ requestId: `voice-request-${index}`, summary }),
      );
      expect(record.ok).toBe(true);
    }
    const overflow = await upsertVoiceNativeTask(
      scope,
      taskUpdate({ requestId: 'voice-request-overflow' }),
    );
    const listed = await listVoiceNativeTasks(scope);
    expect(overflow).toMatchObject({ ok: false, error: { code: 'capacity_reached' } });
    expect(listed).toMatchObject({ ok: true, records: expect.any(Array) });
    if (!listed.ok) return;
    expect(listed.records).toHaveLength(VOICE_NATIVE_TASK_INDEX_MAX_RECORDS);
    expect(listed.records[0]?.summary.length).toBeLessThanOrEqual(240);
    const context = formatVoiceNativeTaskContext(listed.records);
    expect(context.length).toBeLessThanOrEqual(VOICE_NATIVE_TASK_INDEX_MAX_CONTEXT_CHARS);
    expect(context).not.toContain('task:');
  });

  it('prunes old terminal references before active tasks when the index reaches its cap', async () => {
    await upsertVoiceNativeTask(
      scope,
      taskUpdate({
        requestId: 'voice-request-active',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    for (let index = 0; index < VOICE_NATIVE_TASK_INDEX_MAX_RECORDS - 1; index += 1) {
      await upsertVoiceNativeTask(
        scope,
        taskUpdate({
          requestId: `voice-request-terminal-${index}`,
          status: 'blocked',
          updatedAt: new Date(Date.UTC(2026, 0, index + 2)).toISOString(),
          statusEvidence: { source: 'voice_route_result', code: 'route_blocked' },
        }),
      );
    }

    const next = await upsertVoiceNativeTask(
      scope,
      taskUpdate({ requestId: 'voice-request-new-active', updatedAt: '2026-12-01T00:00:00.000Z' }),
    );
    const listed = await listVoiceNativeTasks(scope);

    expect(next.ok).toBe(true);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.records).toHaveLength(VOICE_NATIVE_TASK_INDEX_MAX_RECORDS);
    expect(listed.records.map((record) => record.requestId)).toContain('voice-request-active');
    expect(listed.records.map((record) => record.requestId)).toContain('voice-request-new-active');
    expect(listed.records.map((record) => record.requestId)).not.toContain(
      'voice-request-terminal-0',
    );
  });

  it('does not pretend persistence is available outside the desktop runtime', async () => {
    mocks.isTauri = false;

    await expect(upsertVoiceNativeTask(scope, taskUpdate())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});

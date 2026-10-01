import { afterEach, describe, expect, it } from 'vitest';

import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';

import { listBrowserChatOutputFeed } from './browserChatOutputFeed';

const ACCOUNT = 'account-a';
const WORKSPACE = 'workspace-a';
const PROJECT = 'project-a';
const databases: JarvisDexie[] = [];

function run(id: string) {
  return {
    id,
    account_id: ACCOUNT,
    workspace_id: WORKSPACE,
    project_id: PROJECT,
    source: 'browser_chat' as const,
    status: 'completed' as const,
    agent_id: 'jarvis',
    identity_version: 1,
    profile_revision_id: `revision-${id}`,
    model: {
      provider_id: 'local',
      model_id: 'fixture',
      connection_mode: 'local' as const,
      capabilities: {},
      captured_at: 1,
    },
    created_at: 1,
    updated_at: 30,
    completed_at: 30,
  };
}

async function fixture(): Promise<JarvisDexie> {
  const database = createJarvisDb(uniqueTestDbName('browser-chat-output-feed'), TEST_INDEXED_DB);
  databases.push(database);
  await database.open();
  await database.jarvis_runs.bulkAdd([
    { ...run('run-current'), status: 'running', updated_at: 50, completed_at: undefined },
    run('run-complete'),
    { ...run('run-foreign-account'), account_id: 'account-b', updated_at: 60 },
    { ...run('run-foreign-workspace'), workspace_id: 'workspace-b', updated_at: 70 },
    { ...run('run-foreign-project'), project_id: 'project-b', updated_at: 80 },
  ]);
  await database.jarvis_artifacts.bulkAdd([
    {
      schema_version: 1,
      id: 'artifact-terminal',
      run_id: 'run-current',
      request_id: 'request-terminal',
      attempt_number: 1,
      state: 'partial',
      kind: 'terminal_output',
      title: 'Build output',
      safe_summary: 'Build is still running.',
      content_hash: `sha256:${'a'.repeat(64)}`,
      size_bytes: 42,
      uri: 'file:///C:/secret/build.log',
      local_reference: { kind: 'path', value: 'C:\\secret\\build.log' },
      source_refs: [],
      created_at: 49,
    },
    {
      schema_version: 1,
      id: 'artifact-code',
      run_id: 'run-complete',
      request_id: 'request-code',
      attempt_number: 1,
      state: 'ready',
      kind: 'code',
      title: 'Generated adapter',
      safe_summary: 'Verified source output.',
      content_hash: `sha256:${'b'.repeat(64)}`,
      size_bytes: 120,
      source_refs: [],
      created_at: 30,
    },
    {
      schema_version: 1,
      id: 'artifact-quarantined',
      run_id: 'run-complete',
      request_id: 'request-quarantined',
      attempt_number: 1,
      state: 'quarantined',
      kind: 'file',
      title: 'Do not expose',
      source_refs: [],
      created_at: 31,
    },
    {
      schema_version: 1,
      id: 'artifact-foreign',
      run_id: 'run-foreign-account',
      request_id: 'request-foreign',
      attempt_number: 1,
      state: 'ready',
      kind: 'text',
      title: 'Foreign output',
      source_refs: [],
      created_at: 60,
    },
  ]);
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe('Browser Chat output feed', () => {
  it('returns bounded live run and safe artifact metadata for the exact account project', async () => {
    const database = await fixture();

    const feed = await listBrowserChatOutputFeed({
      database,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      limit: 10,
    });

    expect(feed).toMatchObject({
      runningCount: 1,
      failedCount: 0,
      truncated: false,
      runs: [
        {
          id: 'run-current',
          status: 'running',
          outputs: [
            {
              id: 'artifact-terminal',
              state: 'partial',
              kind: 'terminal_output',
              title: 'Build output',
              summary: 'Build is still running.',
              trust: 'app_verified',
            },
          ],
        },
        {
          id: 'run-complete',
          status: 'completed',
          outputs: [{ id: 'artifact-code', title: 'Generated adapter' }],
        },
      ],
    });
    expect(JSON.stringify(feed)).not.toContain('Do not expose');
    expect(JSON.stringify(feed)).not.toContain('Foreign output');
    expect(JSON.stringify(feed)).not.toContain('C:\\\\secret');
    expect(JSON.stringify(feed)).not.toContain('file:///');
    expect(JSON.stringify(feed)).not.toContain('local_reference');
  });

  it('reports truncation without allowing caller-controlled unbounded reads', async () => {
    const database = await fixture();

    const feed = await listBrowserChatOutputFeed({
      database,
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      limit: 1,
    });

    expect(feed.runs).toHaveLength(1);
    expect(feed.truncated).toBe(true);
    await expect(
      listBrowserChatOutputFeed({
        database,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        limit: 51,
      }),
    ).rejects.toThrow('browser_chat_output_feed_invalid');
  });

  it('honors cancellation before returning project activity', async () => {
    const database = await fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      listBrowserChatOutputFeed({
        database,
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        limit: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

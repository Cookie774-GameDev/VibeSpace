import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db/database';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createCaoChatCommands } from './chatCommands';
import type { Chat } from '@/types';
import type { Workspace, Project } from '@/lib/db/schema';
import { CAO_GUIDANCE_AREAS, type CaoGuidance } from '@/features/jarvis-memory/caoGuidance';

const opened: JarvisDexie[] = [];
afterEach(async () => { for (const db of opened.splice(0)) await db.delete(); });
const scope = { accountId: 'account-1', workspaceId: 'workspace-1', projectId: 'project-1' };
const guidance: CaoGuidance = { schemaVersion: 1, sourceIds: ['source-1'], sections: Object.fromEntries(CAO_GUIDANCE_AREAS.map(area => [area, { guidance: 'Use concrete observed evidence and preserve the exact user scope.', sourceIds: ['source-1'] }])) };
async function harness() {
  const database = createJarvisDb(uniqueTestDbName('cao-commands'), TEST_INDEXED_DB); opened.push(database); await database.open();
  await database.workspaces.put({ id: scope.workspaceId, owner_id: scope.accountId } as Workspace);
  await database.projects.put({ id: scope.projectId, workspace_id: scope.workspaceId } as Project);
  await database.chats.put({ id: 'chat-1', title: 'Build tracker', mode: 'chat', workspace_id: scope.workspaceId, project_id: scope.projectId, active_agent_ids: [], created_at: 1, updated_at: 1, connection: { providerId: 'openai', id: 'openai-codex', modelId: 'gpt-5.6-terra' } } as unknown as Chat);
  let signature = 'original'; let mode: 'approve-before-send' | 'full-access' = 'approve-before-send';
  const review = vi.fn(async () => ({ text: 'The transcript has no implementation or test evidence. Verification is not established.', receipt: { requestId: 'review-1', sessionId: 'session-1', providerId: 'openai', connectionId: 'openai-codex', modelId: 'gpt-5.6-terra', reasoningEffort: 'high' } }));
  const control = vi.fn(async () => 'resumed' as const);
  const compose = () => createCaoChatCommands({ database, accountId: () => scope.accountId, authorization: async () => ({ signature, mode, guidance }), agentSignature: () => 'jarvis-v1', review, control, runState: () => ({ chatId: 'chat-1', status: 'cancelled' as const, cancellationKey: 'turn-1' }) });
  const service = compose();
  return { database, service, compose, review, control, revoke: () => { signature = 'revoked'; }, full: () => { mode = 'full-access'; }, start: (action: 'diagnose' | 'restart' | 'grade' = 'diagnose') => service.prepare({ ...scope, callerChatId: 'chat-1', command: { action, source: 'natural-language', selectors: [{ kind: 'chat', by: 'id', selector: 'chat-1' }] } }) };
}
describe('production CAO chat command composition', () => {
  it('persists a grounded read-only report with canonical run, control record and released lease', async () => {
    const h = await harness(); const result = await h.start();
    expect(result.status).toBe('completed'); expect(result.report).toContain('not established');
    expect(await h.database.cao_target_claims.count()).toBe(0);
    expect((await h.database.cao_control_records.get(result.requestId))?.status).toBe('completed');
    expect((await h.service.read(result.accountId, result.requestId))?.report).toBe(result.report);
    expect(h.control).not.toHaveBeenCalled();
  });
  it('persists approval, resumes through a newly composed service, and does not execute twice', async () => {
    const h = await harness(); const pending = await h.start('restart');
    expect(pending.status).toBe('awaiting_approval'); expect(h.control).not.toHaveBeenCalled();
    const done = await h.compose().decide(scope.accountId, pending.requestId, 'approve');
    expect(done.status).toBe('completed'); expect(h.control).toHaveBeenCalledTimes(1);
    await h.service.decide(scope.accountId, pending.requestId, 'approve');
    expect(h.control).toHaveBeenCalledTimes(1);
  });
  it('rejects permission changes between proposal and approval', async () => {
    const h = await harness(); const pending = await h.start('restart'); h.revoke();
    await expect(h.service.decide(scope.accountId, pending.requestId, 'approve')).rejects.toThrow('cao_control_authority_changed');
    expect(h.control).not.toHaveBeenCalled();
  });
  it('rejects a changed target before approval without touching its new run', async () => {
    const h = await harness(); const pending = await h.start('restart');
    await h.database.chats.update('chat-1' as Chat['id'], { updated_at: 2 });
    await expect(h.service.decide(scope.accountId, pending.requestId, 'approve')).rejects.toThrow('cao_control_target_changed');
    expect(h.control).not.toHaveBeenCalled();
  });
  it('uses the explicit full-access grant and records the exact effect acknowledgement', async () => {
    const h = await harness(); h.full(); const result = await h.start('restart');
    expect(result.status).toBe('completed'); expect(result.report).toContain('resumed');
    expect(h.control).toHaveBeenCalledTimes(1);
  });
  it('allows discarding a pending command after authority changes and closes the canonical record', async () => {
    const h = await harness(); const pending = await h.start('restart'); h.revoke();
    await h.service.cancel(scope.accountId, pending.requestId);
    expect((await h.database.cao_control_records.get(pending.requestId))?.status).toBe('cancelled');
    expect(h.control).not.toHaveBeenCalled();
  });
  it('keeps an existing pending command visible instead of replacing it', async () => {
    const h = await harness(); await h.start('restart');
    await expect(h.start('restart')).rejects.toThrow('cao_control_previous_command_pending');
    expect(h.control).not.toHaveBeenCalled();
  });
});

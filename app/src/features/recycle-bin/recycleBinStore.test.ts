import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { Agent, AgentId } from '@/types';
import type { CustomSkillRecord } from '@/features/skills/skillsStore';
import { RECYCLE_BIN_RETENTION_MS, recycleBinStore, type RecycleBinItem } from './recycleBinStore';

let accountSequence = 0;

const agent: Agent = {
  id: 'agt_recycle_store' as AgentId,
  slug: 'recycle-store-agent',
  name: 'Recycle Store Agent',
  description: 'Agent archive fixture',
  system_prompt: 'Keep this prompt.',
  model: { provider: 'mock', model: 'mock-default' },
  tools_allowed: ['*'],
  memory_scope: 'project',
  capabilities: ['writing'],
  builtin: false,
  created_at: 10,
  updated_at: 20,
};

const skill: CustomSkillRecord = {
  id: 'custom_recycle_store',
  name: 'Recycle Store Skill',
  description: 'Skill archive fixture',
  tools: ['read'],
  systemPromptAddendum: 'Read carefully.',
  body: '# Recycle Store Skill',
  color_hue: 35,
  emoji: '✨',
  enabled: true,
  createdAt: 10,
  updatedAt: 20,
};

function useAccount(accountId = `recycle-account-${++accountSequence}`): string {
  useAuthStore.setState({ cloudSession: null, localUserId: accountId });
  recycleBinStore.refreshScope();
  return accountId;
}

describe('recycleBinStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAccount();
  });

  it('keeps an archive before 90 days and removes it at the exact boundary', () => {
    const deletedAt = Date.parse('2026-08-10T12:00:00.000Z');
    recycleBinStore.archiveSkill(skill, deletedAt);

    recycleBinStore.pruneExpired(deletedAt + RECYCLE_BIN_RETENTION_MS - 1);
    expect(recycleBinStore.getSnapshot()).toHaveLength(1);

    recycleBinStore.pruneExpired(deletedAt + RECYCLE_BIN_RETENTION_MS);
    expect(recycleBinStore.getSnapshot()).toEqual([]);
  });

  it('clears account A from memory before loading account B and restores A independently', () => {
    const now = Date.now();
    const accountA = useAccount('recycle-account-a');
    recycleBinStore.archiveAgent(agent, now);
    expect(recycleBinStore.getSnapshot().map(({ entityId }) => entityId)).toEqual([agent.id]);

    useAccount('recycle-account-b');
    expect(recycleBinStore.getSnapshot()).toEqual([]);
    recycleBinStore.archiveSkill(skill, now + 1);

    useAccount(accountA);
    expect(recycleBinStore.getSnapshot().map(({ entityId }) => entityId)).toEqual([agent.id]);
  });

  it('isolates local and cloud identities even when their account ids match', () => {
    const accountId = 'same-visible-id';
    useAccount(accountId);
    recycleBinStore.archiveAgent(agent, Date.now());

    useAuthStore.setState({
      cloudSession: {
        user_id: accountId,
        email: 'owner@example.test',
        expires_at: Date.now() + 60_000,
      },
      localUserId: accountId,
    });
    recycleBinStore.refreshScope();
    expect(recycleBinStore.getSnapshot()).toEqual([]);

    useAccount(accountId);
    expect(recycleBinStore.getSnapshot().map(({ entityId }) => entityId)).toEqual([agent.id]);
  });

  it('does not publish an archive when durable persistence fails', () => {
    const now = Date.now();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('storage unavailable');
    });

    expect(() => recycleBinStore.archiveSkill(skill, now)).toThrow();
    expect(recycleBinStore.getSnapshot()).toEqual([]);
    setItem.mockRestore();
  });

  it('recovers only bounded valid records and rejects duplicate archive identities', () => {
    const now = Date.now();
    const accountId = useAccount('recycle-account-recovery');
    const valid: RecycleBinItem = {
      archiveId: 'bin_valid',
      kind: 'skill',
      entityId: skill.id,
      name: skill.name,
      deletedAt: now,
      expiresAt: now + RECYCLE_BIN_RETENTION_MS,
      payload: skill,
    };
    window.localStorage.setItem(
      `vibespace-recycle-bin-v1:${encodeURIComponent(`local\u0000${accountId}`)}`,
      JSON.stringify({
        items: [
          valid,
          { ...valid },
          { ...valid, archiveId: '__proto__' },
          { ...valid, archiveId: 'bin_bad_deadline', expiresAt: Number.NaN },
          { ...valid, archiveId: 'bin_oversized', name: 'x'.repeat(2_001) },
        ],
      }),
    );

    useAccount('recycle-account-other');
    useAccount(accountId);

    expect(recycleBinStore.getSnapshot()).toEqual([valid]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('notifies subscribers exactly once for each committed mutation', () => {
    const now = Date.now();
    const listener = vi.fn();
    const unsubscribe = recycleBinStore.subscribe(listener);

    const archived = recycleBinStore.archiveSkill(skill, now);
    recycleBinStore.removeArchive(archived.archiveId);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

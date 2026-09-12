import { describe, expect, it, vi } from 'vitest';
import type { CustomSkillRecord } from '@/features/skills/skillsStore';
import type { Agent, AgentId } from '@/types';
import type { RecycleBinItem } from './recycleBinStore';
import { createRecycleBinService } from './recycleBinService';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt-original' as AgentId,
    slug: 'researcher',
    name: 'Researcher',
    description: 'Finds facts',
    system_prompt: 'Research carefully.',
    model: { provider: 'openai', model: 'gpt-5' },
    tools_allowed: [],
    memory_scope: 'agent',
    capabilities: [],
    builtin: false,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function skill(overrides: Partial<CustomSkillRecord> = {}): CustomSkillRecord {
  return {
    id: 'custom-original',
    name: 'Custom skill',
    description: 'Does one thing',
    tools: ['read'],
    systemPromptAddendum: 'Be exact.',
    body: '# Exact',
    color_hue: 200,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function harness() {
  const archives: RecycleBinItem[] = [];
  const bin = {
    archiveAgent: vi.fn((payload: Agent) => {
      const item = {
        archiveId: `archive-${payload.id}`,
        kind: 'agent' as const,
        entityId: payload.id,
        name: payload.name,
        deletedAt: 10,
        expiresAt: 20,
        payload,
      };
      archives.push(item);
      return item;
    }),
    archiveSkill: vi.fn((payload: CustomSkillRecord) => {
      const item = {
        archiveId: `archive-${payload.id}`,
        kind: 'skill' as const,
        entityId: payload.id,
        name: payload.name,
        deletedAt: 10,
        expiresAt: 20,
        payload,
      };
      archives.push(item);
      return item;
    }),
    removeArchive: vi.fn((archiveId: string) => {
      const index = archives.findIndex((item) => item.archiveId === archiveId);
      if (index >= 0) archives.splice(index, 1);
    }),
    restoreArchive: vi.fn((item: RecycleBinItem) => archives.push(item)),
    empty: vi.fn(() => archives.splice(0)),
  };
  const agents = {
    getById: vi.fn(async () => undefined as Agent | undefined),
    getBySlug: vi.fn(async () => undefined as Agent | undefined),
    create: vi.fn(async (input: Omit<Agent, 'created_at' | 'updated_at'>) =>
      agent({ ...input, created_at: 100, updated_at: 100 }),
    ),
    delete: vi.fn(async () => undefined),
  };
  const skills = {
    getCustomSkill: vi.fn(() => undefined as CustomSkillRecord | undefined),
    removeCustomSkill: vi.fn(),
    restoreCustomSkill: vi.fn(),
  };
  const registerAgent = vi.fn();
  const unregisterAgent = vi.fn();
  const refreshSkills = vi.fn();
  const service = createRecycleBinService({
    bin,
    agents,
    skills: () => skills,
    registerAgent,
    unregisterAgent,
    refreshSkills,
    newAgentId: () => 'agt-restored' as AgentId,
  });
  return {
    archives,
    bin,
    agents,
    skills,
    registerAgent,
    unregisterAgent,
    refreshSkills,
    service,
  };
}

describe('recycleBinService', () => {
  it('archives an agent before deleting it and rolls the archive back on failure', async () => {
    const test = harness();
    const original = agent();
    test.agents.delete.mockRejectedValueOnce(new Error('delete failed'));

    await expect(test.service.moveAgentToRecycleBin(original)).rejects.toThrow('delete failed');

    expect(test.bin.archiveAgent).toHaveBeenCalledWith(original);
    expect(test.agents.delete).toHaveBeenCalledWith(original.id);
    expect(test.bin.removeArchive).toHaveBeenCalledWith(`archive-${original.id}`);
    expect(test.archives).toEqual([]);
    expect(test.unregisterAgent).not.toHaveBeenCalled();
  });

  it('never archives or deletes a built-in agent', async () => {
    const test = harness();

    await expect(test.service.moveAgentToRecycleBin(agent({ builtin: true }))).rejects.toThrow(
      'Built-in agents cannot be deleted.',
    );

    expect(test.bin.archiveAgent).not.toHaveBeenCalled();
    expect(test.agents.delete).not.toHaveBeenCalled();
  });

  it('archives a custom skill before removal and compensates a failed removal', async () => {
    const test = harness();
    const original = skill();
    test.skills.getCustomSkill.mockReturnValue(original);
    test.skills.removeCustomSkill.mockImplementationOnce(() => {
      throw new Error('storage failed');
    });

    await expect(test.service.moveSkillToRecycleBin(original.id)).rejects.toThrow('storage failed');

    expect(test.bin.removeArchive).toHaveBeenCalledWith(`archive-${original.id}`);
    expect(test.archives).toEqual([]);
    expect(test.refreshSkills).not.toHaveBeenCalled();
  });

  it('restores a removed skill if the live registry cannot refresh', async () => {
    const test = harness();
    const original = skill();
    test.skills.getCustomSkill.mockReturnValue(original);
    test.refreshSkills.mockImplementationOnce(() => {
      throw new Error('registry failed');
    });

    await expect(test.service.moveSkillToRecycleBin(original.id)).rejects.toThrow(
      'registry failed',
    );

    expect(test.skills.restoreCustomSkill).toHaveBeenCalledWith(original);
    expect(test.bin.removeArchive).toHaveBeenCalledWith(`archive-${original.id}`);
    expect(test.archives).toEqual([]);
  });

  it('restores an exact agent when its identity is free', async () => {
    const test = harness();
    const item = test.bin.archiveAgent(agent());
    item.expiresAt = Date.now() + 60_000;

    const restored = await test.service.restore(item);

    expect(restored).toMatchObject({ kind: 'agent', entityId: 'agt-original' });
    expect(test.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agt-original', slug: 'researcher', name: 'Researcher' }),
    );
    expect(test.registerAgent).toHaveBeenCalledOnce();
    expect(test.bin.removeArchive).toHaveBeenCalledWith(item.archiveId);
  });

  it('restores an agent under a safe new identity instead of overwriting a conflict', async () => {
    const test = harness();
    const original = agent();
    const item = test.bin.archiveAgent(original);
    item.expiresAt = Date.now() + 60_000;
    test.agents.getById.mockResolvedValueOnce(agent({ id: original.id }));

    const restored = await test.service.restore(item);

    expect(restored).toEqual({
      kind: 'agent',
      entityId: 'agt-restored',
      renamed: true,
    });
    expect(test.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agt-restored',
        slug: 'restored_researcher',
        name: 'Researcher (restored)',
      }),
    );
  });

  it('rolls back a restored skill if removing its archive fails', async () => {
    const test = harness();
    const item = test.bin.archiveSkill(skill());
    item.expiresAt = Date.now() + 60_000;
    test.bin.removeArchive.mockImplementationOnce(() => {
      throw new Error('archive persistence failed');
    });

    await expect(test.service.restore(item)).rejects.toThrow('archive persistence failed');

    expect(test.skills.restoreCustomSkill).toHaveBeenCalledWith(item.payload);
    expect(test.skills.removeCustomSkill).toHaveBeenCalledWith(item.entityId);
    expect(test.refreshSkills).toHaveBeenCalledTimes(2);
  });

  it('rejects restoration at the exact expiration boundary without mutating active state', async () => {
    const test = harness();
    const item = test.bin.archiveSkill(skill());
    item.expiresAt = Date.now();

    await expect(test.service.restore(item)).rejects.toThrow('This Recycle Bin item has expired.');

    expect(test.skills.restoreCustomSkill).not.toHaveBeenCalled();
    expect(test.bin.removeArchive).not.toHaveBeenCalled();
  });
});

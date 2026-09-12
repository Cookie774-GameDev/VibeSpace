import { skillRegistry } from '@/features/skills/registry';
import { readSkillsStore, type CustomSkillRecord } from '@/features/skills/skillsStore';
import { agentRepo, type AgentCreateInput } from '@/lib/db/repositories';
import { newAgentId } from '@/lib/ids';
import { useAgentStore } from '@/stores/agents';
import type { Agent, AgentId } from '@/types';
import {
  recycleBinStore,
  type RecycleBinItem,
  type RecycledAgentItem,
  type RecycledSkillItem,
} from './recycleBinStore';

type AgentRepository = {
  getById(id: AgentId): Promise<Agent | undefined>;
  getBySlug(slug: string): Promise<Agent | undefined>;
  create(input: AgentCreateInput): Promise<Agent>;
  delete(id: AgentId): Promise<void>;
};

type SkillStore = {
  getCustomSkill(id: string): CustomSkillRecord | undefined;
  removeCustomSkill(id: string): void;
  restoreCustomSkill(record: CustomSkillRecord): void;
};

type RecycleBin = {
  archiveAgent(agent: Agent): RecycledAgentItem;
  archiveSkill(skill: CustomSkillRecord): RecycledSkillItem;
  removeArchive(archiveId: string): void;
  empty(): void;
};

export type RecycleBinRestoreResult =
  | { kind: 'agent'; entityId: AgentId; renamed: boolean }
  | { kind: 'skill'; entityId: string; renamed: false };

export interface RecycleBinServiceDependencies {
  bin: RecycleBin;
  agents: AgentRepository;
  skills: () => SkillStore;
  registerAgent: (agent: Agent) => void;
  unregisterAgent: (id: AgentId) => void;
  refreshSkills: () => void;
  newAgentId: () => AgentId;
}

function withoutAgentTimestamps(agent: Agent): Omit<Agent, 'created_at' | 'updated_at'> {
  const { created_at: _createdAt, updated_at: _updatedAt, ...input } = agent;
  return input;
}

async function selectRestoredAgentIdentity(
  item: RecycledAgentItem,
  dependencies: RecycleBinServiceDependencies,
): Promise<{ id: AgentId; slug: string; name: string; renamed: boolean }> {
  const idConflict = await dependencies.agents.getById(item.entityId);
  const slugConflict = await dependencies.agents.getBySlug(item.payload.slug);
  if (!idConflict && !slugConflict) {
    return {
      id: item.entityId,
      slug: item.payload.slug,
      name: item.payload.name,
      renamed: false,
    };
  }

  let candidate = `restored_${item.payload.slug}`.slice(0, 180);
  let suffix = 2;
  while (await dependencies.agents.getBySlug(candidate)) {
    candidate = `restored_${item.payload.slug}_${suffix}`.slice(0, 180);
    suffix += 1;
  }
  return {
    id: dependencies.newAgentId(),
    slug: candidate,
    name: `${item.payload.name} (restored)`.slice(0, 200),
    renamed: true,
  };
}

export function createRecycleBinService(dependencies: RecycleBinServiceDependencies) {
  async function moveAgentToRecycleBin(agent: Agent): Promise<RecycledAgentItem> {
    if (agent.builtin) throw new Error('Built-in agents cannot be deleted.');
    const archived = dependencies.bin.archiveAgent(agent);
    try {
      await dependencies.agents.delete(agent.id);
    } catch (error) {
      try {
        dependencies.bin.removeArchive(archived.archiveId);
      } catch {
        // Preserve the original repository failure. The retained archive is safer
        // than losing both copies and can still be inspected in Settings.
      }
      throw error;
    }
    dependencies.unregisterAgent(agent.id);
    return archived;
  }

  async function moveSkillToRecycleBin(id: string): Promise<RecycledSkillItem> {
    const store = dependencies.skills();
    const skill = store.getCustomSkill(id);
    if (!skill) throw new Error('Only custom skills can be moved to the Recycle Bin.');
    const archived = dependencies.bin.archiveSkill(skill);
    try {
      store.removeCustomSkill(id);
    } catch (error) {
      try {
        dependencies.bin.removeArchive(archived.archiveId);
      } catch {
        // Preserve the original durable-store failure.
      }
      throw error;
    }
    try {
      dependencies.refreshSkills();
    } catch (error) {
      try {
        store.restoreCustomSkill(skill);
        dependencies.refreshSkills();
        dependencies.bin.removeArchive(archived.archiveId);
      } catch {
        throw new AggregateError(
          [error],
          'The skill was archived, but the active catalog could not finalize the deletion.',
        );
      }
      throw error;
    }
    return archived;
  }

  async function restoreAgent(item: RecycledAgentItem): Promise<RecycleBinRestoreResult> {
    const identity = await selectRestoredAgentIdentity(item, dependencies);
    const input: AgentCreateInput = {
      ...withoutAgentTimestamps(item.payload),
      id: identity.id,
      slug: identity.slug,
      name: identity.name,
      builtin: false,
    };
    const restored = await dependencies.agents.create(input);
    dependencies.registerAgent(restored);
    try {
      dependencies.bin.removeArchive(item.archiveId);
    } catch (error) {
      dependencies.unregisterAgent(restored.id);
      try {
        await dependencies.agents.delete(restored.id);
      } catch {
        throw new AggregateError(
          [error],
          'The agent was restored, but the Recycle Bin could not finalize the restore.',
        );
      }
      throw error;
    }
    return { kind: 'agent', entityId: restored.id, renamed: identity.renamed };
  }

  async function restoreSkill(item: RecycledSkillItem): Promise<RecycleBinRestoreResult> {
    const store = dependencies.skills();
    store.restoreCustomSkill(item.payload);
    try {
      dependencies.refreshSkills();
      dependencies.bin.removeArchive(item.archiveId);
    } catch (error) {
      try {
        store.removeCustomSkill(item.entityId);
        dependencies.refreshSkills();
      } catch {
        throw new AggregateError(
          [error],
          'The skill was restored, but the Recycle Bin could not finalize the restore.',
        );
      }
      throw error;
    }
    return { kind: 'skill', entityId: item.entityId, renamed: false };
  }

  return {
    moveAgentToRecycleBin,
    moveSkillToRecycleBin,
    restore(item: RecycleBinItem): Promise<RecycleBinRestoreResult> {
      if (item.expiresAt <= Date.now()) {
        return Promise.reject(new Error('This Recycle Bin item has expired.'));
      }
      return item.kind === 'agent' ? restoreAgent(item) : restoreSkill(item);
    },
    permanentlyDelete(archiveId: string): void {
      dependencies.bin.removeArchive(archiveId);
    },
    empty(): void {
      dependencies.bin.empty();
    },
  };
}

export const recycleBinService = createRecycleBinService({
  bin: recycleBinStore,
  agents: agentRepo,
  skills: readSkillsStore,
  registerAgent: (agent) => useAgentStore.getState().registerAgent(agent),
  unregisterAgent: (id) => useAgentStore.getState().unregisterAgent(id),
  refreshSkills: () => skillRegistry.refresh(),
  newAgentId,
});

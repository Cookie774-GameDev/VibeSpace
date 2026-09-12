import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { WorkspaceId } from '@/types/common';

const repoMocks = vi.hoisted(() => ({
  agentList: vi.fn(),
  projectList: vi.fn(),
}));

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    agentRepo: { ...actual.agentRepo, list: repoMocks.agentList },
    projectRepo: { ...actual.projectRepo, listByWorkspace: repoMocks.projectList },
  };
});

import { executeIntent } from './execute';

describe('executeIntent navigation', () => {
  beforeEach(() => {
    repoMocks.agentList.mockReset();
    repoMocks.projectList.mockReset();
    useUIStore.setState({ route: 'chat', activeAgentId: null });
    useAuthStore.setState({ workspaceId: 'wsp_test' as WorkspaceId, projectId: null });
  });

  it('navigates simple routes through the canonical UI store action', async () => {
    await expect(executeIntent({ kind: 'navigate', route: 'files' })).resolves.toEqual({
      ok: true,
      message: 'Showing files.',
    });
    expect(useUIStore.getState().route).toBe('files');
  });

  it('resolves an agent by exact id or unique case-insensitive name before navigation', async () => {
    repoMocks.agentList.mockResolvedValue([
      { id: 'agt_jarvis', name: 'Jarvis' },
      { id: 'agt_friday', name: 'Friday' },
    ]);

    await expect(
      executeIntent({ kind: 'navigate', route: 'agent-detail', selector: 'JARVIS' }),
    ).resolves.toMatchObject({ ok: true });
    expect(useUIStore.getState().activeAgentId).toBe('agt_jarvis');
    expect(useUIStore.getState().route).toBe('agent-detail');
  });

  it('fails closed for an ambiguous agent name without changing route', async () => {
    repoMocks.agentList.mockResolvedValue([
      { id: 'agt_1', name: 'Coder' },
      { id: 'agt_2', name: 'coder' },
    ]);

    await expect(
      executeIntent({ kind: 'navigate', route: 'agent-detail', selector: 'coder' }),
    ).resolves.toMatchObject({ ok: false });
    expect(useUIStore.getState().route).toBe('chat');
  });

  it('resolves a project and sets its id before opening project detail', async () => {
    repoMocks.projectList.mockResolvedValue([
      { id: 'prj_vibespace', name: 'VibeSpace' },
      { id: 'prj_other', name: 'Other' },
    ]);

    await expect(
      executeIntent({ kind: 'navigate', route: 'project-detail', selector: 'vibespace' }),
    ).resolves.toMatchObject({ ok: true });
    expect(useAuthStore.getState().projectId).toBe('prj_vibespace');
    expect(useUIStore.getState().route).toBe('project-detail');
  });
});

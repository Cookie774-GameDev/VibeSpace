import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { bindToolGatewaySessionAuthority, captureToolGatewayAuthorityClaim,
  clearToolGatewayAuthorityForTests } from '@/lib/harness/toolGatewayAuthority';
import { createProductionToolGatewayDependencies } from '@/lib/harness/toolGatewayProduction';
import { createToolGatewayRuntime } from '@/lib/harness/toolGatewayRuntime';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';

// Only the persistence IO boundary is substituted. Decoder, authority,
// production context handler and response safety checks remain real.
vi.mock('@/features/context/contextPersistence', async original => ({
  ...await original<typeof import('@/features/context/contextPersistence')>(),
  loadPersistedContextMaps: async (projectId: string | null) => projectId !== 'project-a' ? [] : [{
    id: 'map-a', projectId: 'project-a', rootDir: 'C:\\fixture', name: 'Fixture', status: 'active',
    sourceType: 'local_folder', createdAt: 1, updatedAt: 1,
    tree: { version: 1, projectId: 'project-a', rootDir: 'C:\\fixture', generatedAt: 1,
      model: 'context-map-v2', fileCount: 1, totalBytes: 1, summary: '', recommendedEntryPoints: [],
      nodes: [
        { id: 'virtual-group', kind: 'root', title: 'Virtual group', summary: '', createdAt: 1, modifiedAt: 1 },
        { id: 'file-node', kind: 'file', title: 'charter.txt', summary: 'Charter',
          path: 'C:\\fixture\\charter.txt', createdAt: 1, modifiedAt: 1 },
      ],
    },
  }],
}));

beforeEach(() => {
  clearToolGatewayAuthorityForTests();
  useAuthStore.setState({ localUserId: 'account-a', cloudSession: null,
    workspaceId: 'workspace-a' as WorkspaceId, projectId: 'project-a' as ProjectId });
  const claim = captureToolGatewayAuthorityClaim()!;
  expect(bindToolGatewaySessionAuthority('context-node-session', claim)).toBe(true);
});
afterEach(() => clearToolGatewayAuthorityForTests());

describe('production context node response metadata', () => {
  it('returns a valid pathless virtual node through the real dispatcher', async () => {
    const runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
    const result = await runtime.execute(parseToolGatewayRequest({ protocolVersion: 1,
      requestId: 'context-node-1', sessionId: 'context-node-session', messageId: 'context-node-turn', tool: 'context.read',
      args: { contextId: 'virtual-group' } }));
    expect(result).toMatchObject({ ok: true, code: 'ok',
      data: { id: 'virtual-group', title: 'Virtual group', summary: '', mapId: 'map-a' } });
    expect(Object.prototype.hasOwnProperty.call(result.data, 'path')).toBe(false);
  });
  it('preserves the source path on an ordinary file node', async () => {
    const runtime = createToolGatewayRuntime(createProductionToolGatewayDependencies());
    const result = await runtime.execute(parseToolGatewayRequest({ protocolVersion: 1,
      requestId: 'context-node-2', sessionId: 'context-node-session', messageId: 'context-node-turn', tool: 'context.read',
      args: { contextId: 'file-node' } }));
    expect(result).toMatchObject({ ok: true, code: 'ok', data: {
      id: 'file-node', title: 'charter.txt', summary: 'Charter', mapId: 'map-a', path: 'C:\\fixture\\charter.txt',
    } });
  });
});

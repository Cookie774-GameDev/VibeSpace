import { describe, expect, it, vi } from 'vitest';
import type { FsDirectoryResult, FsFileTransferResult, FsPathStatResult } from '@/lib/fs';
import { BrowserChatApprovalBroker } from './approvalBroker';
import {
  BrowserChatFileStructureError,
  createBrowserChatFileStructureAdapter,
  type BrowserChatFileStructureDependencies,
} from './browserChatFileStructureAdapter';
import {
  BROWSER_CHAT_CAPABILITIES,
  type BrowserChatCapabilityId,
  type BrowserChatCapabilityLease,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

const ROOT = 'C:\\repo';
const HASH = `sha256:${'a'.repeat(64)}` as const;

function profile(): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'project-a',
    plan: 'full_local_developer',
    overrides: {},
    updatedAt: 1,
  };
}

function broker(): BrowserChatApprovalBroker {
  let token = 0;
  const capabilities = new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id));
  return new BrowserChatApprovalBroker({
    profile: profile(),
    grantedCapabilities: capabilities,
    availableCapabilities: capabilities,
    providerCapabilities: capabilities,
    providerBridgeAvailable: true,
    leaseIdFactory: () => `structure-lease-${++token}`,
  });
}

function lease(
  approvalBroker: BrowserChatApprovalBroker,
  capabilityId: BrowserChatCapabilityId,
  now = 100,
): BrowserChatCapabilityLease {
  const decision = approvalBroker.authorize(capabilityId, { now, ttlMs: 5_000 });
  if (decision.kind !== 'granted') throw new Error(`expected ${capabilityId} grant`);
  return decision.lease;
}

function dependencies(
  overrides: Partial<BrowserChatFileStructureDependencies> = {},
): BrowserChatFileStructureDependencies {
  return {
    statProjectPath: vi.fn(
      async (path: string): Promise<FsPathStatResult> => ({
        ok: true,
        path,
        kind: 'file',
        size: 12,
        sha256: HASH,
      }),
    ),
    createDirectoryWithReceipt: vi.fn(
      async (path: string): Promise<FsDirectoryResult> => ({ ok: true, path, created: true }),
    ),
    copyProjectFile: vi.fn(
      async (sourcePath: string, path: string): Promise<FsFileTransferResult> => ({
        ok: true,
        sourcePath,
        path,
        bytes: 12,
        sha256: HASH,
      }),
    ),
    moveProjectFileWithReceipt: vi.fn(
      async (sourcePath: string, path: string): Promise<FsFileTransferResult> => ({
        ok: true,
        sourcePath,
        path,
        bytes: 12,
        sha256: HASH,
      }),
    ),
    ...overrides,
  };
}

describe('Browser Chat strict file structure adapter', () => {
  it('returns bounded metadata/hash without exposing the approved absolute root', async () => {
    const approvalBroker = broker();
    const deps = dependencies();
    const adapter = createBrowserChatFileStructureAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });

    await expect(
      adapter.stat({
        lease: lease(approvalBroker, 'files.read'),
        path: 'assets\\icon.bin',
        includeSha256: true,
        now: 100,
      }),
    ).resolves.toEqual({
      path: 'assets/icon.bin',
      kind: 'file',
      size: 12,
      sha256: HASH,
    });
    expect(deps.statProjectPath).toHaveBeenCalledWith(`${ROOT}\\assets\\icon.bin`, true, {
      root: ROOT,
      strictProjectBoundary: true,
    });
  });

  it('creates directories and transfers files with capability-specific one-shot leases', async () => {
    const approvalBroker = broker();
    const deps = dependencies();
    const adapter = createBrowserChatFileStructureAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });

    await expect(
      adapter.createDirectory({
        lease: lease(approvalBroker, 'files.create', 100),
        path: 'generated\\images',
        now: 100,
      }),
    ).resolves.toEqual({ path: 'generated/images', created: true });

    await expect(
      adapter.copy({
        readLease: lease(approvalBroker, 'files.read', 200),
        createLease: lease(approvalBroker, 'files.create', 200),
        sourcePath: 'assets\\icon.bin',
        destinationPath: 'generated\\icon.bin',
        now: 200,
      }),
    ).resolves.toEqual({
      operation: 'copy',
      sourcePath: 'assets/icon.bin',
      path: 'generated/icon.bin',
      bytes: 12,
      sha256: HASH,
    });

    await expect(
      adapter.move({
        lease: lease(approvalBroker, 'files.move', 300),
        sourcePath: 'generated\\icon.bin',
        destinationPath: 'generated\\renamed.bin',
        now: 300,
      }),
    ).resolves.toEqual({
      operation: 'move',
      sourcePath: 'generated/icon.bin',
      path: 'generated/renamed.bin',
      bytes: 12,
      sha256: HASH,
    });
  });

  it('rejects traversal, wrong capabilities, same-path transfers, and forged native receipts', async () => {
    const approvalBroker = broker();
    const deps = dependencies({
      statProjectPath: vi.fn(async (path: string) => ({
        ok: true as const,
        path: `${path}.forged`,
        kind: 'file' as const,
        size: 1,
      })),
    });
    const adapter = createBrowserChatFileStructureAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });

    await expect(
      adapter.stat({
        lease: lease(approvalBroker, 'files.read', 100),
        path: '..\\secret',
        now: 100,
      }),
    ).rejects.toBeInstanceOf(BrowserChatFileStructureError);
    await expect(
      adapter.createDirectory({
        lease: lease(approvalBroker, 'files.read', 200),
        path: 'generated',
        now: 200,
      }),
    ).rejects.toMatchObject({ code: 'capability_mismatch' });
    await expect(
      adapter.copy({
        readLease: lease(approvalBroker, 'files.read', 300),
        createLease: lease(approvalBroker, 'files.create', 300),
        sourcePath: 'same.bin',
        destinationPath: 'same.bin',
        now: 300,
      }),
    ).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(
      adapter.stat({
        lease: lease(approvalBroker, 'files.read', 400),
        path: 'asset.bin',
        now: 400,
      }),
    ).rejects.toMatchObject({ code: 'result_invalid' });
  });
});

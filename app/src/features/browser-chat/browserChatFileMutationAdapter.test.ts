import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Text, type FsTextMutationResult } from '@/lib/fs';
import { BrowserChatApprovalBroker } from './approvalBroker';
import {
  BrowserChatFileMutationError,
  createBrowserChatFileMutationAdapter,
  type BrowserChatFileMutationDependencies,
} from './browserChatFileMutationAdapter';
import {
  BROWSER_CHAT_CAPABILITIES,
  type BrowserChatCapabilityId,
  type BrowserChatCapabilityLease,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

const ROOT = 'C:\\repo';

function profile(): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'project-a',
    plan: 'project_developer',
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
    leaseIdFactory: () => `mutation-lease-${++token}`,
    requestIdFactory: () => `mutation-request-${++token}`,
  });
}

function approvedLease(
  approvalBroker: BrowserChatApprovalBroker,
  capabilityId: BrowserChatCapabilityId,
  now: number,
): BrowserChatCapabilityLease {
  const decision = approvalBroker.authorize(capabilityId, { now, ttlMs: 5_000 });
  if (decision.kind === 'granted') return decision.lease;
  if (decision.kind !== 'approval_required') throw new Error(`expected ${capabilityId} approval`);
  return approvalBroker.approve(decision.request.id, { now, ttlMs: 5_000 });
}

async function fixture(initial: Readonly<Record<string, string>>): Promise<{
  files: Map<string, string>;
  dependencies: BrowserChatFileMutationDependencies;
  compareAndSwapTextFile: ReturnType<typeof vi.fn>;
}> {
  const files = new Map(Object.entries(initial));
  const compareAndSwapTextFile = vi.fn(
    async (
      path: string,
      expectedSha256: `sha256:${string}` | null,
      nextContent: string | null,
    ): Promise<FsTextMutationResult> => {
      const before = files.get(path);
      const beforeSha256 = before === undefined ? null : await sha256Text(before);
      if (
        (expectedSha256 === null && before !== undefined) ||
        (expectedSha256 !== null && beforeSha256 !== expectedSha256)
      ) {
        return { ok: false, path, error: { code: 'stale_base' } };
      }
      if (nextContent === null) files.delete(path);
      else files.set(path, nextContent);
      return {
        ok: true,
        path,
        beforeSha256,
        afterSha256: nextContent === null ? null : await sha256Text(nextContent),
        beforeBytes: before === undefined ? 0 : new TextEncoder().encode(before).byteLength,
        afterBytes: nextContent === null ? 0 : new TextEncoder().encode(nextContent).byteLength,
      };
    },
  );
  return {
    files,
    compareAndSwapTextFile,
    dependencies: {
      readTextFileWithSha256: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          return { ok: false as const, path, error: { code: 'not_found' as const } };
        }
        return {
          ok: true as const,
          path,
          content,
          sha256: await sha256Text(content),
          bytes: new TextEncoder().encode(content).byteLength,
        };
      }),
      compareAndSwapTextFile,
    },
  };
}

describe('Browser Chat file mutation adapter', () => {
  beforeEach(() => vi.useRealTimers());

  it('previews, applies, and exactly undoes a bounded modification', async () => {
    const approvalBroker = broker();
    const { files, dependencies, compareAndSwapTextFile } = await fixture({
      [`${ROOT}\\notes.md`]: 'before\nstable',
    });
    const adapter = createBrowserChatFileMutationAdapter({
      root: ROOT,
      approvalBroker,
      dependencies,
      undoIdFactory: () => 'undo-modify-0001',
      previewIdFactory: () => 'preview-modify-0001',
    });

    const preview = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 50),
      operation: 'modify',
      path: 'notes.md',
      content: 'after\nstable',
      now: 50,
    });
    expect(preview).toMatchObject({
      id: 'preview-modify-0001',
      operation: 'modify',
      path: 'notes.md',
      beforeBytes: 13,
      afterBytes: 12,
      change: { changedBeforeLines: 1, changedAfterLines: 1 },
    });
    expect(preview).not.toHaveProperty('previousContent');
    expect(preview).not.toHaveProperty('nextContent');

    const applied = await adapter.apply({
      lease: approvedLease(approvalBroker, 'files.modify', 100),
      preview,
      now: 100,
    });
    expect(applied).toMatchObject({
      operation: 'modify',
      path: 'notes.md',
      undoId: 'undo-modify-0001',
    });
    expect(files.get(`${ROOT}\\notes.md`)).toBe('after\nstable');

    const undone = await adapter.undo({
      lease: approvedLease(approvalBroker, 'files.modify', 200),
      undoId: applied.undoId,
      now: 200,
    });
    expect(undone).toMatchObject({ operation: 'modify', path: 'notes.md' });
    expect(files.get(`${ROOT}\\notes.md`)).toBe('before\nstable');
    expect(compareAndSwapTextFile).toHaveBeenNthCalledWith(
      2,
      `${ROOT}\\notes.md`,
      preview.afterSha256,
      'before\nstable',
      { root: ROOT },
    );
  });

  it('uses exclusive create/delete bases and requires separately approved undo', async () => {
    const approvalBroker = broker();
    const { files, dependencies } = await fixture({
      [`${ROOT}\\remove.md`]: 'restore me',
    });
    let id = 0;
    const adapter = createBrowserChatFileMutationAdapter({
      root: ROOT,
      approvalBroker,
      dependencies,
      undoIdFactory: () => `undo-file-000${++id}`,
      previewIdFactory: () => `preview-file-${++id}`,
    });

    const createdPreview = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 50),
      operation: 'create',
      path: 'created.md',
      content: 'new',
      now: 50,
    });
    const created = await adapter.apply({
      lease: approvedLease(approvalBroker, 'files.create', 100),
      preview: createdPreview,
      now: 100,
    });
    expect(files.get(`${ROOT}\\created.md`)).toBe('new');
    await adapter.undo({
      lease: approvedLease(approvalBroker, 'files.delete', 200),
      undoId: created.undoId,
      now: 200,
    });
    expect(files.has(`${ROOT}\\created.md`)).toBe(false);

    const deletedPreview = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 250),
      operation: 'delete',
      path: 'remove.md',
      now: 250,
    });
    const deleted = await adapter.apply({
      lease: approvedLease(approvalBroker, 'files.delete', 300),
      preview: deletedPreview,
      now: 300,
    });
    expect(files.has(`${ROOT}\\remove.md`)).toBe(false);
    await adapter.undo({
      lease: approvedLease(approvalBroker, 'files.create', 400),
      undoId: deleted.undoId,
      now: 400,
    });
    expect(files.get(`${ROOT}\\remove.md`)).toBe('restore me');
  });

  it('fails closed on stale bases, preview replay, and mismatched capabilities', async () => {
    const approvalBroker = broker();
    const { files, dependencies } = await fixture({
      [`${ROOT}\\notes.md`]: 'before',
    });
    const adapter = createBrowserChatFileMutationAdapter({
      root: ROOT,
      approvalBroker,
      dependencies,
      undoIdFactory: () => 'undo-stale-0001',
      previewIdFactory: () => 'preview-stale-0001',
    });
    const preview = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 50),
      operation: 'modify',
      path: 'notes.md',
      content: 'after',
      now: 50,
    });
    files.set(`${ROOT}\\notes.md`, 'concurrent edit');

    await expect(
      adapter.apply({
        lease: approvedLease(approvalBroker, 'files.modify', 100),
        preview,
        now: 100,
      }),
    ).rejects.toMatchObject({ code: 'stale_base' });
    expect(files.get(`${ROOT}\\notes.md`)).toBe('concurrent edit');

    files.set(`${ROOT}\\notes.md`, 'before');
    const applied = await adapter.apply({
      lease: approvedLease(approvalBroker, 'files.modify', 200),
      preview,
      now: 200,
    });
    await expect(
      adapter.apply({
        lease: approvedLease(approvalBroker, 'files.modify', 300),
        preview,
        now: 300,
      }),
    ).rejects.toMatchObject({ code: 'preview_replayed' });
    await expect(
      adapter.undo({
        lease: approvedLease(approvalBroker, 'files.create', 400),
        undoId: applied.undoId,
        now: 400,
      }),
    ).rejects.toMatchObject({ code: 'capability_mismatch' });
  });

  it('rejects traversal, unsafe content, and forged previews before mutation', async () => {
    const approvalBroker = broker();
    const { dependencies, compareAndSwapTextFile } = await fixture({});
    const adapter = createBrowserChatFileMutationAdapter({
      root: ROOT,
      approvalBroker,
      dependencies,
    });

    await expect(
      adapter.preview({
        lease: approvedLease(approvalBroker, 'files.list', 40),
        operation: 'create',
        path: 'blocked.md',
        content: 'no',
        now: 40,
      }),
    ).rejects.toMatchObject({ code: 'capability_mismatch' });
    await expect(
      adapter.preview({
        lease: approvedLease(approvalBroker, 'files.read', 50),
        operation: 'create',
        path: '..\\escape.md',
        content: 'no',
        now: 50,
      }),
    ).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(
      adapter.preview({
        lease: approvedLease(approvalBroker, 'files.read', 60),
        operation: 'create',
        path: 'secret.md',
        content: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
        now: 60,
      }),
    ).rejects.toMatchObject({ code: 'sensitive_content_blocked' });
    await expect(
      adapter.apply({
        lease: approvedLease(approvalBroker, 'files.create', 100),
        preview: {
          id: 'preview-forged-0001',
          operation: 'create',
          path: 'forged.md',
          beforeSha256: null,
          afterSha256: await sha256Text('forged'),
          beforeBytes: 0,
          afterBytes: 6,
          change: { changedBeforeLines: 0, changedAfterLines: 1 },
          createdAt: 100,
          expiresAt: 300_100,
        },
        now: 100,
      }),
    ).rejects.toBeInstanceOf(BrowserChatFileMutationError);
    expect(dependencies.readTextFileWithSha256).not.toHaveBeenCalled();
    expect(compareAndSwapTextFile).not.toHaveBeenCalled();
  });

  it('expires previews and clears retained rollback content on revocation', async () => {
    const approvalBroker = broker();
    const { dependencies, compareAndSwapTextFile } = await fixture({
      [`${ROOT}\\notes.md`]: 'before',
    });
    let id = 0;
    const adapter = createBrowserChatFileMutationAdapter({
      root: ROOT,
      approvalBroker,
      dependencies,
      previewIdFactory: () => `preview-expiry-${++id}`,
    });
    const expired = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 100),
      operation: 'modify',
      path: 'notes.md',
      content: 'after',
      now: 100,
    });
    await expect(
      adapter.apply({
        lease: approvedLease(approvalBroker, 'files.modify', expired.expiresAt),
        preview: expired,
        now: expired.expiresAt,
      }),
    ).rejects.toMatchObject({ code: 'preview_expired' });

    const revoked = await adapter.preview({
      lease: approvedLease(approvalBroker, 'files.read', 200),
      operation: 'modify',
      path: 'notes.md',
      content: 'after',
      now: 200,
    });
    adapter.revoke();
    await expect(
      adapter.apply({
        lease: approvedLease(approvalBroker, 'files.modify', 300),
        preview: revoked,
        now: 300,
      }),
    ).rejects.toMatchObject({ code: 'preview_invalid' });
    expect(compareAndSwapTextFile).not.toHaveBeenCalled();
  });
});

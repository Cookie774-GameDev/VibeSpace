import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserChatFileAdapterError,
  createBrowserChatFileAdapter,
  type BrowserChatFileAdapterDependencies,
} from './browserChatFileAdapter';
import { BrowserChatApprovalBroker } from './approvalBroker';
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
    plan: 'read',
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
    leaseIdFactory: () => `file-adapter-lease-${++token}`,
  });
}

function lease(
  approvalBroker: BrowserChatApprovalBroker,
  capabilityId: BrowserChatCapabilityId,
  now = 100,
  ttlMs = 1_000,
): BrowserChatCapabilityLease {
  const decision = approvalBroker.authorize(capabilityId, { now, ttlMs });
  if (decision.kind !== 'granted') throw new Error(`expected ${capabilityId} grant`);
  return decision.lease;
}

function dependencies(
  overrides: Partial<BrowserChatFileAdapterDependencies> = {},
): BrowserChatFileAdapterDependencies {
  return {
    listDirectory: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      entries: [],
    })),
    readTextFileSample: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      content: '',
    })),
    ...overrides,
  };
}

describe('Browser Chat bounded file adapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists only bounded relative metadata and blocks traversal before native IPC', async () => {
    const approvalBroker = broker();
    const deps = dependencies({
      listDirectory: vi.fn(async (path: string) => ({
        ok: true as const,
        path,
        entries: [
          { name: 'src', path: `${ROOT}\\src`, isDir: true },
          { name: 'README.md', path: `${ROOT}\\README.md`, isDir: false, size: 42 },
          { name: '.env', path: `${ROOT}\\.env`, isDir: false, size: 10 },
          { name: 'escape.txt', path: 'C:\\outside\\escape.txt', isDir: false, size: 5 },
        ],
      })),
    });
    const adapter = createBrowserChatFileAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });

    await expect(
      adapter.list({ lease: lease(approvalBroker, 'files.list'), path: '.', now: 100 }),
    ).resolves.toEqual({
      path: '.',
      entries: [
        { name: 'src', path: 'src', isDir: true },
        { name: 'README.md', path: 'README.md', isDir: false, size: 42 },
      ],
      truncated: false,
    });
    expect(deps.listDirectory).toHaveBeenCalledWith(
      ROOT,
      {
        root: ROOT,
        strictProjectBoundary: true,
      },
      expect.any(AbortSignal),
    );

    await expect(
      adapter.list({
        lease: lease(approvalBroker, 'files.list', 200),
        path: '..\\secrets',
        now: 200,
      }),
    ).rejects.toMatchObject({ code: 'path_invalid' });
    expect(deps.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('reads bounded UTF-8 content without exposing detected secrets', async () => {
    const approvalBroker = broker();
    const deps = dependencies({
      readTextFileSample: vi.fn(async (path: string) => ({
        ok: true as const,
        path,
        content: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
      })),
    });
    const adapter = createBrowserChatFileAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });

    await expect(
      adapter.read({
        lease: lease(approvalBroker, 'files.read'),
        path: 'src\\config.ts',
        now: 100,
      }),
    ).rejects.toMatchObject({ code: 'sensitive_content_blocked' });
    expect(deps.readTextFileSample).toHaveBeenCalledWith(
      `${ROOT}\\src\\config.ts`,
      49_153,
      {
        root: ROOT,
        strictProjectBoundary: true,
      },
      expect.any(AbortSignal),
    );
  });

  it('searches a bounded tree, skips sensitive directories, and returns capped snippets', async () => {
    const approvalBroker = broker();
    const listDirectory = vi.fn(async (path: string) => {
      if (path === ROOT) {
        return {
          ok: true as const,
          path,
          entries: [
            { name: 'src', path: `${ROOT}\\src`, isDir: true },
            { name: '.git', path: `${ROOT}\\.git`, isDir: true },
            { name: 'README.md', path: `${ROOT}\\README.md`, isDir: false, size: 30 },
          ],
        };
      }
      return {
        ok: true as const,
        path,
        entries: [
          { name: 'match.ts', path: `${ROOT}\\src\\match.ts`, isDir: false, size: 50 },
          { name: 'binary.bin', path: `${ROOT}\\src\\binary.bin`, isDir: false, size: 50 },
        ],
      };
    });
    const readTextFileSample = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      content: path.endsWith('match.ts')
        ? 'first line\nBrowser Chat result\nlast line'
        : 'unrelated text',
    }));
    const adapter = createBrowserChatFileAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: dependencies({ listDirectory, readTextFileSample }),
    });

    await expect(
      adapter.search({
        lease: lease(approvalBroker, 'files.search'),
        path: '.',
        query: 'browser chat',
        now: 100,
      }),
    ).resolves.toEqual({
      path: '.',
      query: 'browser chat',
      matches: [
        {
          path: 'src/match.ts',
          line: 2,
          snippet: 'Browser Chat result',
        },
      ],
      searchedFiles: 3,
      truncated: false,
    });
    expect(listDirectory).not.toHaveBeenCalledWith(`${ROOT}\\.git`, expect.anything());
    expect(readTextFileSample).not.toHaveBeenCalledWith(
      `${ROOT}\\src\\binary.bin`,
      expect.anything(),
      expect.anything(),
    );
  });

  it('requires a matching one-shot lease and cancels a hanging read at expiry', async () => {
    const approvalBroker = broker();
    const deps = dependencies({
      readTextFileSample: vi.fn(
        (_path: string, _maxBytes: number, _options: unknown, _signal?: AbortSignal) =>
          new Promise<never>(() => undefined),
      ),
    });
    const adapter = createBrowserChatFileAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: deps,
    });
    const wrongLease = lease(approvalBroker, 'files.list', 100, 500);
    await expect(
      adapter.read({ lease: wrongLease, path: 'README.md', now: 100 }),
    ).rejects.toMatchObject({ code: 'capability_mismatch' });

    const readLease = lease(approvalBroker, 'files.read', 200, 100);
    const pending = adapter.read({ lease: readLease, path: 'README.md', now: 200 });
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<BrowserChatFileAdapterError>>({
        code: 'operation_cancelled',
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });

  it('normalizes thrown native failures without reflecting private details', async () => {
    const approvalBroker = broker();
    const adapter = createBrowserChatFileAdapter({
      root: ROOT,
      approvalBroker,
      dependencies: dependencies({
        listDirectory: vi.fn(async () => {
          throw new Error('C:\\Users\\viper\\.ssh\\id_ed25519');
        }),
      }),
    });

    const result = adapter.list({
      lease: lease(approvalBroker, 'files.list'),
      path: '.',
      now: 100,
    });
    await expect(result).rejects.toMatchObject({ code: 'native_denied' });
    await expect(result).rejects.not.toThrow(/id_ed25519/u);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { classifyBrowserAction, type BrowserActionAuthorization } from './browserActionApproval';
import {
  browserApprovalKind,
  createPlaywrightBrowserWorker,
  hashPlaywrightBrowserAction,
  type PlaywrightBrowserAction,
  type PlaywrightBrowserHostReceipt,
  type PlaywrightBrowserLease,
  type PlaywrightBrowserScope,
  type PlaywrightIsolatedHostPort,
} from './playwrightBrowserWorker';

const lease: PlaywrightBrowserLease = {
  schemaVersion: 1,
  accountId: 'account-1',
  projectId: 'project-1',
  taskId: 'task-1',
  agentId: 'agent-1',
  purpose: 'Verify the fixture checkout.',
  sessionId: 'session-1',
  contextId: 'context-1',
  profileId: 'isolated-profile-1',
  persistentProfile: false,
  browserName: 'chromium',
  pageIds: ['page-1'],
  activePageId: 'page-1',
  allowedOrigins: ['https://example.com'],
  allowedActions: [
    'observe',
    'navigate',
    'click',
    'fill',
    'open_tab',
    'upload',
    'download',
    'screenshot',
    'pause',
  ],
  authority: { observe: true, action: true, upload: true, download: true },
  uploads: [
    {
      artifactRef: 'jartifact_upload-1',
      sha256: `sha256:${'a'.repeat(64)}`,
      bytes: 10,
    },
  ],
  maxPages: 3,
  issuedAt: 1,
  expiresAt: 1_000,
};

function hostReceipt(action: PlaywrightBrowserAction['name']): PlaywrightBrowserHostReceipt {
  return {
    action,
    pageId: 'page-1',
    url: 'https://example.com/page',
    pageIds: ['page-1'],
    startedAt: 100,
    finishedAt: 150,
    resultRef: `jresult_browser-${action}` as const,
    ...(action === 'observe'
      ? {
          observation: {
            pageId: 'page-1',
            url: 'https://example.com/page',
            title: 'Fixture',
            text: 'Untrusted page text.',
            bytes: 20,
            truncated: false,
          },
        }
      : {}),
  };
}

async function authorized(action: PlaywrightBrowserAction, requestId: string) {
  const actionHash = await hashPlaywrightBrowserAction(action);
  const kind = browserApprovalKind(action);
  const classification = classifyBrowserAction(kind);
  const authorization = {
    requestId,
    accountId: 'account-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    action: kind,
    actionHash,
    classification,
    authority: 'scoped',
    ...(classification.approval === 'explicit' ? { grantId: `grant-${requestId}` } : {}),
  } satisfies BrowserActionAuthorization;
  const scope: PlaywrightBrowserScope = {
    accountId: 'account-1',
    projectId: 'project-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    purpose: 'Verify the fixture checkout.',
    sessionId: 'session-1',
    requestId,
    actionHash,
    now: 100,
    timeoutMs: 5_000,
  };
  return { authorization, scope };
}

function fixture(receipt = hostReceipt('observe')) {
  const port: PlaywrightIsolatedHostPort = {
    resolveLease: vi.fn(async () => lease),
    execute: vi.fn(async () => receipt),
  };
  return { worker: createPlaywrightBrowserWorker(port), port };
}

describe('isolated Playwright browser worker', () => {
  it('executes a typed observation in an ephemeral context and marks page text untrusted', async () => {
    const action = { name: 'observe' } as const;
    const authority = await authorized(action, 'request-observe');
    const { worker, port } = fixture();
    const receipt = await worker.execute({
      ...authority,
      action,
      signal: new AbortController().signal,
    });
    expect(receipt).toMatchObject({
      action: 'observe',
      authority: 'scoped',
      untrustedPageContent: true,
      observation: { text: 'Untrusted page text.', bytes: 20 },
    });
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        lease,
        action,
        contextOptions: {
          acceptDownloads: false,
          javaScriptEnabled: true,
          serviceWorkers: 'block',
          storageState: undefined,
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects cross-origin navigation, forged approval class, and request replay', async () => {
    const action = { name: 'navigate', url: 'https://evil.example/path' } as const;
    const authority = await authorized(action, 'request-nav');
    const { worker, port } = fixture(hostReceipt('navigate'));
    await expect(
      worker.execute({ ...authority, action, signal: new AbortController().signal }),
    ).rejects.toThrow(/origin/i);
    expect(port.execute).not.toHaveBeenCalled();

    const observe = { name: 'observe' } as const;
    const observeAuthority = await authorized(observe, 'request-replay');
    const observeFixture = fixture();
    const forged = {
      ...observeAuthority.authorization,
      classification: { risk: 'high_risk', approval: 'explicit' },
      grantId: 'grant-forged',
    } as BrowserActionAuthorization;
    await expect(
      observeFixture.worker.execute({
        scope: observeAuthority.scope,
        authorization: forged,
        action: observe,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/authorization/i);

    await observeFixture.worker.execute({
      ...observeAuthority,
      action: observe,
      signal: new AbortController().signal,
    });
    await expect(
      observeFixture.worker.execute({
        ...observeAuthority,
        action: observe,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/already claimed/i);

    const rawAction = { name: 'evaluate', script: 'document.cookie' } as never;
    const rawAuthority = await authorized(rawAction, 'request-raw');
    await expect(
      worker.execute({
        ...rawAuthority,
        action: rawAction,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/lease|action/i);
  });

  it('allows only leased uploads and content-addressed quarantined downloads', async () => {
    const upload = {
      name: 'upload',
      target: { kind: 'label', label: 'Attachment', exact: true },
      artifactRef: 'jartifact_upload-1',
    } as const;
    const uploadAuthority = await authorized(upload, 'request-upload');
    const uploadFixture = fixture({
      ...hostReceipt('upload'),
      uploadedArtifactRef: 'jartifact_upload-1',
    });
    await expect(
      uploadFixture.worker.execute({
        ...uploadAuthority,
        action: upload,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ uploadedArtifactRef: 'jartifact_upload-1' });

    const download = {
      name: 'download',
      target: { kind: 'role', role: 'link', name: 'Report', exact: true },
    } as const;
    const downloadAuthority = await authorized(download, 'request-download');
    const safeDownload = fixture({
      ...hostReceipt('download'),
      download: {
        quarantineRef: 'jquarantine_download-1',
        sha256: `sha256:${'b'.repeat(64)}`,
        bytes: 100,
        mimeType: 'application/pdf',
        originalName: 'report.pdf',
        scanState: 'pending',
        availableForUse: false,
      },
    });
    await expect(
      safeDownload.worker.execute({
        ...downloadAuthority,
        action: download,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      download: {
        quarantineRef: 'jquarantine_download-1',
        scanState: 'pending',
        availableForUse: false,
      },
    });
    expect(safeDownload.port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        contextOptions: expect.objectContaining({ acceptDownloads: true }),
      }),
    );

    const falseAuthority = await authorized(download, 'request-false-download');
    const falseDownload = fixture({
      ...hostReceipt('download'),
      download: {
        quarantineRef: 'jquarantine_download-2',
        sha256: `sha256:${'c'.repeat(64)}`,
        bytes: 100,
        mimeType: 'application/pdf',
        originalName: '..',
        scanState: 'clean',
        availableForUse: true,
      },
    });
    await expect(
      falseDownload.worker.execute({
        ...falseAuthority,
        action: download,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/quarantined/i);
  });

  it('rejects oversized observations, unexpected tabs, and cancellation settlement', async () => {
    const action = { name: 'observe' } as const;
    const oversizedAuthority = await authorized(action, 'request-oversized');
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const oversizedFixture = fixture({
      ...hostReceipt('observe'),
      observation: {
        pageId: 'page-1',
        url: 'https://example.com/page',
        title: 'Fixture',
        text: oversized,
        bytes: oversized.length,
        truncated: true,
      },
    });
    await expect(
      oversizedFixture.worker.execute({
        ...oversizedAuthority,
        action,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/bound/i);

    const tabAuthority = await authorized(action, 'request-tab');
    const tabFixture = fixture({
      ...hostReceipt('observe'),
      pageIds: ['page-1', 'page-unleased'],
    });
    await expect(
      tabFixture.worker.execute({
        ...tabAuthority,
        action,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/evidence/i);

    const cancelledAuthority = await authorized(action, 'request-cancelled');
    const controller = new AbortController();
    controller.abort();
    const cancelledFixture = fixture();
    await expect(
      cancelledFixture.worker.execute({
        ...cancelledAuthority,
        action,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(cancelledFixture.port.execute).not.toHaveBeenCalled();
  });

  it('aborts a host that does not settle within the approved timeout', async () => {
    vi.useFakeTimers();
    try {
      const action = { name: 'observe' } as const;
      const authority = await authorized(action, 'request-timeout');
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const port: PlaywrightIsolatedHostPort = {
        resolveLease: vi.fn(async () => lease),
        execute: vi.fn(
          async () => {
            markStarted?.();
            return new Promise<never>(() => {
              // The isolated host intentionally never settles in this fixture.
            });
          },
        ),
      };
      const pending = createPlaywrightBrowserWorker(port).execute({
        ...authority,
        scope: { ...authority.scope, timeoutMs: 100 },
        action,
        signal: new AbortController().signal,
      });
      await started;
      expect(port.execute).toHaveBeenCalledTimes(1);
      const rejection = expect(pending).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      expect(port.execute).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

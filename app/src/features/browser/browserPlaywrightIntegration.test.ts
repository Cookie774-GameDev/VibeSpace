import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
  createJarvisActionCatalog,
} from '@/lib/jarvis/actions/catalog';
import { classifyBrowserAction } from '@/lib/jarvis/browserActionApproval';
import { hashJarvisText } from '@/lib/jarvis/identity';
import {
  hashPlaywrightBrowserAction,
  type PlaywrightBrowserHostReceipt,
  type PlaywrightBrowserLease,
  type PlaywrightBrowserScope,
  type PlaywrightIsolatedHostPort,
} from '@/lib/jarvis/playwrightBrowserWorker';
import { canonicalizeBrowserJson } from './browserActions';
import {
  dispatchCanonicalBrowserGoalAction,
  registerBrowserGoalHostSession,
  registerBrowserGoalPlaywrightHost,
  revokeBrowserGoalHostSession,
  revokeBrowserGoalPlaywrightHost,
  selectedBrowserGoalHostSource,
} from './browserGoalIntegration';

vi.mock('@/lib/jarvis/untrustedContentPolicy', () => ({
  evaluateUntrustedContent: vi.fn(async ({ source }: { source: string }) => ({
    schemaVersion: 1,
    source,
    authority: 'none',
    contentRef: `untrusted:${source}:sha256:playwright-content`,
    observedChars: 14,
    truncated: false,
    safeSummary: 'Returned content is available as untrusted data only.',
    disposition: 'data_only',
  })),
}));

const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
const reviewedHash = 'b'.repeat(64);
const context = {
  source: 'ai',
  accountId: 'account-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
  approvalId: 'approval-1',
} as const;

function execution(signal = new AbortController().signal) {
  const beginExternalEffect = vi.fn((begin) => ({
    kind: 'committed',
    value: begin(signal),
  }));
  const recordResult = vi.fn(async () => ({
    kind: 'committed',
    value: { proofRef: 'jlive_playwright-proof' },
  }));
  return {
    value: {
      approval: {
        runId: 'run-1',
        requestId: 'request-1',
        attemptNumber: 1,
        capabilityId: 'browser.operator',
        actionId: 'browser.readPage',
        actionVersion: 1,
        paramsHash: `sha256:${'c'.repeat(64)}`,
        status: 'consumed',
      },
      producerKind: 'action',
      initialLiveProof: {
        accountId: 'account-1',
        runId: 'run-1',
        requestId: 'request-1',
        attemptNumber: 1,
      },
      beginExternalEffect,
      recordResult,
    } as never,
    beginExternalEffect,
    recordResult,
  };
}

async function approvedParams() {
  const parametersHash = await hashJarvisText(canonicalizeBrowserJson({}));
  return {
    schemaVersion: 1,
    reviewId: 'review-1',
    origin: 'https://example.test',
    tabId: 'page-1',
    frameId: null,
    target: { currentUrl: 'https://example.test/start' },
    parameters: {},
    parametersHash,
    reviewedHash,
    expectedEffect: 'Read the reviewed page.',
    reviewedRisk: 'safe',
    capability: { id: 'browser.operator', operation: 'browser.readPage' },
  } as const;
}

async function registerPlaywright(
  overrides: Partial<Parameters<PlaywrightIsolatedHostPort['resolveLease']>[0]> = {},
) {
  const action = { name: 'observe' } as const;
  const actionHash = await hashPlaywrightBrowserAction(action);
  const parametersHash = await hashJarvisText(canonicalizeBrowserJson({}));
  const port: PlaywrightIsolatedHostPort = {
    resolveLease: vi.fn(async (scope: PlaywrightBrowserScope & Readonly<{ signal: AbortSignal }>): Promise<PlaywrightBrowserLease> => ({
      schemaVersion: 1,
      accountId: overrides.accountId ?? scope.accountId,
      projectId: overrides.projectId ?? scope.projectId,
      taskId: scope.taskId,
      agentId: scope.agentId,
      purpose: scope.purpose,
      sessionId: scope.sessionId,
      contextId: 'context-1',
      profileId: 'isolated-profile-1',
      persistentProfile: false,
      browserName: 'chromium',
      pageIds: ['page-1'],
      activePageId: 'page-1',
      allowedOrigins: ['https://example.test'],
      allowedActions: ['observe'],
      authority: { observe: true, action: false, upload: false, download: false },
      uploads: [],
      maxPages: 2,
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    })),
    execute: vi.fn(async (): Promise<PlaywrightBrowserHostReceipt> => ({
      action: 'observe',
      pageId: 'page-1',
      url: 'https://example.test/after',
      pageIds: ['page-1'],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      resultRef: 'jresult_playwright-live-1',
      observation: {
        pageId: 'page-1',
        url: 'https://example.test/after',
        title: 'Example',
        text: 'External text.',
        bytes: 14,
        truncated: false,
      },
    })),
  };
  const lease = await registerBrowserGoalPlaywrightHost({
    scope: {
      accountId: 'account-1',
      projectId: 'project-1',
      runId: 'run-1',
      sessionId: 'session-1',
      tabId: 'page-1',
      origin: 'https://example.test',
      taskId: 'task-1',
      agentId: 'agent-1',
      purpose: 'Read the reviewed fixture page.',
      issuedAt: Date.now() - 1,
      expiresAt: Date.now() + 60_000,
    },
    port,
    bindings: [
      {
        requestId: 'request-1',
        attemptNumber: 1,
        operation: 'browser.readPage',
        parametersHash,
        reviewedHash,
        action,
        authorization: {
          requestId: 'request-1',
          accountId: 'account-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          action: 'read',
          actionHash,
          classification: classifyBrowserAction('read'),
          authority: 'scoped',
        },
        timeoutMs: 5_000,
      },
    ],
  });
  return { lease, port };
}

describe('live Playwright browser integration', () => {
  beforeEach(() => {
    revokeBrowserGoalPlaywrightHost();
    revokeBrowserGoalHostSession();
  });

  it('routes an exact reviewed action through the typed worker and canonical evidence path', async () => {
    const { port } = await registerPlaywright();
    const issued = execution();
    const result = await dispatchCanonicalBrowserGoalAction({
      registration: catalog.resolve('browser.readPage')!,
      params: await approvedParams(),
      context,
      execution: issued.value,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        hostSource: 'playwright',
        sessionId: 'session-1',
        tabId: 'page-1',
        outcome: {
          resultRef: 'jresult_playwright-live-1',
          evidenceRef: 'jlive_playwright-proof',
        },
        receipt: {
          action: 'observe',
          untrustedPageContent: true,
        },
      },
    });
    expect(port.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: 'observe' },
        contextOptions: expect.objectContaining({ storageState: undefined }),
      }),
    );
    expect(issued.beginExternalEffect).toHaveBeenCalledTimes(1);
    expect(issued.recordResult).toHaveBeenCalledTimes(1);
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: catalog.resolve('browser.readPage')!,
        params: await approvedParams(),
        context,
        execution: execution().value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Playwright action binding has already been claimed.',
    });
    expect(port.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects project lease drift and reviewed-hash drift before canonical settlement', async () => {
    const drifted = await registerPlaywright({ projectId: 'project-other' });
    const projectExecution = execution();
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: catalog.resolve('browser.readPage')!,
        params: await approvedParams(),
        context,
        execution: projectExecution.value,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(drifted.port.execute).not.toHaveBeenCalled();
    expect(projectExecution.recordResult).not.toHaveBeenCalled();

    const exact = await registerPlaywright();
    const hashExecution = execution();
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: catalog.resolve('browser.readPage')!,
        params: { ...(await approvedParams()), reviewedHash: 'd'.repeat(64) },
        context,
        execution: hashExecution.value,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('scope') });
    expect(exact.port.execute).not.toHaveBeenCalled();
    expect(hashExecution.beginExternalEffect).not.toHaveBeenCalled();
  });

  it('never falls back to an existing CDP host after explicit Playwright revocation', async () => {
    const cdp = {
      evaluate: vi.fn(),
      navigate: vi.fn(),
      inputClick: vi.fn(),
      inputType: vi.fn(),
    };
    registerBrowserGoalHostSession({
      scope: {
        accountId: 'account-1',
        sessionId: 'cdp-session',
        tabId: 'page-1',
        origin: 'https://example.test',
        purpose: 'browser_goal',
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 60_000,
      },
      cdp,
    });
    const { lease } = await registerPlaywright();
    expect(selectedBrowserGoalHostSource()).toBe('playwright');
    lease.revoke();
    expect(selectedBrowserGoalHostSource()).toBeNull();
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: catalog.resolve('browser.readPage')!,
        params: await approvedParams(),
        context,
        execution: execution().value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'An explicit browser host source registration is required.',
    });
    expect(cdp.evaluate).not.toHaveBeenCalled();
  });

  it('fails closed on cancellation without recording or retrying another host', async () => {
    const { port } = await registerPlaywright();
    const controller = new AbortController();
    controller.abort();
    const issued = execution(controller.signal);
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: catalog.resolve('browser.readPage')!,
        params: await approvedParams(),
        context,
        execution: issued.value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Playwright browser operation was cancelled before verified settlement.',
    });
    expect(port.execute).not.toHaveBeenCalled();
    expect(issued.recordResult).not.toHaveBeenCalled();
  });

  it('rejects bindings whose action is not the reviewed canonical operation', async () => {
    const action = { name: 'navigate', url: 'https://example.test/other' } as const;
    const actionHash = await hashPlaywrightBrowserAction(action);
    const parametersHash = await hashJarvisText(canonicalizeBrowserJson({}));
    await expect(
      registerBrowserGoalPlaywrightHost({
        scope: {
          accountId: 'account-1',
          projectId: 'project-1',
          runId: 'run-1',
          sessionId: 'session-1',
          tabId: 'page-1',
          origin: 'https://example.test',
          taskId: 'task-1',
          agentId: 'agent-1',
          purpose: 'Read fixture.',
          issuedAt: 1,
          expiresAt: 2,
        },
        port: {} as PlaywrightIsolatedHostPort,
        bindings: [
          {
            requestId: 'request-1',
            attemptNumber: 1,
            operation: 'browser.readPage',
            parametersHash,
            reviewedHash,
            action,
            authorization: {
              requestId: 'request-1',
              accountId: 'account-1',
              projectId: 'project-1',
              sessionId: 'session-1',
              action: 'navigate',
              actionHash,
              classification: classifyBrowserAction('navigate'),
              authority: 'scoped',
            },
            timeoutMs: 1_000,
          },
        ],
      }),
    ).rejects.toThrow(/binding/i);
  });
});

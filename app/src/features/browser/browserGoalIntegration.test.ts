import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
  createJarvisActionCatalog,
} from '@/lib/jarvis/actions/catalog';
import { hashJarvisText } from '@/lib/jarvis/identity';
import { canonicalizeBrowserJson } from './browserActions';
import {
  dispatchCanonicalBrowserGoalAction,
  registerBrowserGoalHostSession,
  revokeBrowserGoalPlaywrightHost,
  revokeBrowserGoalHostSession,
} from './browserGoalIntegration';

vi.mock('@/lib/jarvis/untrustedContentPolicy', () => ({
  evaluateUntrustedContent: vi.fn(async ({ source }: { source: string }) =>
    Object.freeze({
      schemaVersion: 1,
      source,
      authority: 'none',
      contentRef: `untrusted:${source}:sha256:browser-content`,
      observedChars: 18,
      truncated: false,
      safeSummary: 'Returned content is available as untrusted data only.',
      disposition: 'data_only',
    }),
  ),
}));

const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);

async function approvedParams(
  operation: 'browser.readPage' | 'browser.navigate' | 'browser.click' | 'browser.type',
  parameters: Record<string, string | number> = {},
) {
  return {
    schemaVersion: 1,
    reviewId: 'review-1',
    origin: 'https://example.test',
    tabId: 'tab-1',
    frameId: null,
    target: { currentUrl: 'https://example.test/start' },
    parameters,
    parametersHash: await hashJarvisText(canonicalizeBrowserJson(parameters)),
    reviewedHash: 'reviewed-hash',
    expectedEffect: 'Perform the reviewed browser operation.',
    reviewedRisk: operation === 'browser.readPage' ? 'safe' : 'confirm',
    capability: { id: 'browser.operator', operation },
  } as const;
}

function execution(
  operation: string,
  options: { signal?: AbortSignal; parameterHash?: string } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const beginExternalEffect = vi.fn((begin) => ({
    kind: 'committed' as const,
    value: begin(signal),
  }));
  const recordResult = vi.fn(async () => ({
    kind: 'committed' as const,
    value: { proofRef: 'jlive_browser-proof' },
  }));
  return {
    value: {
      approval: {
        runId: 'run-1',
        requestId: 'request-1',
        attemptNumber: 1,
        capabilityId: 'browser.operator',
        actionId: operation,
        actionVersion: 1,
        paramsHash: options.parameterHash ?? `sha256:${'a'.repeat(64)}`,
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

const context = {
  source: 'ai',
  accountId: 'account-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
  approvalId: 'approval-1',
} as const;

function host() {
  return {
    evaluate: vi.fn(async () => ({
      result: {
        value: {
          url: 'https://example.test/after',
          title: 'Example',
          text: 'External page text',
        },
      },
    })),
    navigate: vi.fn(async () => ({})),
    inputClick: vi.fn(async () => undefined),
    inputType: vi.fn(async () => undefined),
  };
}

function registerHost(cdp = host()) {
  return {
    cdp,
    lease: registerBrowserGoalHostSession({
      scope: {
        accountId: 'account-1',
        sessionId: 'isolated-session-1',
        tabId: 'tab-1',
        origin: 'https://example.test',
        purpose: 'browser_goal',
        issuedAt: Date.now() - 1,
        expiresAt: Date.now() + 60_000,
      },
      cdp,
    }),
  };
}

describe('live browser goal integration', () => {
  beforeEach(() => {
    revokeBrowserGoalPlaywrightHost();
    revokeBrowserGoalHostSession();
  });

  it('fails closed when no live Vibe Browser host is registered', async () => {
    const registration = catalog.resolve('browser.navigate')!;
    const issued = execution(registration.id);
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params: await approvedParams('browser.navigate', {
          url: 'https://example.test/after',
        }),
        context,
        execution: issued.value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'An explicit browser host source registration is required.',
    });
    expect(issued.beginExternalEffect).not.toHaveBeenCalled();
  });

  it('binds account, run, attempt, tab, origin, operation, and reviewed parameter hash', async () => {
    const { cdp } = registerHost();
    const registration = catalog.resolve('browser.click')!;
    const issued = execution(registration.id);
    const params = await approvedParams('browser.click', { x: 10, y: 20 });

    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params: { ...params, tabId: 'other-tab' },
        context,
        execution: issued.value,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('scope') });
    expect(cdp.inputClick).not.toHaveBeenCalled();

    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params,
        context: { ...context, attemptNumber: 2 },
        execution: execution(registration.id).value,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('scope') });
    expect(cdp.inputClick).not.toHaveBeenCalled();

    const altered = { ...params, parameters: { x: 11, y: 20 } };
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params: altered,
        context,
        execution: execution(registration.id).value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Browser parameters do not match the reviewed hash.',
    });
    expect(cdp.inputClick).not.toHaveBeenCalled();

    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration: { ...registration, version: 2 },
        params,
        context,
        execution: execution(registration.id).value,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('failed before verified settlement'),
    });
    expect(cdp.inputClick).not.toHaveBeenCalled();
  });

  it('executes one fixed operation, labels returned DOM as untrusted, and rejects replay', async () => {
    const { cdp } = registerHost();
    const registration = catalog.resolve('browser.navigate')!;
    const issued = execution(registration.id);
    const input = {
      registration,
      params: await approvedParams('browser.navigate', {
        url: 'https://example.test/after',
      }),
      context,
      execution: issued.value,
    };

    const result = await dispatchCanonicalBrowserGoalAction(input);
    expect(result).toMatchObject({
      ok: true,
      data: {
        outcome: { evidenceRef: 'jlive_browser-proof' },
        contentReceipt: {
          source: 'browser_dom',
          authority: 'none',
          disposition: 'data_only',
        },
        sessionId: 'isolated-session-1',
        tabId: 'tab-1',
      },
    });
    expect(cdp.navigate).toHaveBeenCalledWith('https://example.test/after');
    expect(cdp.evaluate).toHaveBeenCalledWith(expect.stringContaining('document.body'));
    expect(issued.recordResult).toHaveBeenCalledOnce();

    await expect(dispatchCanonicalBrowserGoalAction(input)).resolves.toEqual({
      ok: false,
      error: 'Canonical browser execution has already been claimed.',
    });
    expect(cdp.navigate).toHaveBeenCalledOnce();
  });

  it('propagates cancellation and exposes no raw evaluate action', async () => {
    registerHost();
    const controller = new AbortController();
    controller.abort();
    const registration = catalog.resolve('browser.type')!;
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params: await approvedParams('browser.type', { text: 'bounded text' }),
        context,
        execution: execution(registration.id, { signal: controller.signal }).value,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Browser operation was cancelled before verified settlement.',
    });

    expect(catalog.resolve('browser.evaluate')).toBeUndefined();
    expect(catalog.resolve('browser.runJs')).toBeUndefined();
  });

  it('revocation removes host authority immediately', async () => {
    const { lease } = registerHost();
    lease.revoke();
    const registration = catalog.resolve('browser.readPage')!;
    await expect(
      dispatchCanonicalBrowserGoalAction({
        registration,
        params: await approvedParams('browser.readPage'),
        context,
        execution: execution(registration.id).value,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/explicit|live scoped/i),
    });
  });
});

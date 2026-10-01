import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionRunContext } from '@/lib/actions/types';
import type { JarvisRun } from '@/lib/jarvis/contracts';
import type { JarvisKernelActionPort } from '@/lib/jarvis/approvalEngine';
import type { JarvisRequestAttempt } from '@/lib/jarvis/requestEnvelope';
import { useAuthStore } from '@/stores/auth';
import { requestBrowserTool } from './browserActions';
import {
  approveBrowserCanonicalReviewedAction,
  createBrowserCanonicalApprovalRuntime,
  type BrowserCanonicalApprovalAuthority,
} from './browserCanonicalApprovalRuntime';
import type { BrowserApprovalParentReference } from './browserApprovalAdapter';
import { useBrowserStore } from './browserStore';

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function setBrowser() {
  useBrowserStore.setState((state) => ({
    ...state,
    tabs: [
      {
        id: 'tab-1',
        url: 'https://example.test/start',
        title: 'Start',
        loading: false,
        pinned: false,
        muted: false,
        controlMode: 'ask_every_action',
      },
    ],
    activeTabId: 'tab-1',
    agentActions: [],
  }));
}

function actionPort(options: { safe?: boolean; cancel?: boolean } = {}) {
  const approval = {
    id: 'jappr_1',
    runId: 'run-1',
    status: 'pending',
  };
  const create = vi.fn<JarvisKernelActionPort['create']>(async () => ({
    kind: 'committed',
    value: approval,
  }) as never);
  const decide = vi.fn<JarvisKernelActionPort['decide']>(async () => ({
    kind: 'committed',
    value: { ...approval, status: 'approved' },
  }) as never);
  const execute = vi.fn<JarvisKernelActionPort['execute']>(async () => {
    if (options.cancel) throw new DOMException('cancelled', 'AbortError');
    return {
      kind: 'committed',
      value: { kind: 'settled', result: { ok: true, summary: 'observed' } },
    } as never;
  });
  const executeAutoApprovedSafe = vi.fn<JarvisKernelActionPort['executeAutoApprovedSafe']>(
    async () =>
      ({
        kind: 'committed',
        value: { kind: 'settled', result: { ok: true, summary: 'observed' } },
      }) as never,
  );
  return {
    create,
    decide,
    execute,
    executeAutoApprovedSafe,
    authority: Object.freeze({ create, decide, execute, executeAutoApprovedSafe }),
  };
}

function parent(actionId: string): BrowserApprovalParentReference {
  const parentRun = deepFreeze({
    id: 'run-1',
    accountId: 'account-a',
    agentId: 'agent-1',
  } as unknown as JarvisRun);
  const attempt = deepFreeze({
    kind: 'initial',
    requestId: 'request-1',
    runId: 'run-1',
    attemptNumber: 1,
  } satisfies JarvisRequestAttempt);
  const context = deepFreeze({
    source: 'ai',
    accountId: 'account-a',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 1,
    callId: actionId,
  } satisfies ActionRunContext);
  return deepFreeze({
    parentRun,
    attempt,
    context,
    controlMode: 'ask_every_action',
  });
}

async function reviewed(tool = 'browser.click') {
  await requestBrowserTool(
    {
      tool,
      params: tool === 'browser.click' ? { x: 10, y: 20 } : {},
      requester: {
        kind: 'agent',
        agent: { id: 'agent-1' as never, slug: 'jarvis', builtin: true },
        runId: 'run-1',
      },
    },
    null,
  );
  return useBrowserStore.getState().agentActions[0]!;
}

function authority(
  actionId: string,
  actions: ReturnType<typeof actionPort>['authority'],
): BrowserCanonicalApprovalAuthority {
  return Object.freeze({ parent: parent(actionId), actions });
}

describe('browser canonical approval runtime', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ localUserId: 'account-a', cloudSession: null });
    setBrowser();
  });

  it('captures the actual producer call identity when the reviewed record is created', async () => {
    const port = actionPort();
    const producerAuthority = authority('browser-call-1', port.authority);

    await requestBrowserTool(
      {
        tool: 'browser.click',
        params: { x: 10, y: 20 },
        requester: {
          kind: 'agent',
          agent: { id: 'agent-1' as never, slug: 'jarvis', builtin: true },
          runId: 'run-1',
        },
      },
      null,
      producerAuthority,
    );

    expect(useBrowserStore.getState().agentActions[0]?.id).toBe('browser-call-1');
    await expect(approveBrowserCanonicalReviewedAction('browser-call-1')).resolves.toMatchObject({
      ok: true,
      status: 'completed',
    });
    expect(port.execute).toHaveBeenCalledOnce();
  });

  it('creates, explicitly approves, executes, observes, and settles one exact reviewed action', async () => {
    const action = await reviewed();
    const port = actionPort();
    const runtime = createBrowserCanonicalApprovalRuntime({
      activeAccountId: () => 'account-a',
      now: () => action.requestedAt + 1,
    });
    runtime.register(action.id, authority(action.id, port.authority));

    const first = runtime.approve(action.id);
    const replay = runtime.approve(action.id);
    expect(replay).toBe(first);
    await expect(first).resolves.toMatchObject({ ok: true, status: 'completed' });
    expect(port.create).toHaveBeenCalledOnce();
    expect(port.decide).toHaveBeenCalledWith({
      parentRun: expect.objectContaining({ id: 'run-1' }),
      approvalId: 'jappr_1',
      decision: 'approve',
    });
    expect(port.execute).toHaveBeenCalledOnce();
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'completed',
      result: 'Approved browser operation completed and was observed.',
    });
    await expect(runtime.approve(action.id)).resolves.toMatchObject({ status: 'unavailable' });
    expect(port.execute).toHaveBeenCalledOnce();
  });

  it('auto-executes only catalog-safe reviewed work through the issued safe lifecycle', async () => {
    const action = await reviewed('browser.readPage');
    const port = actionPort({ safe: true });
    const runtime = createBrowserCanonicalApprovalRuntime({
      activeAccountId: () => 'account-a',
      now: () => action.requestedAt + 1,
    });
    runtime.register(action.id, authority(action.id, port.authority));

    await expect(runtime.approve(action.id)).resolves.toMatchObject({
      ok: true,
      status: 'completed',
    });
    expect(port.executeAutoApprovedSafe).toHaveBeenCalledOnce();
    expect(port.create).not.toHaveBeenCalled();
    expect(port.decide).not.toHaveBeenCalled();
  });

  it('fails closed before canonical creation when live tab scope changed', async () => {
    const action = await reviewed();
    const port = actionPort();
    const runtime = createBrowserCanonicalApprovalRuntime({
      activeAccountId: () => 'account-a',
      now: () => action.requestedAt + 1,
    });
    runtime.register(action.id, authority(action.id, port.authority));
    useBrowserStore.getState().updateTab('tab-1', { url: 'https://other.test/' });

    await expect(runtime.approve(action.id)).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.execute).not.toHaveBeenCalled();
  });

  it('records cancellation without claiming successful settlement', async () => {
    const action = await reviewed();
    const port = actionPort({ cancel: true });
    const runtime = createBrowserCanonicalApprovalRuntime({
      activeAccountId: () => 'account-a',
      now: () => action.requestedAt + 1,
    });
    runtime.register(action.id, authority(action.id, port.authority));

    await expect(runtime.approve(action.id)).resolves.toMatchObject({
      ok: false,
      status: 'cancelled',
    });
    expect(useBrowserStore.getState().agentActions[0]?.status).toBe('cancelled');
  });

  it('denies locally before creating any canonical approval', async () => {
    const action = await reviewed();
    const port = actionPort();
    const runtime = createBrowserCanonicalApprovalRuntime();
    runtime.register(action.id, authority(action.id, port.authority));

    expect(runtime.deny(action.id)).toMatchObject({ ok: false, status: 'denied' });
    expect(useBrowserStore.getState().agentActions[0]?.status).toBe('denied');
    expect(port.create).not.toHaveBeenCalled();
    expect(port.execute).not.toHaveBeenCalled();
  });
});

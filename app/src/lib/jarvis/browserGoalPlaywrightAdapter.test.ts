import { describe, expect, it, vi } from 'vitest';
import { createBrowserGoalPlaywrightAdapter } from './browserGoalPlaywrightAdapter';
import type { NativeCapabilityRequest } from './nativeCapabilityBroker';
import type {
  PlaywrightBrowserReceipt,
  PlaywrightBrowserWorker,
} from './playwrightBrowserWorker';

const actionHash = `sha256:${'a'.repeat(64)}` as const;
const receipt: PlaywrightBrowserReceipt = Object.freeze({
  action: 'observe',
  pageId: 'page-1',
  url: 'https://example.com',
  pageIds: Object.freeze(['page-1']),
  startedAt: 100,
  finishedAt: 150,
  resultRef: 'jresult_playwright-1',
  observation: Object.freeze({
    pageId: 'page-1',
    url: 'https://example.com',
    title: 'Fixture',
    text: 'Untrusted fixture text.',
    bytes: 23,
    truncated: false,
  }),
  actionHash,
  authority: 'scoped',
  untrustedPageContent: true,
});

const request: NativeCapabilityRequest = {
  capabilityId: 'browser.playwright',
  capabilityVersion: 1,
  kind: 'browser',
  operation: 'browser.snapshot',
  accountId: 'account-1',
  runId: 'run-1',
  requestId: 'request-1',
  attemptNumber: 1,
  workspaceRoot: 'C:\\workspace',
  parameterHash: actionHash,
};

function fixture() {
  const worker: PlaywrightBrowserWorker = {
    execute: vi.fn(async () => receipt),
  };
  const envelope = {
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    workspaceRoot: 'C:\\workspace',
    scope: {
      accountId: 'account-1',
      projectId: 'project-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      purpose: 'Inspect fixture.',
      sessionId: 'session-1',
      requestId: 'request-1',
      actionHash,
      now: 100,
      timeoutMs: 5_000,
    },
    action: { name: 'observe' as const },
    authorization: {
      requestId: 'request-1',
      accountId: 'account-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      action: 'read' as const,
      actionHash,
      classification: { risk: 'read_navigation' as const, approval: 'none' as const },
      authority: 'scoped' as const,
    },
  };
  const catalog = { resolve: vi.fn(async () => envelope) };
  return {
    adapter: createBrowserGoalPlaywrightAdapter({ worker, catalog }),
    worker,
    catalog,
    envelope,
  };
}

describe('Browser Goal Playwright adapter', () => {
  it('maps an exact native request to one typed worker action and retains its receipt', async () => {
    const { adapter, worker, catalog } = fixture();
    const signal = new AbortController().signal;
    const result = await adapter.nativeAdapter.execute({ request, signal });
    expect(catalog.resolve).toHaveBeenCalledWith(request);
    expect(worker.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: 'observe' },
        signal,
      }),
    );
    expect(result).toEqual({ state: 'completed', resultRef: 'jresult_playwright-1' });
    expect(adapter.receipt('jresult_playwright-1')).toBe(receipt);
  });

  it('rejects operation, run, workspace, and action-hash drift before worker execution', async () => {
    for (const mutation of [
      { operation: 'browser.navigate' },
      { runId: 'run-other' },
      { workspaceRoot: 'C:\\other' },
      { parameterHash: `sha256:${'b'.repeat(64)}` },
    ]) {
      const { adapter, worker } = fixture();
      await expect(
        adapter.nativeAdapter.execute({
          request: { ...request, ...mutation },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/does not match/i);
      expect(worker.execute).not.toHaveBeenCalled();
    }
  });

  it('does not retain a mismatched or cancelled worker receipt', async () => {
    const mismatched = fixture();
    vi.mocked(mismatched.worker.execute).mockResolvedValueOnce({
      ...receipt,
      actionHash: `sha256:${'c'.repeat(64)}`,
      resultRef: 'jresult_mismatch',
    });
    await expect(
      mismatched.adapter.nativeAdapter.execute({
        request,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/mismatched/i);
    expect(mismatched.adapter.receipt('jresult_mismatch')).toBeUndefined();

    const cancelled = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.adapter.nativeAdapter.execute({ request, signal: controller.signal }),
    ).rejects.toThrow(/does not match/i);
    expect(cancelled.worker.execute).not.toHaveBeenCalled();
  });
});

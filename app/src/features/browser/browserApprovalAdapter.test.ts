import { describe, expect, it, vi } from 'vitest';

import type { ActionRunContext } from '@/lib/actions/types';
import type { JarvisRun } from '@/lib/jarvis/contracts/execution';
import type { JarvisKernelActionPort } from '@/lib/jarvis/approvalEngine';
import type { JarvisRequestAttempt } from '@/lib/jarvis/requestEnvelope';
import type { BrowserActionRisk, BrowserControlMode, BrowserReviewedAction } from './browserTypes';
import {
  BROWSER_OPERATOR_CAPABILITY_ID,
  BrowserApprovalAdapterError,
  createBrowserApprovalAdapter,
  type BrowserApprovalParentReference,
} from './browserApprovalAdapter';

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function reviewedAction(
  patch: Partial<BrowserReviewedAction> = {},
): Readonly<BrowserReviewedAction> {
  return deepFreeze({
    id: 'browser-action-1',
    accountId: 'acct_1',
    requester: {
      kind: 'agent' as const,
      agent: { id: 'agent_1' as never, slug: 'jarvis', builtin: true },
      runId: 'jrun_1',
    },
    kind: 'browser.readPage',
    actionVersion: 1 as const,
    origin: 'https://example.test',
    tabId: 'tab_1',
    frameId: 'frame_1',
    target: {
      currentUrl: 'https://example.test/page',
      selector: '#article',
      coordinates: { x: 12, y: 24 },
    },
    parameters: { selector: '#article', options: { visible: true } },
    parametersHash: 'params_hash_1',
    reviewedHash: 'reviewed_hash_1',
    expectedEffect: 'Inspect the active page.',
    risk: 'safe' as const,
    safeSummary: 'JARVIS requested browser readPage; safe review required.',
    status: 'pending' as const,
    requestedAt: 1_000,
    expiresAt: 301_000,
    ...patch,
  } satisfies BrowserReviewedAction);
}

function parentReference(
  patch: Partial<BrowserApprovalParentReference> = {},
): BrowserApprovalParentReference {
  const parentRun = deepFreeze({
    id: 'jrun_1',
    accountId: 'acct_1',
    source: 'typed_chat',
    status: 'running',
    agentId: 'agent_1',
    identityVersion: 1,
    profileRevisionId: 'profile_1',
    model: {},
    createdAt: 900,
    updatedAt: 1_000,
  } as JarvisRun);
  const attempt = deepFreeze({
    kind: 'initial',
    requestId: 'jreq_1',
    runId: 'jrun_1',
    attemptNumber: 1,
  } satisfies JarvisRequestAttempt);
  const context = deepFreeze({
    source: 'ai',
    accountId: 'acct_1',
    runId: 'jrun_1',
    requestId: 'jreq_1',
    attemptNumber: 1,
    callId: 'browser-action-1',
  } satisfies ActionRunContext);
  return deepFreeze({
    parentRun,
    attempt,
    context,
    controlMode: 'allow_safe_session' as BrowserControlMode,
    ...patch,
  });
}

function actionPort() {
  const create = vi.fn<JarvisKernelActionPort['create']>(async () => ({
    kind: 'account_authority_revoked',
  }));
  const executeAutoApprovedSafe = vi.fn<JarvisKernelActionPort['executeAutoApprovedSafe']>(
    async () => ({ kind: 'account_authority_revoked' }),
  );
  return {
    create,
    executeAutoApprovedSafe,
    narrow: Object.freeze({ create, executeAutoApprovedSafe }),
  };
}

const SECRET_SHAPED_PATCHES: readonly Partial<BrowserReviewedAction>[] = [
  { parameters: { password: 'synthetic-value' } },
  { parameters: { note: 'Authorization: Bearer synthetic-value-12345678' } },
  { parameters: { nested: { credentialHandleId: 'handle_synthetic' } } },
  { expectedEffect: 'Authorization: Bearer synthetic-value-12345678' },
];

const TASK_6_ALLOWED_BROWSER_OPERATIONS = [
  ['browser.open', 'confirm'],
  ['browser.newTab', 'safe'],
  ['browser.closeTab', 'safe'],
  ['browser.navigate', 'confirm'],
  ['browser.back', 'safe'],
  ['browser.forward', 'safe'],
  ['browser.reload', 'safe'],
  ['browser.wait', 'safe'],
  ['browser.inspect', 'safe'],
  ['browser.readPage', 'safe'],
  ['browser.findText', 'safe'],
  ['browser.click', 'confirm'],
  ['browser.type', 'confirm'],
  ['browser.press', 'confirm'],
  ['browser.select', 'confirm'],
  ['browser.check', 'confirm'],
  ['browser.uncheck', 'confirm'],
  ['browser.upload', 'confirm'],
  ['browser.download', 'confirm'],
  ['browser.scroll', 'safe'],
  ['browser.screenshot', 'safe'],
  ['browser.getConsoleErrors', 'safe'],
  ['browser.getCurrentUrl', 'safe'],
  ['browser.listTabs', 'safe'],
  ['browser.switchTab', 'safe'],
  ['browser.submit', 'dangerous'],
  ['browser.delete', 'dangerous'],
  ['browser.purchase', 'dangerous'],
  ['browser.pay', 'dangerous'],
  ['browser.login', 'dangerous'],
  ['browser.signIn', 'dangerous'],
  ['browser.checkout', 'dangerous'],
  ['browser.stop', 'safe'],
] as const satisfies readonly (readonly [string, BrowserActionRisk])[];

describe('createBrowserApprovalAdapter', () => {
  it('constructs without executing and rejects broader dependency surfaces', () => {
    const port = actionPort();

    createBrowserApprovalAdapter({ actions: port.narrow });

    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
    expect(() => createBrowserApprovalAdapter({ actions: port.narrow, cdp: {} } as never)).toThrow(
      BrowserApprovalAdapterError,
    );
    expect(() =>
      createBrowserApprovalAdapter({
        actions: { ...port.narrow, execute: vi.fn() },
      } as never),
    ).toThrow(BrowserApprovalAdapterError);
  });

  it('rejects inherited dependency getters without invoking them', () => {
    const inheritedCreate = vi.fn<JarvisKernelActionPort['create']>(async () => ({
      kind: 'account_authority_revoked',
    }));
    const inheritedExecute = vi.fn<JarvisKernelActionPort['executeAutoApprovedSafe']>(async () => ({
      kind: 'account_authority_revoked',
    }));
    const createGetter = vi.fn(() => inheritedCreate);
    const executeGetter = vi.fn(() => inheritedExecute);
    const prototype = Object.create(null) as object;
    Object.defineProperties(prototype, {
      create: { enumerable: true, get: createGetter },
      executeAutoApprovedSafe: { enumerable: true, get: executeGetter },
    });
    const inheritedActions = Object.freeze(Object.create(prototype)) as never;

    expect(() => createBrowserApprovalAdapter({ actions: inheritedActions })).toThrow(
      BrowserApprovalAdapterError,
    );
    expect(createGetter).not.toHaveBeenCalled();
    expect(executeGetter).not.toHaveBeenCalled();
    expect(inheritedCreate).not.toHaveBeenCalled();
    expect(inheritedExecute).not.toHaveBeenCalled();
  });

  it.each(TASK_6_ALLOWED_BROWSER_OPERATIONS)(
    'accepts the literal Task 6 operation %s',
    async (kind, risk) => {
      const port = actionPort();
      const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

      await expect(
        adapter.submit(reviewedAction({ kind, risk }), parentReference()),
      ).resolves.toMatchObject({
        kind: risk === 'safe' ? 'safe_execution' : 'approval_created',
      });
      expect(port.create).toHaveBeenCalledTimes(risk === 'safe' ? 0 : 1);
      expect(port.executeAutoApprovedSafe).toHaveBeenCalledTimes(risk === 'safe' ? 1 : 0);
    },
  );

  it('rejects a frozen browser-prefixed operation outside the Task 6 allowlist', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

    await expect(
      adapter.submit(reviewedAction({ kind: 'browser.unregistered' }), parentReference()),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('maps a safe reviewed record exactly to auto-approved v1 execution', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const action = reviewedAction();
    const parent = parentReference();

    await expect(adapter.submit(action, parent)).resolves.toMatchObject({
      kind: 'safe_execution',
      result: { kind: 'account_authority_revoked' },
    });

    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).toHaveBeenCalledOnce();
    expect(port.executeAutoApprovedSafe).toHaveBeenCalledWith({
      parentRun: parent.parentRun,
      attempt: parent.attempt,
      actionId: 'browser.readPage',
      actionVersion: 1,
      params: {
        schemaVersion: 1,
        reviewId: 'browser-action-1',
        origin: 'https://example.test',
        tabId: 'tab_1',
        frameId: 'frame_1',
        target: {
          currentUrl: 'https://example.test/page',
          selector: '#article',
          coordinates: { x: 12, y: 24 },
        },
        parameters: { options: { visible: true }, selector: '#article' },
        parametersHash: 'params_hash_1',
        reviewedHash: 'reviewed_hash_1',
        expectedEffect: 'Inspect the active page.',
        reviewedRisk: 'safe',
        capability: {
          id: BROWSER_OPERATOR_CAPABILITY_ID,
          operation: 'browser.readPage',
        },
      },
      expiresAt: 301_000,
      context: parent.context,
    });
  });

  it.each([
    ['confirm', 'browser.click'],
    ['dangerous', 'browser.submit'],
  ] as const)('routes %s reviewed work through persisted approval creation', async (risk, kind) => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const action = reviewedAction({ risk, kind });
    const parent = parentReference();

    await expect(adapter.submit(action, parent)).resolves.toMatchObject({
      kind: 'approval_created',
      result: { kind: 'account_authority_revoked' },
    });

    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
    expect(port.create).toHaveBeenCalledOnce();
    expect(port.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRun: parent.parentRun,
        attempt: parent.attempt,
        actionId: kind,
        actionVersion: 1,
        expiresAt: action.expiresAt,
        params: expect.objectContaining({
          target: action.target,
          parameters: action.parameters,
          reviewedRisk: risk,
          capability: { id: BROWSER_OPERATOR_CAPABILITY_ID, operation: kind },
        }),
      }),
    );
  });

  it('rejects user-only programmatic use before any action-port call', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

    await expect(
      adapter.submit(reviewedAction(), parentReference({ controlMode: 'user_only' })),
    ).rejects.toMatchObject({ code: 'user_only' });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('re-derives reviewed risk and rejects a dangerous action downgraded to safe', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

    await expect(
      adapter.submit(reviewedAction({ kind: 'browser.submit', risk: 'safe' }), parentReference()),
    ).rejects.toMatchObject({ code: 'invalid_record' });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it.each(SECRET_SHAPED_PATCHES)(
    'rejects secret-shaped reviewed parameters before routing',
    async (patch) => {
      const port = actionPort();
      const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

      await expect(adapter.submit(reviewedAction(patch), parentReference())).rejects.toMatchObject({
        code: 'secret_shaped_input',
      });
      expect(port.create).not.toHaveBeenCalled();
      expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
    },
  );

  it.each([
    [reviewedAction({ accountId: 'acct_other' }), parentReference(), 'account_mismatch'],
    [
      reviewedAction(),
      parentReference({
        attempt: deepFreeze({
          kind: 'initial',
          requestId: 'jreq_1',
          runId: 'jrun_other',
          attemptNumber: 1,
        }),
      }),
      'run_mismatch',
    ],
    [
      reviewedAction({
        requester: deepFreeze({
          kind: 'agent',
          agent: { id: 'agent_1' as never, slug: 'jarvis', builtin: true },
          runId: 'jrun_other',
        }),
      }),
      parentReference(),
      'run_mismatch',
    ],
  ] as const)('rejects mismatched parent identity', async (action, parent, code) => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

    await expect(adapter.submit(action, parent)).rejects.toMatchObject({ code });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('rejects missing request and attempt identity before any action-port call', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const parent = parentReference({
      attempt: deepFreeze({ kind: 'initial', runId: 'jrun_1' } as never),
      context: deepFreeze({
        source: 'ai',
        accountId: 'acct_1',
        runId: 'jrun_1',
        callId: 'browser-action-1',
      }),
    });

    await expect(adapter.submit(reviewedAction(), parent)).rejects.toMatchObject({
      code: 'context_mismatch',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('requires the canonical action call id to match the exact reviewed record', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const valid = parentReference();
    const mismatched = parentReference({
      context: deepFreeze({ ...valid.context, callId: 'browser-action-other' }),
    });

    await expect(adapter.submit(reviewedAction(), mismatched)).rejects.toMatchObject({
      code: 'context_mismatch',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it.each([
    [
      'non-positive attempt number',
      parentReference({
        attempt: deepFreeze({
          kind: 'initial',
          requestId: 'jreq_1',
          runId: 'jrun_1',
          attemptNumber: 0,
        } as never),
        context: deepFreeze({
          source: 'ai',
          accountId: 'acct_1',
          runId: 'jrun_1',
          requestId: 'jreq_1',
          attemptNumber: 0,
          callId: 'browser-action-1',
        }),
      }),
    ],
    [
      'unknown attempt kind',
      parentReference({
        attempt: deepFreeze({
          kind: 'unknown',
          requestId: 'jreq_1',
          runId: 'jrun_1',
          attemptNumber: 1,
        } as never),
      }),
    ],
    [
      'unexpected attempt field',
      parentReference({
        attempt: deepFreeze({
          kind: 'initial',
          requestId: 'jreq_1',
          runId: 'jrun_1',
          attemptNumber: 1,
          widened: true,
        } as never),
      }),
    ],
  ] as const)('rejects %s before any action-port call', async (_label, parent) => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });

    await expect(adapter.submit(reviewedAction(), parent)).rejects.toMatchObject({
      code: 'context_mismatch',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('rejects a requester agent that differs from the parent-run agent', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const action = reviewedAction({
      requester: deepFreeze({
        kind: 'agent',
        agent: { id: 'agent_other' as never, slug: 'other', builtin: false },
        runId: 'jrun_1',
      }),
    });

    await expect(adapter.submit(action, parentReference())).rejects.toMatchObject({
      code: 'run_mismatch',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('requires a deeply immutable pending v1 reviewed record', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const mutable = { ...reviewedAction(), parameters: { selector: '#mutable' } };

    await expect(adapter.submit(mutable, parentReference())).rejects.toMatchObject({
      code: 'mutable_input',
    });
    await expect(
      adapter.submit(reviewedAction({ status: 'unavailable' }), parentReference()),
    ).rejects.toMatchObject({ code: 'not_pending' });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });

  it('rejects a parent reference with mutable nested authority identity', async () => {
    const port = actionPort();
    const adapter = createBrowserApprovalAdapter({ actions: port.narrow });
    const valid = parentReference();
    const mutableParent = Object.freeze({
      ...valid,
      context: { ...valid.context },
    }) as BrowserApprovalParentReference;

    await expect(adapter.submit(reviewedAction(), mutableParent)).rejects.toMatchObject({
      code: 'mutable_input',
    });
    expect(port.create).not.toHaveBeenCalled();
    expect(port.executeAutoApprovedSafe).not.toHaveBeenCalled();
  });
});

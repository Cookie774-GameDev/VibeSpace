import { describe, expect, it, vi } from 'vitest';
import type { JarvisActionDefinition } from './catalog';
import { createJarvisPlan, executeJarvisPlan, reviewJarvisPlan } from './planner';

function action(id: string, patch: Partial<JarvisActionDefinition> = {}): JarvisActionDefinition {
  return {
    id,
    version: 1,
    title: id,
    description: `${id} test action`,
    category: 'test',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object' },
    requiredCapabilities: [],
    requiredPermissions: [],
    supportedPlatforms: ['windows', 'macos', 'linux'],
    risk: 'read-only',
    approval: 'never',
    supportsProgress: false,
    supportsCancellation: false,
    supportsRollback: false,
    preconditions: [],
    possibleNextActions: [],
    exposeToAI: true,
    handler: vi.fn(async () => ({ ok: true as const, summary: 'verified' })),
    ...patch,
  };
}

describe('Jarvis typed planner', () => {
  it('rejects invented action ids before execution', () => {
    expect(() =>
      createJarvisPlan({
        goal: 'Do a made-up thing',
        requestedSteps: [{ action: 'invented.action', input: {} }],
        catalog: [action('known.action')],
      }),
    ).toThrow(/not registered/i);
  });

  it('requires approval for external side effects but not read-only actions', () => {
    const catalog = [
      action('status.read'),
      action('terminal.create', { risk: 'external-side-effect', approval: 'always' }),
    ];
    const plan = createJarvisPlan({
      goal: 'Inspect and create',
      requestedSteps: [
        { action: 'status.read', input: {} },
        { action: 'terminal.create', input: {} },
      ],
      catalog,
    });

    expect(reviewJarvisPlan(plan, catalog, { previouslyApproved: [] })).toMatchObject({
      requiresApproval: true,
      approvalStepIds: [plan.steps[1]?.id],
    });
  });

  it('deduplicates repeated execution with the same idempotency key', async () => {
    const definition = action('status.read');
    const catalog = [definition];
    const plan = createJarvisPlan({
      goal: 'Read once',
      idempotencyKey: 'same-request',
      requestedSteps: [{ action: 'status.read', input: {} }],
      catalog,
    });

    const executeApprovedStep = vi.fn(async () => ({ ok: true as const, summary: 'verified' }));
    const first = await executeJarvisPlan(plan, catalog, { executeApprovedStep });
    const second = await executeJarvisPlan(plan, catalog, { executeApprovedStep });

    expect(first.status).toBe('completed');
    expect(second).toEqual(first);
    expect(executeApprovedStep).toHaveBeenCalledTimes(1);
    expect(executeApprovedStep).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'status.read', input: {} }),
      expect.any(AbortSignal),
    );
    expect(definition.handler).not.toHaveBeenCalled();
    expect(first.steps[0]?.verification.status).toBe('verified');
  });

  it('aborts the executing action before reporting a timeout', async () => {
    const plan = createJarvisPlan({
      goal: 'Run a bounded action',
      requestedSteps: [{ action: 'bounded.run', input: {} }],
      catalog: [action('bounded.run', { supportsCancellation: true })],
    });
    let executionSignal: AbortSignal | undefined;
    const executeApprovedStep = vi.fn(
      (...args: unknown[]) =>
        new Promise<never>(() => {
          executionSignal = args[1] as AbortSignal | undefined;
        }),
    );

    const result = await executeJarvisPlan(plan, [action('bounded.run')], {
      executeApprovedStep,
      timeoutMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.verification.evidence).toMatch(/timed out/i);
    expect(executionSignal).toBeInstanceOf(AbortSignal);
    expect(executionSignal?.aborted).toBe(true);
  });

  it('reports timeout truth when the aborted executor immediately rejects with AbortError', async () => {
    const definition = action('bounded.run', { supportsCancellation: true });
    const plan = createJarvisPlan({
      goal: 'Run a bounded action',
      requestedSteps: [{ action: 'bounded.run', input: {} }],
      catalog: [definition],
    });
    const executeApprovedStep = vi.fn(
      (_step: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Executor observed cancellation', 'AbortError')),
            { once: true },
          );
        }),
    );

    const result = await executeJarvisPlan(plan, [definition], {
      executeApprovedStep,
      timeoutMs: 5,
    });

    expect(result.status).toBe('failed');
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      verification: {
        status: 'failed',
        evidence: expect.stringMatching(/timed out/i),
      },
    });
  });
});

/**
 * @file Tests for the action runner — built-in registry lookup, custom
 *       tool fallthrough, param validation, and toast emission.
 *
 * The runner is the single dispatch point used by both the chat
 * Approve/Cancel card and the actions palette. Any change to its
 * contract ripples through every action call site, so these tests
 * pin the shape that today's UI and the AI prompt addendum rely on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Avoid pulling the real toast module (it mounts a portal in jsdom).
vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import {
  createCanonicalFileActionEvidenceAuthority,
  createJarvisApprovedActionRunner,
  createJarvisRegisteredBuiltinDispatcher,
  runAction,
  resolveAction,
  getAllActions,
} from '@/lib/actions/runner';
import type { CanonicalFileActionEvidence } from '@/lib/jarvis/artifactProducerAdapters';
import { toast } from '@/components/ui/toast';
import { useToolStore } from '@/features/tools/toolStore';
import { useTerminalCommandQueue } from '@/features/terminals/terminalCommandQueue';
import { useDevConsoleStore } from '@/features/dev-console';
import {
  createJarvisActionCatalog,
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
} from '@/lib/jarvis/actions/catalog';
import { canonicalizeBrowserJson } from '@/features/browser/browserActions';
import { revokeBrowserGoalHostSession } from '@/features/browser/browserGoalIntegration';
import { hashJarvisText } from '@/lib/jarvis/identity';

describe('resolveAction', () => {
  it('finds built-in actions by id', () => {
    const a = resolveAction('nav.chat');
    expect(a).toBeDefined();
    expect(a?.id).toBe('nav.chat');
    expect(a?.category).toBe('navigation');
  });

  it('returns undefined for unknown ids', () => {
    expect(resolveAction('does.not.exist')).toBeUndefined();
  });

  it('falls through to a custom tool when its slug is present', () => {
    useToolStore.setState({ tools: [] });
    useToolStore.getState().create({
      name: 'My dev server',
      description: 'Start the dev server.',
      baseAction: 'terminal.run',
      params: { command: 'npm run jarvis' },
    });

    const slug = useToolStore.getState().tools[0]!.slug;
    const a = resolveAction(`custom.${slug}`);
    expect(a).toBeDefined();
    expect(a?.id).toBe(`custom.${slug}`);
    expect(a?.category).toBe('custom');
  });
});

describe('getAllActions', () => {
  it('combines built-ins and custom tools, with built-ins winning collisions', () => {
    useToolStore.setState({ tools: [] });
    const before = getAllActions();
    expect(before.some((a) => a.id === 'nav.chat')).toBe(true);

    // Forge a custom tool that tries to shadow a built-in id. The store
    // namespaces under `custom.` so collisions can only happen if the
    // tool's slug was crafted maliciously, but we still defend against it.
    useToolStore.setState({
      tools: [
        {
          slug: 'rogue',
          name: 'Rogue',
          description: 'shadow attempt',
          baseAction: 'nav.chat',
          params: {},
          createdAt: 0,
          updatedAt: 0,
          published: null,
        },
      ],
    });

    const after = getAllActions();
    const navMatches = after.filter((a) => a.id === 'nav.chat');
    // Only the built-in entry, never a duplicate from the custom store.
    expect(navMatches).toHaveLength(1);
    expect(navMatches[0]?.category).toBe('navigation');
  });
});

describe('runAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToolStore.setState({ tools: [] });
    useTerminalCommandQueue.getState().clear();
    useDevConsoleStore.getState().clear();
  });

  it('returns a structured error for unknown ids and toasts by default', async () => {
    const result = await runAction('does.not.exist', {}, { source: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown action/);
    expect(toast.error).toHaveBeenCalled();
  });

  it('rejects required-param omissions before dispatching the runner', async () => {
    const result = await runAction('terminal.run', {}, { source: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required/i);
  });

  it('rejects direct AI terminal dispatch without issued canonical approval authority', async () => {
    const definition = resolveAction('terminal.run');
    expect(definition).toBeTruthy();
    const direct = vi.spyOn(definition!, 'run');

    await expect(
      runAction(
        'terminal.run',
        { command: 'npm test' },
        { source: 'ai', messageId: 'model-message', callId: 'model-call' },
        { emitToast: false },
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'AI terminal actions require canonical approval authority.',
    });
    expect(direct).not.toHaveBeenCalled();
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(0);
  });

  it('suppresses the toast when emitToast is false', async () => {
    const result = await runAction('does.not.exist', {}, { source: 'user' }, { emitToast: false });
    expect(result.ok).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('uses shared precise success narration with and without an executor summary', async () => {
    const definition = resolveAction('settings.open');
    expect(definition).toBeTruthy();
    const run = vi
      .spyOn(definition!, 'run')
      .mockResolvedValueOnce({ ok: true, summary: 'Opened the requested settings panel.' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, summary: '   ' });

    await expect(runAction('settings.open', {}, { source: 'user' })).resolves.toEqual({
      ok: true,
      summary: 'Opened the requested settings panel.',
    });
    expect(toast.success).toHaveBeenNthCalledWith(
      1,
      definition!.label,
      'Completed, sir. Opened the requested settings panel.',
    );

    await expect(runAction('settings.open', {}, { source: 'user' })).resolves.toEqual({ ok: true });
    expect(toast.success).toHaveBeenNthCalledWith(
      2,
      definition!.label,
      `Completed, sir. ${definition!.label} completed successfully.`,
    );

    await expect(runAction('settings.open', {}, { source: 'user' })).resolves.toEqual({
      ok: true,
      summary: '   ',
    });
    expect(toast.success).toHaveBeenNthCalledWith(
      3,
      definition!.label,
      `Completed, sir. ${definition!.label} completed successfully.`,
    );

    run.mockRestore();
  });

  it('catches runner exceptions and turns them into structured errors', async () => {
    // theme.toggle is a built-in that touches the UI store; in jsdom it
    // works fine, so we wrap a custom tool whose runner explicitly throws.
    useToolStore.setState({
      tools: [
        {
          slug: 'kaboom',
          name: 'Kaboom',
          description: 'throws on run',
          // Intentionally point at a non-existent base action so the
          // synthesised runner returns ok:false with a clear message.
          baseAction: 'nope.nope',
          params: {},
          createdAt: 0,
          updatedAt: 0,
          published: null,
        },
      ],
    });

    const result = await runAction('custom.kaboom', {}, { source: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown base action/i);
  });

  it('does not expose the removed Clock timer action', async () => {
    const def = resolveAction('clock.timer');
    expect(def).toBeUndefined();
  });

  it('coerces params inside custom workflow tool steps', async () => {
    const tool = useToolStore.getState().create({
      name: 'Tea workflow',
      description: 'Open a small terminal batch.',
      baseAction: 'workflow.run',
      params: {},
      steps: [
        {
          action: 'terminal.bulkOpen',
          params: { count: '2', command: 'echo hi' },
        },
      ],
    });

    const result = await runAction(
      `custom.${tool.slug}`,
      {},
      { source: 'user' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    expect(useTerminalCommandQueue.getState().queue).toHaveLength(2);
  });

  it('shares one in-flight execution for the same approved proposal', async () => {
    const def = resolveAction('settings.open');
    expect(def).toBeTruthy();
    const spy = vi.spyOn(def!, 'run').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, summary: 'opened' };
    });
    const context = {
      source: 'user' as const,
      messageId: 'message_once',
      callId: 'call_once',
    };
    const [first, second] = await Promise.all([
      runAction('settings.open', {}, context, { emitToast: false }),
      runAction('settings.open', {}, context, { emitToast: false }),
    ]);
    expect(first).toEqual(second);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed for direct JARVIS-correlated dispatch and delegates only through the narrow port', async () => {
    const definition = resolveAction('settings.open');
    expect(definition).toBeTruthy();
    const direct = vi.spyOn(definition!, 'run');

    await expect(
      runAction(
        'settings.open',
        {},
        {
          source: 'ai',
          runId: 'jrun_approved',
          approvalId: 'jappr_approved',
        },
        { emitToast: false },
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'Canonical JARVIS actions require the approval authority.',
    });
    expect(direct).not.toHaveBeenCalled();

    const execute = vi.fn(async () => ({
      kind: 'committed' as const,
      value: {
        kind: 'settled' as const,
        result: { ok: true as const, summary: 'Approved execution completed.' },
      },
    }));
    const approvedRunner = createJarvisApprovedActionRunner({ execute } as never);
    const input = {
      parentRun: { id: 'jrun_approved' },
      approvalId: 'jappr_approved',
      context: { source: 'ai' as const },
    } as never;
    await expect(approvedRunner.execute(input)).resolves.toEqual({
      kind: 'committed',
      value: {
        kind: 'settled',
        result: { ok: true, summary: 'Approved execution completed.' },
      },
    });
    expect(execute).toHaveBeenCalledWith(input);
  });

  it('executes a registered builtin only through an issued external-effect capability', async () => {
    const registration = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'file.search',
    )!;
    const definition = resolveAction('file.search')!;
    const run = vi
      .spyOn(definition, 'run')
      .mockResolvedValue({ ok: true, summary: 'Canonical search completed.' });
    const signal = new AbortController().signal;
    const beginExternalEffect = vi.fn((begin) => ({
      kind: 'committed' as const,
      value: begin(signal),
    }));
    const dispatcher = createJarvisRegisteredBuiltinDispatcher();

    await expect(
      dispatcher({
        registration,
        params: { query: 'smoke fixture', maxResults: 1 },
        context: {
          source: 'ai',
          accountId: 'account-kernel',
          runId: 'run-kernel',
          approvalId: 'jappr-kernel',
          requestId: 'request-kernel',
          attemptNumber: 1,
        },
        execution: { beginExternalEffect } as never,
      }),
    ).resolves.toEqual({
      kind: 'executor_returned',
      result: { ok: true, summary: 'Canonical search completed.' },
    });
    expect(beginExternalEffect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      { query: 'smoke fixture', maxResults: 1 },
      expect.objectContaining({ source: 'ai', signal }),
    );
  });

  it('routes canonical browser registrations only to a live scoped host', async () => {
    revokeBrowserGoalHostSession();
    const registration = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'browser.navigate',
    )!;
    const beginExternalEffect = vi.fn();
    const dispatcher = createJarvisRegisteredBuiltinDispatcher();
    const parameters = { url: 'https://example.test/next' };

    await expect(
      dispatcher({
        registration,
        params: {
          schemaVersion: 1,
          reviewId: 'review-runner',
          origin: 'https://example.test',
          tabId: 'tab-runner',
          frameId: null,
          target: { currentUrl: 'https://example.test/start' },
          parameters,
          parametersHash: await hashJarvisText(canonicalizeBrowserJson(parameters)),
          reviewedHash: 'reviewed-action-hash',
          expectedEffect: 'Navigate the active browser tab.',
          reviewedRisk: 'confirm',
          capability: { id: 'browser.operator', operation: 'browser.navigate' },
        },
        context: {
          source: 'ai',
          accountId: 'account-runner',
          runId: 'run-runner',
          requestId: 'request-runner',
          attemptNumber: 1,
          approvalId: 'approval-runner',
        },
        execution: {
          approval: {
            runId: 'run-runner',
            requestId: 'request-runner',
            attemptNumber: 1,
          },
          initialLiveProof: { accountId: 'account-runner' },
          beginExternalEffect,
        } as never,
      }),
    ).resolves.toEqual({
      kind: 'executor_returned',
      result: {
        ok: false,
        error: 'An explicit browser host source registration is required.',
      },
    });
    expect(beginExternalEffect).not.toHaveBeenCalled();
  });

  it('queues exactly one terminal command through issued authority and propagates cancellation', async () => {
    const registration = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'terminal.run',
    )!;
    const definition = resolveAction('terminal.run')!;
    const run = vi.spyOn(definition, 'run');
    const signal = new AbortController().signal;
    const beginExternalEffect = vi.fn((begin) => ({
      kind: 'committed' as const,
      value: begin(signal),
    }));
    const dispatcher = createJarvisRegisteredBuiltinDispatcher();

    const outcome = await dispatcher({
      registration,
      params: { command: 'npm test', label: 'Approved tests' },
      context: {
        source: 'ai',
        accountId: 'account-kernel',
        runId: 'run-terminal',
        approvalId: 'approval-terminal',
        requestId: 'request-terminal',
        attemptNumber: 1,
      },
      execution: { beginExternalEffect } as never,
    });
    expect(outcome).toEqual({
      kind: 'executor_returned',
      result: {
        ok: true,
        summary: 'Command queued in Terminal.',
        data: { state: 'queued', executionId: expect.any(String) },
      },
    });
    expect(beginExternalEffect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      { command: 'npm test', label: 'Approved tests' },
      expect.objectContaining({ source: 'ai', signal }),
    );
    expect(useTerminalCommandQueue.getState().queue).toMatchObject([
      { kind: 'shell', command: 'npm test', label: 'Approved tests' },
    ]);
  });

  it('dispatches the protected model switch with canonical approval correlation', async () => {
    const registration = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'chat.model.switch',
    )!;
    const definition = resolveAction('chat.model.switch')!;
    const run = vi
      .spyOn(definition, 'run')
      .mockResolvedValue({ ok: true, summary: 'Canonical model switch completed.' });
    const signal = new AbortController().signal;
    const beginExternalEffect = vi.fn((begin) => ({
      kind: 'committed' as const,
      value: begin(signal),
    }));
    const dispatcher = createJarvisRegisteredBuiltinDispatcher();

    await expect(
      dispatcher({
        registration,
        params: { request: 'Switch to Gemini.', needsTools: true },
        context: {
          source: 'ai',
          accountId: 'account-kernel',
          runId: 'run-model-switch',
          approvalId: 'approval-model-switch',
          requestId: 'request-model-switch',
          attemptNumber: 1,
        },
        execution: { beginExternalEffect } as never,
      }),
    ).resolves.toEqual({
      kind: 'executor_returned',
      result: { ok: true, summary: 'Canonical model switch completed.' },
    });
    expect(beginExternalEffect).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      { request: 'Switch to Gemini.', needsImages: false, needsTools: true },
      expect.objectContaining({
        source: 'ai',
        approvalId: 'approval-model-switch',
        signal,
      }),
    );
  });

  it('omits command payloads from action diagnostics', async () => {
    const secretCommand = 'Write-Output PRIVATE_VALUE_DO_NOT_LOG';
    const result = await runAction(
      'terminal.run',
      { command: secretCommand, cwd: 'C:\\Projects\\Safe' },
      { source: 'user', messageId: 'message_secret', callId: 'call_secret' },
      { emitToast: false },
    );
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(useDevConsoleStore.getState().entries);
    expect(serialized).not.toContain(secretCommand);
    expect(serialized).toContain('[omitted]');
    expect(serialized).toContain('C:\\\\Projects\\\\Safe');
  });
});

describe('canonical file-action artifact evidence authority', () => {
  const exact = Object.freeze({
    producerId: 'file_action_result',
    accountId: 'account-file',
    runId: 'jrun_file',
    requestId: 'jrequest_file',
    attemptNumber: 1,
    resultRef: 'jresult_file',
    state: 'succeeded',
    verifiedAt: 1_786_202_200_000,
    actionId: 'files.create',
    actionVersion: 1,
  }) satisfies CanonicalFileActionEvidence;

  it('accepts only an exact canonical re-read backed by a persisted file result', async () => {
    const readCanonicalFileActionResult = vi.fn(async () =>
      Object.freeze({
        evidence: exact,
        result: Object.freeze({
          ok: true as const,
          summary: 'Created file.',
          data: Object.freeze({ path: 'C:\\Projects\\FarmLife\\created.md', operation: 'create' }),
        }),
      }),
    );
    const authority = createCanonicalFileActionEvidenceAuthority({
      readCanonicalFileActionResult,
    });

    await expect(authority.verify(exact)).resolves.toBe(exact);
    await expect(
      authority.verify(Object.freeze({ ...exact, runId: 'jrun_other' })),
    ).resolves.toBeNull();
  });

  it('rejects proposed, failed, mismatched, and invalid numeric results', async () => {
    const readCanonicalFileActionResult = vi.fn(async () =>
      Object.freeze({
        evidence: exact,
        result: Object.freeze({ ok: false as const, error: 'write failed' }),
      }),
    );
    const authority = createCanonicalFileActionEvidenceAuthority({
      readCanonicalFileActionResult,
    });

    await expect(authority.verify(exact)).resolves.toBeNull();
    await expect(
      authority.verify(Object.freeze({ ...exact, state: 'proposed' }) as never),
    ).resolves.toBeNull();
    await expect(
      authority.verify(Object.freeze({ ...exact, actionId: 'settings.open' })),
    ).resolves.toBeNull();
    await expect(
      authority.verify(Object.freeze({ ...exact, verifiedAt: 1.5 })),
    ).resolves.toBeNull();
  });
});

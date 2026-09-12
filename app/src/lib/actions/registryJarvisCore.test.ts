import { describe, expect, it, vi } from 'vitest';

import type { ActionDef } from './types';
import {
  CORE_ACTION_IDS,
  cancelTerminalExecutionsAfterObserverCancellation,
  createJarvisCoreActions,
  createJarvisTerminalRegisteredActionDispatcher,
  parseAgentBatch,
  waitForAgentBatch,
  waitForTerminalExecutions,
} from './registryJarvisCore';
import {
  jarvisIssuedActionExecutionBrand,
  jarvisTerminalHandoffReceiptBrand,
  type JarvisTerminalOwnedExecution,
} from '@/lib/jarvis/approvalEngine';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { useTerminalExecutionStore } from '@/features/terminals/terminalExecutionStore';
import { useAuthStore } from '@/stores/auth';
import { chatRepo } from '@/lib/db/repositories';
import * as terminalIntelligence from '@/lib/jarvis/terminalIntelligence';

const mcpMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@/lib/mcp/serverManager', () => ({
  jarvisMcpServerManager: {
    invoke: mcpMocks.invoke,
  },
}));

function action(
  id: string,
  run = vi.fn(async () => ({ ok: true as const, summary: 'done' })),
): ActionDef {
  return {
    id,
    category: 'custom',
    label: id,
    description: id,
    params: [],
    run,
  };
}

describe('Jarvis canonical core actions', () => {
  it('routes canonical theme settings without exposing retired Light', async () => {
    const resolvedIds: string[] = [];
    const routed = createJarvisCoreActions((id) => {
      resolvedIds.push(id);
      return action(id);
    }).find((item) => item.id === 'settings.update')!;
    await routed.run({ setting: 'theme', value: 'monochrome' }, { source: 'ai' });
    expect(resolvedIds).toContain('theme.monochrome');
    await routed.run({ setting: 'theme', value: 'SAKURA' }, { source: 'ai' });
    expect(resolvedIds).toContain('theme.sakura');

    const result = await routed.run({ setting: 'theme', value: 'light' }, { source: 'ai' });
    expect(result.ok).toBe(false);
    await expect(
      routed.run({ setting: 'theme', value: 'dusk' }, { source: 'ai' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('registers every stable action id exactly once', () => {
    const actions = createJarvisCoreActions(() => undefined);
    expect(actions.map((item) => item.id)).toEqual(CORE_ACTION_IDS);
    expect(new Set(actions.map((item) => item.id)).size).toBe(actions.length);
    expect(actions.map((item) => item.id)).not.toContain('plugin.invoke');
    const modelParameterKeys = actions.flatMap((item) => item.params.map((param) => param.key));
    expect(modelParameterKeys).not.toContain('approvalId');
    expect(modelParameterKeys).not.toContain('secretHandleRefs');
    expect(modelParameterKeys).not.toContain('resolveSecret');
  });

  it('never exposes a model-controlled filesystem root on automatic file search', () => {
    const search = createJarvisCoreActions(() => undefined).find(
      (item) => item.id === 'file.search',
    )!;

    expect(search.autoApprove).toBe(true);
    expect(search.params.map((param) => param.key)).toEqual(['query', 'maxResults']);
  });

  it('maps terminal.create_many onto the real terminal queue action', async () => {
    const run = vi.fn(async () => ({ ok: true as const, summary: 'queued' }));
    const legacy = [action('terminal.bulkOpen', run)];
    const actions = createJarvisCoreActions((id) => legacy.find((item) => item.id === id));

    const result = await actions
      .find((item) => item.id === 'terminal.create_many')!
      .run({ count: 3, cwd: 'C:\\work' }, { source: 'ai', chatId: 'chat-1' });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(
      { count: 3, cwd: 'C:\\work', command: '' },
      { source: 'ai', chatId: 'chat-1' },
    );
  });

  it('fails truthfully when a required host action is unavailable', async () => {
    const action = createJarvisCoreActions(() => undefined).find(
      (item) => item.id === 'terminal.create',
    )!;

    await expect(action.run({}, { source: 'ai' })).resolves.toEqual({
      ok: false,
      error: 'Required host action terminal.bulkOpen is unavailable.',
    });
  });

  it('requires exactly one explicit terminal ref before sending input', async () => {
    const sendToRefs = vi.fn(async () => ({ ok: true as const, summary: 'sent' }));
    const sendAll = vi.fn(async () => ({ ok: true as const, summary: 'broadcast' }));
    const actions = createJarvisCoreActions((id) => {
      if (id === 'terminal.sendToRefs') return action(id, sendToRefs);
      if (id === 'terminal.sendAll') return action(id, sendAll);
      return undefined;
    });
    const send = actions.find((item) => item.id === 'terminal.send_input')!;
    expect(send.params.find((param) => param.key === 'refsJson')?.required).toBe(true);

    for (const refsJson of [
      undefined,
      '[]',
      '[{"sessionId":"pty-a"},{"sessionId":"pty-b"}]',
      '{}',
    ]) {
      await expect(
        send.run(
          {
            command: 'status',
            ...(refsJson === undefined ? {} : { refsJson }),
          },
          { source: 'ai' },
        ),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/exactly one/i) });
    }

    expect(sendAll).not.toHaveBeenCalled();
    expect(sendToRefs).not.toHaveBeenCalled();

    useTerminalTranscriptStore.getState().reset();
    await expect(
      send.run({ command: 'status', refsJson: '[{"sessionId":"pty-stale"}]' }, { source: 'user' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/exactly one live/i) });
    expect(sendToRefs).not.toHaveBeenCalled();

    useTerminalTranscriptStore
      .getState()
      .registerSession('pty-exact', { paneId: 'pane-exact', command: 'opencode' });
    await expect(
      send.run({ command: 'status', refsJson: '[{"sessionId":"pty-exact"}]' }, { source: 'user' }),
    ).resolves.toMatchObject({ ok: true });
    expect(sendToRefs).toHaveBeenCalledOnce();
    expect(sendToRefs).toHaveBeenCalledWith(
      { command: 'status', refsJson: '[{"sessionId":"pty-exact"}]' },
      { source: 'user' },
    );
    expect(sendAll).not.toHaveBeenCalled();
    useTerminalTranscriptStore.getState().reset();
  });

  it('requires exactly one explicit selector for terminal wait and collect', async () => {
    const actions = createJarvisCoreActions(() => undefined);
    const wait = actions.find((item) => item.id === 'terminal.wait_for_output')!;
    const collect = actions.find((item) => item.id === 'terminal.collect_output')!;

    await expect(wait.run({}, { source: 'ai' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/exactly one/i),
    });
    await expect(
      wait.run({ sessionId: 'pty-a', paneId: 'pane-a' }, { source: 'ai' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/exactly one/i),
    });
    await expect(collect.run({}, { source: 'ai' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/exactly one/i),
    });
    await expect(
      collect.run({ sessionId: 'pty-a', agentSlug: 'scout' }, { source: 'ai' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/exactly one/i),
    });

    useTerminalTranscriptStore.getState().reset();
    useTerminalTranscriptStore
      .getState()
      .registerSession('pty-exact', { paneId: 'pane-exact', command: 'opencode' });
    useTerminalTranscriptStore.getState().appendOutput('pty-exact', 'T09_EXACT_OUTPUT');
    await expect(
      wait.run(
        { sessionId: 'pty-exact', contains: 'T09_EXACT_OUTPUT', timeoutMs: 250 },
        { source: 'user' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { sessionId: 'pty-exact', paneId: 'pane-exact' },
    });
    await expect(
      collect.run({ sessionId: 'pty-exact', maxChars: 2_000 }, { source: 'user' }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        sessions: [
          expect.objectContaining({
            sessionId: 'pty-exact',
            output: expect.stringContaining('T09_EXACT_OUTPUT'),
          }),
        ],
      },
    });
    useTerminalTranscriptStore.getState().reset();
  });

  it('binds protected terminal reads and input to the originating live account chat and project', async () => {
    const sendToRefs = vi.fn(async () => ({ ok: true as const, summary: 'sent' }));
    const actions = createJarvisCoreActions((id) =>
      id === 'terminal.sendToRefs' ? action(id, sendToRefs) : undefined,
    );
    const send = actions.find((item) => item.id === 'terminal.send_input')!;
    const wait = actions.find((item) => item.id === 'terminal.wait_for_output')!;
    const collect = actions.find((item) => item.id === 'terminal.collect_output')!;
    const context = {
      source: 'ai' as const,
      accountId: 'account-a',
      chatId: 'chat-a',
    };
    const chat = {
      id: 'chat-a',
      workspace_id: 'workspace-a',
      project_id: 'project-a',
      title: 'Terminal isolation',
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 1,
    };
    const getChat = vi.spyOn(chatRepo, 'getById').mockResolvedValue(chat as never);

    const setActiveScope = (
      accountId = 'account-a',
      workspaceId = 'workspace-a',
      projectId: string | null = 'project-a',
    ) =>
      useAuthStore.setState({
        localUserId: accountId,
        cloudSession: null,
        workspaceId: workspaceId as never,
        projectId: projectId as never,
      });
    const registerLive = (projectId = 'project-a', accountId = 'account-a') => {
      useTerminalTranscriptStore.getState().registerSession('pty-a', {
        paneId: 'pane-a',
        command: 'opencode',
        projectId,
      });
      useTerminalTranscriptStore.getState().appendOutput('pty-a', 'SCOPE_SECRET_OUTPUT');
      useTerminalExecutionStore.getState().mark('execution-a', 'running', {
        accountId,
        runId: 'terminal-run-a',
        sessionId: 'pty-a',
        processIdentity: {
          accountId,
          projectId,
          runId: 'terminal-run-a',
          executionId: 'execution-a',
          paneId: 'pane-a',
          sessionId: 'pty-a',
          processInstanceId: 'process-a',
          pid: 4242,
          processStartedAt: 1_723_456_789_000,
          runtimeGeneration: 'runtime-generation-a',
        },
      });
    };
    const resetTerminalState = () => {
      useTerminalTranscriptStore.getState().reset();
      useTerminalExecutionStore.getState().clear();
      sendToRefs.mockClear();
    };

    try {
      setActiveScope();
      registerLive();
      await expect(
        send.run({ command: 'status', refsJson: '{"sessionId":"pty-a"}' }, context),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        wait.run({ paneId: 'pane-a', contains: 'SCOPE_SECRET_OUTPUT', timeoutMs: 250 }, context),
      ).resolves.toMatchObject({ ok: true, data: { sessionId: 'pty-a', paneId: 'pane-a' } });
      await expect(
        collect.run({ sessionId: 'pty-a', maxChars: 2_000 }, context),
      ).resolves.toMatchObject({
        ok: true,
        data: {
          sessions: [
            expect.objectContaining({
              sessionId: 'pty-a',
              output: expect.stringContaining('SCOPE_SECRET_OUTPUT'),
            }),
          ],
        },
      });
      sendToRefs.mockClear();
      for (const refsJson of [
        '[{"sessionId":"pty-a"}]',
        '{"sessionId":"pty-a","extra":"foreign"}',
        '{"sessionId":"pty-a","paneId":"pane-a"}',
      ]) {
        await expect(send.run({ command: 'status', refsJson }, context)).resolves.toMatchObject({
          ok: false,
          error: expect.stringMatching(/exactly one/i),
        });
      }
      expect(sendToRefs).not.toHaveBeenCalled();

      for (const setup of [
        () => setActiveScope('account-b'),
        () => setActiveScope('account-a', 'workspace-b'),
        () => setActiveScope('account-a', 'workspace-a', null),
        () => {
          setActiveScope();
          getChat.mockResolvedValue(undefined);
        },
        () => {
          setActiveScope();
          getChat.mockResolvedValue({ ...chat, project_id: 'project-b' } as never);
        },
        () => {
          setActiveScope();
          useTerminalTranscriptStore.getState().registerSession('pty-a', {
            paneId: 'pane-a',
            command: 'opencode',
            projectId: 'project-b',
          });
        },
        () => {
          setActiveScope();
          useTerminalExecutionStore.getState().clear();
        },
        () => {
          setActiveScope();
          useTerminalTranscriptStore.setState((state) => ({
            sessions: {
              ...state.sessions,
              'pty-a': {
                ...state.sessions['pty-a']!,
                lastWriteAt: 1,
              },
            },
          }));
        },
        () => {
          setActiveScope();
          useTerminalExecutionStore.getState().mark('execution-a', 'complete');
        },
        () => {
          setActiveScope();
          useTerminalExecutionStore.getState().clear();
          registerLive('project-a', 'account-b');
        },
      ]) {
        getChat.mockResolvedValue(chat as never);
        setup();
        const collected = await collect.run({ sessionId: 'pty-a', maxChars: 2_000 }, context);
        expect(collected).toMatchObject({ ok: false });
        expect(JSON.stringify(collected)).not.toContain('SCOPE_SECRET_OUTPUT');
        await expect(
          send.run({ command: 'status', refsJson: '{"sessionId":"pty-a"}' }, context),
        ).resolves.toMatchObject({ ok: false });
        expect(sendToRefs).not.toHaveBeenCalled();
        resetTerminalState();
        setActiveScope();
        registerLive();
      }

      getChat.mockResolvedValue(chat as never);
      getChat.mockImplementationOnce(async () => {
        setActiveScope('account-b');
        return chat as never;
      });
      const switched = await wait.run(
        { sessionId: 'pty-a', contains: 'SCOPE_SECRET_OUTPUT', timeoutMs: 250 },
        context,
      );
      expect(switched).toMatchObject({ ok: false });
      expect(JSON.stringify(switched)).not.toContain('SCOPE_SECRET_OUTPUT');

      resetTerminalState();
      setActiveScope();
      registerLive();
      const readOperatingSnapshot = vi
        .spyOn(terminalIntelligence, 'readJarvisTerminalOperatingSnapshot')
        .mockImplementationOnce((options) => {
          const snapshot = readOperatingSnapshot.getMockImplementation()
            ? terminalIntelligence.createJarvisTerminalOperatingSnapshot({
                observedAt: options.observedAt,
                transcripts: useTerminalTranscriptStore.getState().sessions,
                executions: useTerminalExecutionStore.getState().executions,
                queue: [],
              })
            : terminalIntelligence.readJarvisTerminalOperatingSnapshot(options);
          setActiveScope('account-b');
          return snapshot;
        });
      const revoked = await collect.run({ sessionId: 'pty-a', maxChars: 2_000 }, context);
      expect(revoked).toMatchObject({ ok: false });
      expect(JSON.stringify(revoked)).not.toContain('SCOPE_SECRET_OUTPUT');
      readOperatingSnapshot.mockRestore();
    } finally {
      getChat.mockRestore();
      resetTerminalState();
      useAuthStore.setState({
        localUserId: null,
        cloudSession: null,
        workspaceId: null,
        projectId: null,
      });
    }
  });

  it('preserves direct user terminal palette lookup without canonical chat scope', async () => {
    const sendToRefs = vi.fn(async () => ({ ok: true as const, summary: 'sent' }));
    const send = createJarvisCoreActions((id) =>
      id === 'terminal.sendToRefs' ? action(id, sendToRefs) : undefined,
    ).find((item) => item.id === 'terminal.send_input')!;

    useTerminalTranscriptStore.getState().reset();
    useTerminalTranscriptStore.getState().registerSession('pty-user', {
      paneId: 'pane-user',
      command: 'shell',
    });
    await expect(
      send.run(
        { command: 'echo user', refsJson: '[{"sessionId":"pty-user"}]' },
        { source: 'user' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(sendToRefs).toHaveBeenCalledOnce();
    useTerminalTranscriptStore.getState().reset();
  });

  it('keeps the protected legacy start adapter fail closed', async () => {
    const terminalRun = vi.fn();
    const start = createJarvisCoreActions((id) =>
      id === 'terminal.run' ? action(id, terminalRun) : undefined,
    ).find((item) => item.id === 'terminal.start_cli')!;
    await expect(
      start.run(
        { cli: 'opencode', timeoutMs: 120_000 },
        { source: 'ai', accountId: 'account-a', runId: 'run-a', chatId: 'chat-a' },
      ),
    ).resolves.toEqual({ ok: false, error: 'Canonical terminal dispatcher is required.' });
    expect(terminalRun).not.toHaveBeenCalled();
  });

  it('does not claim legacy task cancellation before canonical kernel injection', async () => {
    const cancel = createJarvisCoreActions(() => undefined).find(
      (item) => item.id === 'task.cancel',
    )!;

    expect(cancel.autoApprove).not.toBe(true);
    expect(cancel.destructive).toBe(true);
    await expect(cancel.run({ runId: 'legacy-run' }, { source: 'ai' })).resolves.toEqual({
      ok: false,
      error: 'Canonical task cancellation is unavailable until the kernel port is connected.',
    });
  });

  it('invokes only the exact approved MCP target and sanitizes provider failures', async () => {
    const invoke = createJarvisCoreActions(() => undefined).find(
      (item) => item.id === 'mcp.invoke',
    )!;
    mcpMocks.invoke.mockResolvedValueOnce({
      contentTrust: 'external_untrusted',
      summary: 'Repository read.',
    });

    await expect(
      invoke.run(
        {
          serverId: 'github',
          toolName: 'repo.read',
          inputJson: '{"owner":"openai"}',
          timeoutMs: 2_000,
        },
        { source: 'ai' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      summary: 'MCP tool github.repo.read completed.',
    });
    expect(mcpMocks.invoke).toHaveBeenLastCalledWith(
      'github',
      'repo.read',
      { owner: 'openai' },
      { timeoutMs: 2_000 },
    );

    mcpMocks.invoke.mockRejectedValueOnce(new Error('Bearer live-secret-provider-detail'));
    const failed = await invoke.run(
      { serverId: 'github', toolName: 'repo.read', inputJson: '{}' },
      { source: 'ai' },
    );
    expect(failed).toEqual({ ok: false, error: 'MCP tool invocation failed.' });
    expect(JSON.stringify(failed)).not.toContain('live-secret');
  });

  it('hands the exact canonical terminal controller to the private acceptor before success', async () => {
    const owned: JarvisTerminalOwnedExecution = {
      recordResult: vi.fn(),
      recordCancellationVerified: vi.fn(),
      requestCancellation: vi.fn(),
      dispose: vi.fn(),
    };
    const acceptIssuedExecution = vi.fn(({ executionId, ownerId }) =>
      Object.freeze({
        executionId,
        ownerId,
        [jarvisTerminalHandoffReceiptBrand]: true as const,
      }),
    );
    const createAcceptor = vi.fn(() => ({ acceptIssuedExecution }));
    const transferTerminalOwnership = vi.fn(({ executionId, acceptor }) => ({
      kind: 'committed' as const,
      value: acceptor.acceptIssuedExecution({
        executionId,
        ownerId: 'approval:jappr_1',
        execution: owned,
      }),
    }));
    const dispatcher = createJarvisTerminalRegisteredActionDispatcher({
      newExecutionId: () => 'jterm_1',
      newCancellationToken: () => 'jcancel_native_1',
      createAcceptor,
    });

    const outcome = await dispatcher({
      registration: {
        id: 'terminal.create',
        version: 1,
        executor: { kind: 'builtin', registryActionId: 'terminal.create' },
      } as never,
      params: {},
      context: {
        source: 'ai',
        accountId: 'account-a',
        runId: 'jrun_1',
        approvalId: 'jappr_1',
        requestId: 'request-1',
        attemptNumber: 1,
      },
      execution: {
        producerKind: 'terminal',
        ownerId: 'approval:jappr_1',
        [jarvisIssuedActionExecutionBrand]: true,
        transferTerminalOwnership,
      } as never,
    });

    expect(createAcceptor).toHaveBeenCalledWith({
      accountId: 'account-a',
      runId: 'jrun_1',
      executionId: 'jterm_1',
      cancellationToken: 'jcancel_native_1',
      command: '',
    });
    expect(acceptIssuedExecution).toHaveBeenCalledWith({
      executionId: 'jterm_1',
      ownerId: 'approval:jappr_1',
      execution: owned,
    });
    expect(outcome).toMatchObject({
      kind: 'terminal_handoff_accepted',
      executorKind: 'terminal',
      ownerId: 'approval:jappr_1',
      result: { ok: true, data: { state: 'queued', executionId: 'jterm_1' } },
    });
    expect(JSON.stringify(outcome)).not.toContain('jcancel_native_1');
  });

  it('hands an approved terminal.run command and bounded metadata to the canonical acceptor', async () => {
    const owned: JarvisTerminalOwnedExecution = {
      recordResult: vi.fn(),
      recordCancellationVerified: vi.fn(),
      requestCancellation: vi.fn(),
      dispose: vi.fn(),
    };
    const acceptIssuedExecution = vi.fn(({ executionId, ownerId }) =>
      Object.freeze({
        executionId,
        ownerId,
        [jarvisTerminalHandoffReceiptBrand]: true as const,
      }),
    );
    const createAcceptor = vi.fn(() => ({ acceptIssuedExecution }));
    const transferTerminalOwnership = vi.fn(({ executionId, acceptor }) => ({
      kind: 'committed' as const,
      value: acceptor.acceptIssuedExecution({
        executionId,
        ownerId: 'approval:jappr_run',
        execution: owned,
      }),
    }));
    const dispatcher = createJarvisTerminalRegisteredActionDispatcher({
      newExecutionId: () => 'jterm_run',
      newCancellationToken: () => 'jcancel_native_run',
      createAcceptor,
    });

    const outcome = await dispatcher({
      registration: {
        id: 'terminal.run',
        version: 1,
        executor: { kind: 'builtin', registryActionId: 'terminal.run' },
      } as never,
      params: {
        command: "Write-Output 'VibeSpace kernel terminal fixture'; exit",
        label: 'Kernel smoke fixture',
        cwd: 'C:\\work',
        timeoutMs: 15_000,
      },
      context: {
        source: 'ai',
        accountId: 'account-a',
        runId: 'jrun_run',
        approvalId: 'jappr_run',
        requestId: 'request-run',
        attemptNumber: 1,
      },
      execution: {
        producerKind: 'terminal',
        ownerId: 'approval:jappr_run',
        [jarvisIssuedActionExecutionBrand]: true,
        transferTerminalOwnership,
      } as never,
    });

    expect(createAcceptor).toHaveBeenCalledWith({
      accountId: 'account-a',
      runId: 'jrun_run',
      executionId: 'jterm_run',
      cancellationToken: 'jcancel_native_run',
      command: "Write-Output 'VibeSpace kernel terminal fixture'; exit",
      label: 'Kernel smoke fixture',
      cwd: 'C:\\work',
      timeoutMs: 15_000,
    });
    expect(outcome).toMatchObject({
      kind: 'terminal_handoff_accepted',
      executorKind: 'terminal',
      ownerId: 'approval:jappr_run',
      result: { ok: true, data: { state: 'queued', executionId: 'jterm_run' } },
    });
  });

  it('dispatches protected terminal.start_cli through the canonical pre-published scope', async () => {
    const createAcceptor = vi.fn(() => ({
      acceptIssuedExecution: vi.fn(({ executionId, ownerId }) =>
        Object.freeze({
          executionId,
          ownerId,
          [jarvisTerminalHandoffReceiptBrand]: true as const,
        }),
      ),
    }));
    const transferTerminalOwnership = vi.fn(({ executionId, acceptor }) => ({
      kind: 'committed' as const,
      value: acceptor.acceptIssuedExecution({
        executionId,
        ownerId: 'approval:jappr_start',
        execution: {
          recordResult: vi.fn(),
          recordCancellationVerified: vi.fn(),
          requestCancellation: vi.fn(),
          dispose: vi.fn(),
        },
      }),
    }));
    const dispatcher = createJarvisTerminalRegisteredActionDispatcher({
      newExecutionId: () => 'jterm_start',
      newCancellationToken: () => 'jcancel_native_start',
      resolveProtectedScope: vi.fn(async () => ({
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        isCurrent: () => true,
      })),
      createAcceptor,
    });

    await expect(
      dispatcher({
        registration: {
          id: 'terminal.start_cli',
          version: 1,
          executor: { kind: 'builtin', registryActionId: 'terminal.start_cli' },
        } as never,
        params: { cli: 'opencode', cwd: 'C:\\work', timeoutMs: 120_000 },
        context: {
          source: 'ai',
          accountId: 'account-a',
          runId: 'jrun_start',
          chatId: 'chat-a',
          approvalId: 'jappr_start',
          requestId: 'request-start',
          attemptNumber: 1,
        },
        execution: {
          producerKind: 'terminal',
          ownerId: 'approval:jappr_start',
          [jarvisIssuedActionExecutionBrand]: true,
          transferTerminalOwnership,
        } as never,
      }),
    ).resolves.toMatchObject({ kind: 'terminal_handoff_accepted' });
    expect(createAcceptor).toHaveBeenCalledWith({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      runId: 'jrun_start',
      executionId: 'jterm_start',
      cancellationToken: 'jcancel_native_start',
      command: 'opencode',
      cwd: 'C:\\work',
      timeoutMs: 120_000,
    });
  });

  it('publishes no canonical start when protected scope changes before transfer', async () => {
    const createAcceptor = vi.fn();
    const transferTerminalOwnership = vi.fn();
    const dispatcher = createJarvisTerminalRegisteredActionDispatcher({
      newExecutionId: () => 'jterm_revoked',
      newCancellationToken: () => 'jcancel_native_revoked',
      resolveProtectedScope: vi.fn(async () => ({
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        isCurrent: () => false,
      })),
      createAcceptor,
    });

    await expect(
      dispatcher({
        registration: {
          id: 'terminal.start_cli',
          version: 1,
          executor: { kind: 'builtin', registryActionId: 'terminal.start_cli' },
        } as never,
        params: { cli: 'opencode' },
        context: {
          source: 'ai',
          accountId: 'account-a',
          runId: 'jrun_revoked',
          chatId: 'chat-a',
          approvalId: 'jappr_revoked',
          requestId: 'request-revoked',
          attemptNumber: 1,
        },
        execution: {
          producerKind: 'terminal',
          ownerId: 'approval:jappr_revoked',
          [jarvisIssuedActionExecutionBrand]: true,
          transferTerminalOwnership,
        } as never,
      }),
    ).resolves.toMatchObject({
      kind: 'executor_returned',
      result: { ok: false, error: 'Canonical terminal scope was revoked before handoff.' },
    });
    expect(createAcceptor).not.toHaveBeenCalled();
    expect(transferTerminalOwnership).not.toHaveBeenCalled();
  });

  it('verifies every queued terminal actually reaches a started state', async () => {
    let reads = 0;
    const result = await waitForTerminalExecutions(['one', 'two'], {
      timeoutMs: 100,
      read: () => {
        reads += 1;
        return reads === 1
          ? { one: { status: 'queued' }, two: { status: 'starting' } }
          : {
              one: { status: 'running', sessionId: 's1' },
              two: { status: 'running', sessionId: 's2' },
            };
      },
      sleep: async () => undefined,
      now: (() => {
        let now = 0;
        return () => ++now;
      })(),
    });
    expect(result).toEqual({ ok: true, sessionIds: ['s1', 's2'] });
  });

  it('does not report failed or timed-out terminal launches as complete', async () => {
    await expect(
      waitForTerminalExecutions(['one'], {
        timeoutMs: 100,
        read: () => ({ one: { status: 'failed' } }),
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/failed/i) });

    let now = 0;
    await expect(
      waitForTerminalExecutions(['one'], {
        timeoutMs: 2,
        read: () => ({ one: { status: 'queued' } }),
        sleep: async () => undefined,
        now: () => ++now,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/within/i) });
  });

  it('stops terminal and agent observers when their parent run is cancelled', async () => {
    await expect(
      waitForTerminalExecutions(['one'], {
        timeoutMs: 50,
        read: () => ({ one: { status: 'queued' } }),
        cancelled: () => true,
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });

    await expect(
      waitForAgentBatch(['a'], {
        timeoutMs: 50,
        read: () => ({ a: { status: 'running' } }),
        cancelled: () => true,
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });
  });

  it('routes canonical observer cleanup through Task 18 and never tokenless native kill', async () => {
    const requestCanonical = vi.fn(async () => null);
    const cancelQueued = vi.fn(() => false);
    const killManual = vi.fn(async () => undefined);
    const markLegacyFailed = vi.fn();

    await cancelTerminalExecutionsAfterObserverCancellation(['jterm_1'], {
      isCanonical: () => true,
      requestCanonical,
      cancelQueued,
      readSessionId: () => 'pty_1',
      killManual,
      markLegacyFailed,
    });

    expect(requestCanonical).toHaveBeenCalledWith('jterm_1');
    expect(cancelQueued).not.toHaveBeenCalled();
    expect(killManual).not.toHaveBeenCalled();
    expect(markLegacyFailed).not.toHaveBeenCalled();
  });

  it('validates bounded multi-agent task batches and observes completion', async () => {
    expect(
      parseAgentBatch(
        JSON.stringify([
          { task: 'Inspect chat files only.' },
          { task: 'Inspect terminal files only.' },
        ]),
      ),
    ).toEqual([{ task: 'Inspect chat files only.' }, { task: 'Inspect terminal files only.' }]);
    expect(parseAgentBatch(JSON.stringify([{ task: '' }]))).toBeNull();

    const result = await waitForAgentBatch(['a', 'b'], {
      timeoutMs: 50,
      read: () => ({
        a: { status: 'done', summary: 'Chat inspected.' },
        b: { status: 'done', summary: 'Terminals inspected.' },
      }),
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual({ ok: true, summaries: ['Chat inspected.', 'Terminals inspected.'] });
  });

  it('surfaces blocked child agents instead of claiming batch completion', async () => {
    await expect(
      waitForAgentBatch(['a'], {
        timeoutMs: 50,
        read: () => ({ a: { status: 'blocked', error: 'Needs a decision.' } }),
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).resolves.toEqual({ ok: false, error: 'Agent a is blocked: Needs a decision.' });
  });
});

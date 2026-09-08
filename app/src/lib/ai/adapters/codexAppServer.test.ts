import { parseJarvisPlanBlocks } from '@/features/jarvis-interaction/planParser';
import { describe, expect, it } from 'vitest';

import {
  normalizeCodexAppServerMessage as normalizeRawCodexAppServerMessage,
  normalizeCodexThreadBindingResponse,
} from './codexAppServer';

const ACTIVE_SCOPE = {
  activeGeneration: 2,
  messageGeneration: 2,
  threadId: 'thr_123',
  turnId: 'turn_1',
} as const;

function normalizeCodexAppServerMessage(
  value: unknown,
  options: Readonly<{ capturedAt?: number }> = {},
) {
  return normalizeRawCodexAppServerMessage(value, { ...options, scope: ACTIVE_SCOPE });
}

describe('Codex app-server structured event normalization', () => {
  it('binds only the matching start response and streams scoped public content', () => {
    expect(
      normalizeCodexThreadBindingResponse(
        { id: 'start_1', result: { thread: { id: 'thr_123' } } },
        'start_1',
      ),
    ).toEqual({
      recognized: true,
      events: [{ type: 'session', sessionId: 'thr_123' }],
      controls: [],
    });
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'item_1',
          delta: '\u001b[31mHello\u001b[0m',
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'text', delta: 'Hello', streamPartId: 'item_1' }],
      controls: [],
    });
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'reason_1',
          delta: 'Inspecting safely.',
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'reasoning', delta: 'Inspecting safely.' }],
      controls: [],
    });
  });

  it('drops stale-generation, cross-thread, and private-reasoning notifications', () => {
    const text = {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thr_other', turnId: 'turn_1', itemId: 'item_1', delta: 'wrong' },
    };
    expect(normalizeRawCodexAppServerMessage(text, { scope: ACTIVE_SCOPE })).toEqual({
      recognized: true,
      events: [],
      controls: [],
    });
    expect(
      normalizeRawCodexAppServerMessage(
        { ...text, params: { ...text.params, threadId: 'thr_123' } },
        { scope: { ...ACTIVE_SCOPE, messageGeneration: 1 } },
      ),
    ).toEqual({ recognized: true, events: [], controls: [] });
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/reasoning/textDelta',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'reason_1',
          delta: 'private chain of thought',
        },
      }),
    ).toEqual({ recognized: true, events: [], controls: [] });
  });

  it('fails closed for scoped turn events until an exact turn is bound', () => {
    const unboundScope = { ...ACTIVE_SCOPE, turnId: undefined };
    expect(
      normalizeRawCodexAppServerMessage(
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_123',
            turnId: 'turn_1',
            itemId: 'item_1',
            delta: 'must not project before binding',
          },
        },
        { scope: unboundScope },
      ),
    ).toEqual({ recognized: true, events: [], controls: [] });

    expect(
      normalizeRawCodexAppServerMessage(
        {
          method: 'serverRequest/resolved',
          params: { threadId: 'thr_123', requestId: 'approval_1' },
        },
        { scope: unboundScope },
      ),
    ).toEqual({
      recognized: true,
      events: [],
      controls: [{ type: 'resolved', requestId: 'approval_1' }],
    });
  });

  it('emits a typed binding control for the exact turn-start notification', () => {
    expect(
      normalizeRawCodexAppServerMessage(
        {
          method: 'turn/started',
          params: {
            threadId: 'thr_123',
            turn: {
              id: 'turn_1',
              items: [],
              itemsView: 'notLoaded',
              status: 'inProgress',
              error: null,
              startedAt: 100,
              completedAt: null,
              durationMs: null,
            },
          },
        },
        { scope: { ...ACTIVE_SCOPE, turnId: undefined } },
      ),
    ).toEqual({
      recognized: true,
      events: [],
      controls: [{ type: 'turn_binding', threadId: 'thr_123', turnId: 'turn_1' }],
    });
  });

  it('drops a stale turn after the active turn is bound', () => {
    expect(
      normalizeRawCodexAppServerMessage(
        {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_123',
            turnId: 'turn_stale',
            itemId: 'item_stale',
            delta: 'stale',
          },
        },
        { scope: ACTIVE_SCOPE },
      ),
    ).toEqual({ recognized: true, events: [], controls: [] });
  });

  it('does not append a completed reasoning snapshot after streamed summary deltas', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'reason_1',
          delta: 'Inspecting safely.',
          summaryIndex: 0,
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'reasoning', delta: 'Inspecting safely.' }],
      controls: [],
    });

    expect(
      normalizeCodexAppServerMessage({
        method: 'item/completed',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          completedAtMs: 200,
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: ['Inspecting safely.'],
            content: ['private chain of thought'],
          },
        },
      }),
    ).toEqual({ recognized: true, events: [], controls: [] });
  });

  it('projects command activity without persisting output, commands, paths, or secrets', () => {
    const result = normalizeCodexAppServerMessage({
      method: 'item/completed',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        completedAtMs: 200,
        item: {
          type: 'commandExecution',
          id: 'call_1',
          command: 'Get-Content C:\\private\\game.ts',
          cwd: 'C:\\private',
          processId: null,
          source: 'agent',
          status: 'completed',
          pluginId: null,
          scriptPath: null,
          commandActions: [{ type: 'read', name: 'Read game.ts', path: 'C:\\private\\game.ts' }],
          aggregatedOutput:
            'ok C:\\Users\\viper api_key="sk-private-value" restricted file contents',
          exitCode: 0,
          durationMs: 12,
        },
      },
    });
    expect(result).toEqual({
      recognized: true,
      events: [
        {
          type: 'tool',
          name: 'read',
          status: 'completed',
          callId: 'call_1',
          fileLabel: 'game.ts',
          result: { exitCode: 0, durationMs: 12, outputAvailable: true },
        },
      ],
      controls: [],
    });
    const persisted = JSON.stringify(result);
    for (const secret of [
      'C:\\private',
      'Get-Content',
      'sk-private-value',
      'restricted file contents',
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it('projects file edits without exposing absolute paths or raw diffs', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/started',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          startedAtMs: 100,
          item: {
            type: 'fileChange',
            id: 'edit_1',
            status: 'inProgress',
            changes: [
              {
                path: 'C:\\private\\src\\game.ts',
                kind: 'update',
                diff: '+const apiKey = "secret";',
              },
            ],
          },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [
        {
          type: 'tool',
          name: 'edit',
          status: 'started',
          callId: 'edit_1',
          fileLabel: 'game.ts',
          result: { changeCount: 1, diffAvailable: true },
        },
      ],
      controls: [],
    });
  });

  it('preserves native question IDs and typed approval routing ephemerally', () => {
    const question = normalizeCodexAppServerMessage({
      id: 7,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'question_1',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'q1',
            header: 'Choice',
            question: 'Which safe option?',
            isOther: true,
            isSecret: false,
            options: [{ label: 'A', description: 'Use A' }],
          },
        ],
      },
    });
    expect(question.events).toHaveLength(1);
    expect(question.controls).toMatchObject([
      {
        type: 'question',
        requestId: '7',
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'question_1',
        questions: [{ id: 'q1' }],
      },
    ]);

    const approval = normalizeCodexAppServerMessage({
      id: 'approval_1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'call_1',
        kind: 'command',
        approvalId: 'native_approval_1',
        reason: 'Needs permission; api_key=TOPSECRET at C:\\private',
        command: 'Get-Content C:\\private\\config.ts | rg TOPSECRET',
        cwd: 'C:\\private',
        commandActions: [
          {
            type: 'read',
            command: 'Get-Content C:\\private\\config.ts',
            name: 'Read config',
            path: 'C:\\private\\config.ts',
          },
          {
            type: 'search',
            command: 'rg TOPSECRET C:\\private\\src',
            query: 'TOPSECRET',
            path: 'C:\\private\\src',
          },
        ],
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['C:\\private\\read-one'],
            write: ['C:\\private\\write-one'],
            entries: [{}, {}],
          },
        },
        availableDecisions: [
          'accept',
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: 'TOPSECRET' } },
          'acceptForSession',
          'decline',
          'cancel',
          'unexpected',
        ],
        startedAtMs: 150,
      },
    });
    expect(approval).toEqual({
      recognized: true,
      events: [],
      controls: [
        {
          type: 'approval',
          kind: 'command',
          requestId: 'approval_1',
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'call_1',
          responseHandle: 'approval_1',
          requestMethod: 'item/commandExecution/requestApproval',
          responseKind: 'command',
          nativeApprovalId: 'native_approval_1',
          display: {
            reason: 'Needs permission; api_key=[redacted] at [path]',
            action: 'command',
            commandPreview: 'Read config.ts; Search src',
            cwdLabel: 'private',
            fileLabels: ['config.ts', 'src'],
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
            requestedPermissions: {
              networkRequested: true,
              fileSystemReadCount: 1,
              fileSystemWriteCount: 1,
              fileSystemEntryCount: 2,
            },
          },
        },
      ],
    });
    const serializedApproval = JSON.stringify(approval);
    for (const privateValue of ['Get-Content', 'TOPSECRET', 'C:\\private']) {
      expect(serializedApproval).not.toContain(privateValue);
    }
  });

  it('summarizes permission requests without exposing requested paths', () => {
    const approval = normalizeCodexAppServerMessage({
      id: 'permissions_1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'permission_call_1',
        environmentId: 'env_1',
        startedAtMs: 175,
        cwd: 'C:\\private\\workspace',
        reason: 'Allow the requested workspace access.',
        permissions: {
          network: { enabled: false },
          fileSystem: {
            read: ['C:\\private\\one', 'C:\\private\\two'],
            write: ['C:\\private\\three'],
            entries: [{}],
          },
        },
      },
    });

    expect(approval).toEqual({
      recognized: true,
      events: [],
      controls: [
        {
          type: 'approval',
          kind: 'permissions',
          requestId: 'permissions_1',
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'permission_call_1',
          responseHandle: 'permissions_1',
          requestMethod: 'item/permissions/requestApproval',
          responseKind: 'permissions',
          display: {
            reason: 'Allow the requested workspace access.',
            action: 'permissions',
            cwdLabel: 'workspace',
            requestedPermissions: {
              networkRequested: false,
              fileSystemReadCount: 2,
              fileSystemWriteCount: 1,
              fileSystemEntryCount: 1,
            },
          },
        },
      ],
    });
    expect(JSON.stringify(approval)).not.toContain('C:\\private');
  });

  it('keeps unparsed command approvals informative without exposing paths or secrets', () => {
    const approval = normalizeCodexAppServerMessage({
      id: 'approval_unknown',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'call_unknown',
        kind: 'command',
        command: '/usr/bin/python /home/viper/private/build.py --token=secret-value-123 --check',
        commandActions: [
          {
            type: 'unknown',
            command:
              '/usr/bin/python /home/viper/private/build.py --token=secret-value-123 --check',
          },
        ],
        availableDecisions: ['accept', 'decline'],
      },
    });

    const serialized = JSON.stringify(approval);
    expect(approval.controls[0]).toMatchObject({
      type: 'approval',
      responseHandle: 'approval_unknown',
      display: { availableDecisions: ['accept', 'decline'] },
    });
    expect(
      (approval.controls[0] as { display?: { commandPreview?: string } }).display?.commandPreview,
    ).not.toBe('Run command');
    expect(serialized).toContain('[path]');
    expect(serialized).toContain('token=[redacted]');
    expect(serialized).not.toContain('/home/viper');
    expect(serialized).not.toContain('secret-value-123');
  });

  it('keeps secret questions on a non-durable secure control path', () => {
    expect(
      normalizeCodexAppServerMessage({
        id: 8,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'question_2',
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: 'q2',
              header: 'Secret',
              question: 'Enter a key',
              isOther: false,
              isSecret: true,
              options: null,
            },
          ],
        },
      }),
    ).toEqual({
      recognized: true,
      events: [
        {
          type: 'warning',
          message: 'Codex requested secret input. Use the secure credential setup action.',
        },
      ],
      controls: [
        {
          type: 'secure_question',
          requestId: '8',
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'question_2',
          questionIds: ['q2'],
        },
      ],
    });
  });

  it('projects provider-reported usage and truthful completion', () => {
    expect(
      normalizeCodexAppServerMessage(
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thr_123',
            turnId: 'turn_1',
            tokenUsage: {
              last: {
                inputTokens: 10,
                cachedInputTokens: 2,
                cacheWriteInputTokens: 1,
                outputTokens: 5,
                reasoningOutputTokens: 3,
                totalTokens: 15,
              },
            },
          },
        },
        { capturedAt: 500 },
      ),
    ).toMatchObject({
      events: [
        {
          type: 'usage',
          usage: {
            capturedAt: 500,
            inputTokens: { value: 10, provenance: 'provider-reported' },
            outputTokens: { value: 5, provenance: 'provider-reported' },
            totalTokens: { value: 15, provenance: 'provider-reported' },
          },
        },
      ],
    });
    expect(
      normalizeCodexAppServerMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_123',
          turn: { id: 'turn_1', status: 'completed', error: null },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'done', finishReason: 'completed' }],
      controls: [],
    });
  });

  it('keeps retryable errors nonterminal and reads the structured error field', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'error',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          willRetry: true,
          error: { message: 'Temporary upstream failure' },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'warning', message: 'Temporary upstream failure' }],
      controls: [],
    });
  });

  it('waits for turn completion after a non-retryable error notification', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'error',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          willRetry: false,
          error: { message: 'Permanent upstream failure' },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'warning', message: 'Permanent upstream failure' }],
      controls: [],
    });

    expect(
      normalizeCodexAppServerMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_123',
          turn: {
            id: 'turn_1',
            status: 'failed',
            error: { message: 'Permanent upstream failure' },
          },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'error', message: 'Permanent upstream failure' }],
      controls: [],
    });
  });

  it('reconciles completed text and keeps Plan streaming on a typed control path', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/completed',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          completedAtMs: 200,
          item: { type: 'agentMessage', id: 'message_1', text: 'Authoritative final text' },
        },
      }),
    ).toEqual({
      recognized: true,
      events: [
        {
          type: 'text',
          delta: 'Authoritative final text',
          mode: 'replace',
          streamPartId: 'message_1',
        },
      ],
      controls: [],
    });
    expect(
      normalizeCodexAppServerMessage({
        method: 'item/plan/delta',
        params: {
          threadId: 'thr_123',
          turnId: 'turn_1',
          itemId: 'plan_1',
          delta: '1. Inspect\n',
        },
      }),
    ).toEqual({
      recognized: true,
      events: [{ type: 'text', delta: '1. Inspect\n', streamPartId: 'plan_1' }],
      controls: [{ type: 'plan_delta', itemId: 'plan_1', delta: '1. Inspect\n' }],
    });
  });

  it('clears resolved controls and leaves unknown records unrecognized', () => {
    expect(
      normalizeCodexAppServerMessage({
        method: 'serverRequest/resolved',
        params: { threadId: 'thr_123', requestId: 'approval_1' },
      }),
    ).toEqual({
      recognized: true,
      events: [],
      controls: [{ type: 'resolved', requestId: 'approval_1' }],
    });
    expect(normalizeCodexAppServerMessage({ method: 'future/event', params: {} })).toEqual({
      recognized: false,
      events: [],
      controls: [],
    });
  });
});

it('projects native Codex child identity and running state without copying its prompt', () => {
  const value = normalizeCodexAppServerMessage({ method: 'item/completed', params: {
    threadId: 'thr_123', turnId: 'turn_1', item: { id: 'spawn-1', type: 'collabAgentToolCall',
      tool: 'spawnAgent', status: 'completed', senderThreadId: 'thr_123', receiverThreadIds: ['child_1'],
      agentsStates: { child_1: { status: 'running' } }, prompt: 'Private task instructions', model: 'gpt-5.4-mini' },
  } });
  expect(value.events).toEqual([expect.objectContaining({ type: 'tool', name: 'task', status: 'completed',
    nativeTask: { name: 'Codex agent', sessionId: 'child_1', status: 'running', currentStep: 'spawnAgent', modelLabel: 'gpt-5.4-mini' } })]);
  expect(JSON.stringify(value)).not.toContain('Private task instructions');
});

it('projects completed native plans into the existing approval contract', () => {
  const result = normalizeCodexAppServerMessage({
    method: 'item/completed',
    params: { threadId: 'thr_123', turnId: 'turn_1',
      item: { type: 'plan', id: 'plan_1', text: 'Create the acceptance marker file.\nWrite exactly \"ALPHA\".' } },
  });
  const event = result.events[0];
  expect(event).toMatchObject({ type: 'text', mode: 'replace', streamPartId: 'plan_1' });
  if (event.type !== 'text') throw new Error('Expected public plan');
  const parsed = parseJarvisPlanBlocks(event.delta);
  expect(parsed.hasPlanBlocks).toBe(true);
  expect(parsed.parts).toEqual([expect.objectContaining({ kind: 'plan_review', plan: expect.objectContaining({
    id: 'codex_plan_plan_1', summary: 'Create the acceptance marker file.\nWrite exactly \"ALPHA\".', status: 'pending',
  }) })]);
  expect(result.controls).toEqual([{ type: 'plan_snapshot', itemId: 'plan_1', text: 'Create the acceptance marker file.\nWrite exactly \"ALPHA\".' }]);
});

it('preserves code fences inside native plan reviews', () => {
  const text = 'Create a file:\n```sh\necho ALPHA\n```';
  const event = normalizeCodexAppServerMessage({ method: 'item/completed', params: {
    threadId: 'thr_123', turnId: 'turn_1', item: { type: 'plan', id: 'plan_code', text },
  } }).events[0];
  if (event.type !== 'text') throw new Error('Expected public plan');
  const parsed = parseJarvisPlanBlocks(event.delta);
  expect(parsed.parts).toHaveLength(1);
  expect(parsed.parts[0]).toMatchObject({ kind: 'plan_review', plan: { summary: text, status: 'pending' } });
});

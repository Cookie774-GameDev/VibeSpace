import { describe, expect, it } from 'vitest';

import {
  buildCodexApprovalResponse,
  buildCodexModelListRequest,
  summarizeCodexModelValidation,
  buildCodexQuestionResponse,
  buildCodexSkillsListRequest,
  buildCodexSkillsRefreshRequest,
  buildCodexSkillUserInputs,
  buildCodexThreadResumeRequest,
  buildCodexThreadStartRequest,
  buildCodexThreadQueueAddRequest,
  buildCodexThreadQueueListRequest,
  buildCodexThreadQueueStartRequest,
  buildCodexThreadReadRequest,
  buildCodexTurnSteerRequest,
  buildCodexTurnInterruptRequest,
  buildCodexTurnStartRequest,
  validateCodexModelListResponse,
  validateCodexSkillsListResponse,
  isCodexSkillsChangedNotification,
  validateCodexThreadStartResponse,
  validateCodexThreadQueueAddResponse,
  validateCodexThreadQueueListResponse,
  validateCodexThreadQueueStartResponse,
  validateCodexTurnSteerResponse,
  type CodexBackendIdentity,
  type CodexDiscoveredSkill,
  type CodexExecutionMode,
} from './codexAppServerProtocol';

const IDENTITY: CodexBackendIdentity = {
  modelProvider: 'opencodex-vibespace',
  model: 'gpt-5.6-sol',
  effort: 'high',
  serviceTier: 'fast',
  cwd: 'C:\\workspace\\game',
};

describe('Codex app-server request protocol', () => {
  const nativeAppPolicy = { apps: false, remote_plugin: false };
  const policyModes: CodexExecutionMode[] = [
    { kind: 'ask' },
    { kind: 'plan' },
    { kind: 'agent', approvalPolicy: 'on-request', sandbox: {
      kind: 'workspace-write', writableRoots: [IDENTITY.cwd], networkAccess: false,
    } },
    { kind: 'agent', approvalPolicy: 'never', sandbox: { kind: 'danger-full-access' } },
  ];
  for (const mode of policyModes) {
    for (const resume of [false, true]) {
      it(`denies inherited native apps for ${mode.kind}/${mode.kind === 'agent' ? mode.sandbox.kind : 'read-only'} ${resume ? 'resume' : 'start'} while preserving scope`, () => {
        const input = { requestId: 'policy', identity: IDENTITY, mode };
        const request = resume
          ? buildCodexThreadResumeRequest({ ...input, threadId: 'policy-thread' })
          : buildCodexThreadStartRequest(input);
        expect(request.params.config?.features).toEqual(nativeAppPolicy);
        expect(request.params).toMatchObject({
          model: IDENTITY.model, modelProvider: IDENTITY.modelProvider,
          cwd: IDENTITY.cwd, serviceTier: 'priority', approvalsReviewer: 'user',
          approvalPolicy: mode.kind === 'agent' ? mode.approvalPolicy : 'never',
          sandbox: mode.kind === 'agent' ? mode.sandbox.kind : 'read-only',
          config: { model_reasoning_effort: IDENTITY.effort },
        });
        if (mode.kind === 'agent' && mode.sandbox.kind === 'workspace-write') {
          expect(request.params.config?.sandbox_workspace_write).toMatchObject({
            writable_roots: [IDENTITY.cwd], network_access: false,
          });
        }
      });
    }
  }

  it('preserves the exact authorized VibeSpace dynamic tool manifest', () => {
    const dynamicTools = ['vibespace_context', 'command_list', 'mcp_list', 'mcp_run'].map(name => ({
      type: 'function' as const, name, description: 'Scoped fixture',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }));
    const request = buildCodexThreadStartRequest({
      requestId: 'manifest', identity: IDENTITY, mode: { kind: 'ask' }, dynamicTools,
    });
    expect(request.params.dynamicTools).toEqual(dynamicTools);
    expect(request.params.config?.features).toEqual(nativeAppPolicy);
  });

  it('forwards native app denial with provider-default effort on start and resume', () => {
    const input = { requestId: 'default-effort', identity: { ...IDENTITY, effort: null }, mode: { kind: 'ask' as const } };
    expect(buildCodexThreadStartRequest(input).params.config).toEqual({ features: nativeAppPolicy });
    expect(buildCodexThreadResumeRequest({ ...input, threadId: 'thread' }).params.config).toEqual({ features: nativeAppPolicy });
  });

  it('does not add credential or provider overrides to the native app policy', () => {
    const request = buildCodexThreadStartRequest({
      requestId: 'credential-policy', identity: { ...IDENTITY, effort: null }, mode: { kind: 'ask' },
    });
    expect(Object.keys(request.params.config ?? {})).toEqual(['features']);
    expect(request.params.modelProvider).toBe(IDENTITY.modelProvider);
  });

  it('accepts Codex implicit cwd write access and default tier without accepting extra roots', () => {
    const identity = { ...IDENTITY, serviceTier: null };
    const mode = {
      kind: 'agent' as const,
      approvalPolicy: 'on-request' as const,
      sandbox: {
        kind: 'workspace-write' as const,
        writableRoots: [IDENTITY.cwd],
        networkAccess: false,
      },
    };
    const response = {
      id: 'start',
      result: {
        thread: { id: 'thread' },
        model: identity.model,
        modelProvider: identity.modelProvider,
        cwd: identity.cwd,
        serviceTier: 'default',
        reasoningEffort: identity.effort,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [] as string[],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
    };
    expect(validateCodexThreadStartResponse(response, 'start', identity, mode).ok).toBe(true);
    response.result.sandbox.writableRoots = ['C:\\unrequested'];
    expect(validateCodexThreadStartResponse(response, 'start', identity, mode)).toMatchObject({
      ok: false,
      field: 'sandbox',
    });
  });

  it('accepts multiline system and user prompts but rejects unsafe control bytes', () => {
    const input = {
      requestId: 'turn',
      threadId: 'thread',
      clientUserMessageId: 'message',
      identity: IDENTITY,
      mode: { kind: 'ask' as const },
      text: 'System instructions.\n\nUser:\r\n\tHello',
    };
    expect(buildCodexTurnStartRequest(input).params.input[0]).toMatchObject({
      type: 'text',
      text: input.text,
    });
    expect(() => buildCodexTurnStartRequest({ ...input, text: 'hello\u0000world' })).toThrow(
      'text',
    );
  });

  it('respects a native read-only restriction on an untrusted Agent workspace', () => {
    const response = {
      id: 'start',
      result: {
        thread: { id: 'thread' },
        model: IDENTITY.model,
        modelProvider: IDENTITY.modelProvider,
        cwd: IDENTITY.cwd,
        serviceTier: 'priority',
        reasoningEffort: 'high',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
      },
    };
    const mode = {
      kind: 'agent' as const,
      approvalPolicy: 'on-request' as const,
      sandbox: {
        kind: 'workspace-write' as const,
        writableRoots: [IDENTITY.cwd],
        networkAccess: false,
      },
    };
    expect(validateCodexThreadStartResponse(response, 'start', IDENTITY, mode).ok).toBe(true);
    response.result.sandbox.networkAccess = true;
    expect(validateCodexThreadStartResponse(response, 'start', IDENTITY, mode)).toMatchObject({
      ok: false,
      field: 'sandbox',
    });
  });

  it('accepts omitted optional tiers for standard speed but still rejects unsupported fast mode', () => {
    const response = {
      id: 'models',
      result: {
        data: [{ model: IDENTITY.model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
        nextCursor: null,
      },
    };
    expect(
      validateCodexModelListResponse(response, 'models', { ...IDENTITY, serviceTier: null }).ok,
    ).toBe(true);
    expect(validateCodexModelListResponse(response, 'models', IDENTITY)).toMatchObject({
      ok: false,
      field: 'serviceTier',
    });
  });

  it('lets Auto use the server effort while validating explicit effort', () => {
    const response = {
      id: 'start',
      result: {
        thread: { id: 'thread' },
        model: IDENTITY.model,
        modelProvider: IDENTITY.modelProvider,
        cwd: IDENTITY.cwd,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: 'medium',
      },
    };
    expect(
      validateCodexThreadStartResponse(
        response,
        'start',
        {
          ...IDENTITY,
          effort: null,
          serviceTier: null,
        },
        { kind: 'ask' },
      ).ok,
    ).toBe(true);
    expect(
      validateCodexThreadStartResponse(
        response,
        'start',
        {
          ...IDENTITY,
          serviceTier: null,
        },
        { kind: 'ask' },
      ),
    ).toMatchObject({ ok: false, field: 'reasoningEffort' });
  });

  it('starts and resumes with the same explicitly restricted writable roots as the turn', () => {
    const input = {
      requestId: 'start',
      identity: IDENTITY,
      mode: {
        kind: 'agent' as const,
        approvalPolicy: 'on-request' as const,
        sandbox: {
          kind: 'workspace-write' as const,
          writableRoots: [IDENTITY.cwd],
          networkAccess: false,
        },
      },
    };
    const expected = {
      writable_roots: [IDENTITY.cwd],
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    };
    expect(buildCodexThreadStartRequest(input).params.config?.sandbox_workspace_write).toEqual(
      expected,
    );
    expect(
      buildCodexThreadResumeRequest({ ...input, threadId: 'thread' }).params.config
        ?.sandbox_workspace_write,
    ).toEqual(expected);
  });

  it('starts an Ask thread with exact backend identity and no prompt or credential override', () => {
    const request = buildCodexThreadStartRequest({
      requestId: 'start_1',
      identity: IDENTITY,
      mode: { kind: 'ask' },
    });

    expect(request).toEqual({
      id: 'start_1',
      method: 'thread/start',
      params: {
        model: 'gpt-5.6-sol',
        modelProvider: 'opencodex-vibespace',
        serviceTier: 'priority',
        cwd: 'C:\\workspace\\game',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        config: { features: { apps: false, remote_plugin: false }, model_reasoning_effort: 'high' },
        ephemeral: false,
        threadSource: 'vibespace',
      },
    });
    const persisted = JSON.stringify(request);
    for (const forbidden of [
      'baseInstructions',
      'developerInstructions',
      'personality',
      'apiKey',
      'credential',
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
  });

  it('starts an Agent turn with only the explicitly authorized approval and sandbox profile', () => {
    expect(
      buildCodexTurnStartRequest({
        requestId: 'turn_request_1',
        threadId: 'thread_1',
        clientUserMessageId: 'message_1',
        text: 'Build the requested game.',
        identity: IDENTITY,
        mode: {
          kind: 'agent',
          approvalPolicy: 'on-request',
          sandbox: {
            kind: 'workspace-write',
            writableRoots: ['C:\\workspace\\game'],
            networkAccess: false,
          },
        },
      }),
    ).toEqual({
      id: 'turn_request_1',
      method: 'turn/start',
      params: {
        threadId: 'thread_1',
        clientUserMessageId: 'message_1',
        input: [{ type: 'text', text: 'Build the requested game.', text_elements: [] }],
        turnTrigger: 'user',
        cwd: 'C:\\workspace\\game',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['C:\\workspace\\game'],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        model: 'gpt-5.6-sol',
        serviceTierForTurn: 'priority',
        effort: 'high',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.6-sol',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
        summary: 'concise',
      },
    });
  });

  it.each(['ask', 'plan'] as const)(
    'keeps %s turns read-only without an approval escape',
    (kind) => {
      const request = buildCodexTurnStartRequest({
        requestId: `turn_${kind}`,
        threadId: 'thread_1',
        clientUserMessageId: `message_${kind}`,
        text: `Run in ${kind} mode.`,
        identity: IDENTITY,
        mode: { kind },
      });
      expect(request.params.approvalPolicy).toBe('never');
      expect(request.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
      expect(request.params).toHaveProperty('collaborationMode', {
        mode: kind === 'plan' ? 'plan' : 'default',
        settings: {
          model: IDENTITY.model,
          reasoning_effort: IDENTITY.effort,
          developer_instructions: null,
        },
      });
    },
  );

  it('resumes only by immutable thread id while reasserting the exact identity', () => {
    expect(
      buildCodexThreadResumeRequest({
        requestId: 'resume_1',
        threadId: 'thread_1',
        identity: IDENTITY,
        mode: { kind: 'plan' },
      }),
    ).toEqual({
      id: 'resume_1',
      method: 'thread/resume',
      params: {
        threadId: 'thread_1',
        model: 'gpt-5.6-sol',
        modelProvider: 'opencodex-vibespace',
        serviceTier: 'priority',
        cwd: 'C:\\workspace\\game',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        config: { features: { apps: false, remote_plugin: false }, model_reasoning_effort: 'high' },
        excludeTurns: true,
      },
    });
  });

  it('accepts only an exact observed thread identity and reports mismatches without values', () => {
    const response = {
      id: 'start_1',
      result: {
        thread: { id: 'thread_1' },
        model: 'gpt-5.6-sol',
        modelProvider: 'opencodex-vibespace',
        serviceTier: 'priority',
        cwd: 'C:\\workspace\\game',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: 'high',
      },
    };
    expect(
      validateCodexThreadStartResponse(response, 'start_1', IDENTITY, { kind: 'ask' }),
    ).toEqual({ ok: true, threadId: 'thread_1' });

    for (const cwd of ['C:/workspace/game', 'C:/workspace/game/']) {
      expect(validateCodexThreadStartResponse(
        { ...response, result: { ...response.result, cwd } },
        'start_1', IDENTITY, { kind: 'ask' },
      )).toEqual({ ok: true, threadId: 'thread_1' });
    }
    for (const cwd of ['D:/workspace/game', 'C:/workspace/game-other', 'C:/workspace/game/../other']) {
      expect(validateCodexThreadStartResponse(
        { ...response, result: { ...response.result, cwd } },
        'start_1', IDENTITY, { kind: 'ask' },
      )).toEqual({ ok: false, reason: 'identity_mismatch', field: 'cwd' });
    }

    expect(validateCodexThreadStartResponse(
      { ...response, result: { ...response.result, cwd: 'C:' } },
      'start_1', { ...IDENTITY, cwd: 'C:/' }, { kind: 'ask' },
    )).toEqual({ ok: false, reason: 'identity_mismatch', field: 'cwd' });

    const mismatch = validateCodexThreadStartResponse(
      { ...response, result: { ...response.result, model: 'wrong-secret-model' } },
      'start_1',
      IDENTITY,
      { kind: 'ask' },
    );
    expect(mismatch).toEqual({ ok: false, reason: 'identity_mismatch', field: 'model' });
    expect(JSON.stringify(mismatch)).not.toContain('wrong-secret-model');

    expect(
      validateCodexThreadStartResponse(
        {
          ...response,
          result: { ...response.result, sandbox: { type: 'readOnly', networkAccess: true } },
        },
        'start_1',
        IDENTITY,
        { kind: 'ask' },
      ),
    ).toEqual({ ok: false, reason: 'identity_mismatch', field: 'sandbox' });
  });

  it('rejects relative paths, unsafe identifiers, empty prompts, and duplicate write roots', () => {
    expect(() =>
      buildCodexThreadStartRequest({
        requestId: 'start_1',
        identity: { ...IDENTITY, cwd: 'relative\\path' },
        mode: { kind: 'ask' },
      }),
    ).toThrow(/absolute/iu);
    expect(() =>
      buildCodexTurnStartRequest({
        requestId: 'turn_1\n',
        threadId: 'thread_1',
        clientUserMessageId: 'message_1',
        text: 'hello',
        identity: IDENTITY,
        mode: { kind: 'ask' },
      }),
    ).toThrow(/identifier/iu);
    expect(() =>
      buildCodexTurnStartRequest({
        requestId: 'turn_1',
        threadId: 'thread_1',
        clientUserMessageId: 'message_1',
        text: '',
        identity: IDENTITY,
        mode: { kind: 'ask' },
      }),
    ).toThrow(/text/iu);
    expect(() =>
      buildCodexTurnStartRequest({
        requestId: 'turn_1',
        threadId: 'thread_1',
        clientUserMessageId: 'message_1',
        text: 'hello',
        identity: IDENTITY,
        mode: {
          kind: 'agent',
          approvalPolicy: 'never',
          sandbox: {
            kind: 'workspace-write',
            writableRoots: ['C:\\workspace\\game', 'C:\\workspace\\game'],
            networkAccess: false,
          },
        },
      }),
    ).toThrow(/writable root/iu);
  });

  it('answers only an explicitly offered simple approval and never lets Ask or Plan accept', () => {
    expect(
      buildCodexApprovalResponse({
        responseHandle: 'approval_1',
        kind: 'command',
        decision: 'accept',
        availableDecisions: ['accept', 'decline'],
        mode: {
          kind: 'agent',
          approvalPolicy: 'on-request',
          sandbox: {
            kind: 'workspace-write',
            writableRoots: ['C:\\workspace\\game'],
            networkAccess: false,
          },
        },
      }),
    ).toEqual({ id: 'approval_1', result: { decision: 'accept' } });

    expect(() =>
      buildCodexApprovalResponse({
        responseHandle: 'approval_1',
        kind: 'file_change',
        decision: 'accept',
        availableDecisions: ['accept', 'decline'],
        mode: { kind: 'plan' },
      }),
    ).toThrow(/read-only/iu);
    expect(() =>
      buildCodexApprovalResponse({
        responseHandle: 'approval_1',
        kind: 'command',
        decision: 'acceptForSession',
        availableDecisions: ['accept', 'decline'],
        mode: {
          kind: 'agent',
          approvalPolicy: 'on-request',
          sandbox: { kind: 'danger-full-access' },
        },
      }),
    ).toThrow(/offered/iu);
  });

  it('answers the exact question set without allowing missing, extra, or control-bearing values', () => {
    expect(
      buildCodexQuestionResponse({
        responseHandle: 'question_1',
        questionIds: ['engine', 'difficulty'],
        answers: {
          engine: ['Three.js'],
          difficulty: ['Hard', 'Adaptive'],
        },
      }),
    ).toEqual({
      id: 'question_1',
      result: {
        answers: {
          engine: { answers: ['Three.js'] },
          difficulty: { answers: ['Hard', 'Adaptive'] },
        },
      },
    });

    expect(() =>
      buildCodexQuestionResponse({
        responseHandle: 'question_1',
        questionIds: ['engine'],
        answers: { engine: ['Three.js'], extra: ['unsafe'] },
      }),
    ).toThrow(/question/iu);
    expect(() =>
      buildCodexQuestionResponse({
        responseHandle: 'question_1',
        questionIds: ['engine'],
        answers: { engine: ['bad\u0000answer'] },
      }),
    ).toThrow(/answer/iu);
  });

  it('builds cancellation only for the exact active thread and turn', () => {
    expect(
      buildCodexTurnInterruptRequest({
        requestId: 'interrupt_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
      }),
    ).toEqual({
      id: 'interrupt_1',
      method: 'turn/interrupt',
      params: { threadId: 'thread_1', turnId: 'turn_1' },
    });
    expect(() =>
      buildCodexTurnInterruptRequest({
        requestId: 'interrupt_1',
        threadId: 'thread_1',
        turnId: 'turn_1\nwrong',
      }),
    ).toThrow(/identifier/iu);
  });

  it('builds native steer against the expected active turn and validates its required identifiers', () => {
    expect(buildCodexTurnSteerRequest({
      requestId: 'steer_1', threadId: 'thread_1', expectedTurnId: 'turn_1',
      clientUserMessageId: 'message_2', text: 'Continue with the focused fix.',
    })).toEqual({
      id: 'steer_1', method: 'turn/steer', params: {
        threadId: 'thread_1', expectedTurnId: 'turn_1', clientUserMessageId: 'message_2',
        input: [{ type: 'text', text: 'Continue with the focused fix.', text_elements: [] }],
      },
    });
    for (const field of ['threadId', 'expectedTurnId', 'clientUserMessageId'] as const) {
      expect(() => buildCodexTurnSteerRequest({
        requestId: 'steer_1', threadId: 'thread_1', expectedTurnId: 'turn_1',
        clientUserMessageId: 'message_2', text: 'Steer', [field]: 'bad\nvalue',
      })).toThrow(/identifier/iu);
    }
    expect(() => buildCodexTurnSteerRequest({
      requestId: 'steer_1', threadId: 'thread_1', expectedTurnId: 'turn_1',
      clientUserMessageId: 'message_2', text: 'bad\u0000text',
    })).toThrow(/text/iu);
    expect(validateCodexTurnSteerResponse({
      id: 'steer_1', result: { turnId: 'turn_1' },
    }, 'steer_1', 'turn_1')).toEqual({ ok: true, turnId: 'turn_1' });
    expect(validateCodexTurnSteerResponse({
      id: 'steer_1', result: { turnId: 'turn_other' },
    }, 'steer_1', 'turn_1')).toMatchObject({ ok: false, reason: 'turn_mismatch' });
  });

  it('builds provider-native queue additions and validates add/list receipts', () => {
    expect(buildCodexThreadReadRequest({ requestId: 'thread_read_1', threadId: 'thread_1' })).toEqual({
      id: 'thread_read_1', method: 'thread/read', params: { threadId: 'thread_1', includeTurns: true },
    });
    expect(buildCodexThreadQueueListRequest({ requestId: 'queue_list_1', threadId: 'thread_1', cursor: 'next/page=' })).toEqual({
      id: 'queue_list_1', method: 'thread/queue/list', params: { threadId: 'thread_1', cursor: 'next/page=' },
    });
    expect(() => buildCodexThreadQueueListRequest({ requestId: 'queue_list_1', threadId: 'thread_1', cursor: 'bad\n' })).toThrow(/cursor/u);
    expect(buildCodexThreadQueueAddRequest({
      requestId: 'queue_add_1', threadId: 'thread_1', clientUserMessageId: 'message_3', text: 'Next task',
    })).toEqual({
      id: 'queue_add_1', method: 'thread/queue/add', params: {
        threadId: 'thread_1', clientUserMessageId: 'message_3',
        input: [{ type: 'text', text: 'Next task', text_elements: [] }],
      },
    });
    expect(validateCodexThreadQueueAddResponse({
      id: 'queue_add_1', result: { queuedSubmission: {
        id: 'submission_1', clientUserMessageId: 'message_3',
        input: [{ type: 'text', text: 'Next task', text_elements: [] }],
      } },
    }, 'queue_add_1', 'message_3')).toMatchObject({ ok: true, submissionId: 'submission_1' });
    expect(validateCodexThreadQueueAddResponse({
      id: 'queue_add_1', result: { queuedSubmission: {
        id: 'submission_1', clientUserMessageId: 'wrong_message', input: [],
      } },
    }, 'queue_add_1', 'message_3')).toMatchObject({ ok: false, reason: 'invalid_response' });
    expect(validateCodexThreadQueueListResponse({
      id: 'queue_list_1', result: { data: [{
        id: 'submission_1', clientUserMessageId: 'message_3', input: [],
      }], nextCursor: null },
    }, 'queue_list_1')).toMatchObject({ ok: true, submissions: [{ id: 'submission_1', clientUserMessageId: 'message_3' }], nextCursor: null });
    expect(validateCodexThreadQueueListResponse({
      id: 'queue_list_1', result: { data: [{ id: 'bad\nidentifier', clientUserMessageId: 'message_3', input: [] }], nextCursor: null },
    }, 'queue_list_1')).toMatchObject({ ok: false, reason: 'invalid_response' });
    expect(validateCodexThreadQueueListResponse({
      id: 'wrong', result: { data: [], nextCursor: null },
    }, 'queue_list_1')).toMatchObject({ ok: false, reason: 'request_mismatch' });
    expect(buildCodexThreadQueueStartRequest({
      requestId: 'queue_start_1', threadId: 'thread_1', queuedSubmissionId: 'submission_1',
    })).toEqual({
      id: 'queue_start_1', method: 'thread/queue/start', params: {
        threadId: 'thread_1', queuedSubmissionId: 'submission_1',
      },
    });
    expect(buildCodexThreadQueueStartRequest({
      requestId: 'queue_start_1', threadId: 'thread_1',
    })).toEqual({
      id: 'queue_start_1', method: 'thread/queue/start', params: { threadId: 'thread_1' },
    });
    expect(validateCodexThreadQueueStartResponse({
      id: 'queue_start_1', result: { turn: { id: 'turn_1', status: 'inProgress' } },
    }, 'queue_start_1')).toMatchObject({ ok: true, turnId: 'turn_1', turnStatus: 'inProgress' });
    expect(validateCodexThreadQueueStartResponse({
      id: 'queue_start_1', result: { turn: { id: 'turn_1', status: 'unknown' } },
    }, 'queue_start_1')).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});

describe('Codex app-server model capability protocol', () => {
  const model = {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses' },
      { reasoningEffort: 'high', description: 'Greater reasoning depth' },
    ],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Increased request priority' }],
  };

  it('summarizes exact model rows without changing their validation outcome', () => {
    const response = { id: 'models_1', result: { data: [model, model], nextCursor: null } };
    expect(validateCodexModelListResponse(response, 'models_1', IDENTITY)).toEqual({
      ok: false, reason: 'invalid_response', field: 'model',
    });
    expect(summarizeCodexModelValidation(response, IDENTITY.model)).toEqual({
      expectedModel: 'gpt-5.6-sol', rowCount: 2, inspectedRows: 2, malformedModelRows: 0,
      matchingModelRows: 2, returnedModels: ['gpt-5.6-sol'],
      modelsTruncated: false, hasNextPage: false, dataShape: 'array',
    });
  });

  it('distinguishes missing selected models from malformed rows in bounded diagnostics', () => {
    const missing = { result: { data: [{ model: 'gpt-other' }], nextCursor: 'opaque-private-cursor' } };
    expect(summarizeCodexModelValidation(missing, 'gpt-selected')).toMatchObject({
      matchingModelRows: 0, malformedModelRows: 0, returnedModels: ['gpt-other'], hasNextPage: true,
    });
    expect(summarizeCodexModelValidation({ result: { data: [null, {}, { model: 12 }] } }, 'gpt-selected'))
      .toMatchObject({ rowCount: 3, malformedModelRows: 3, matchingModelRows: 0 });
    expect(summarizeCodexModelValidation({ result: { data: 'PRIVATE_RESPONSE' } }, 'gpt-selected'))
      .toMatchObject({ rowCount: null, dataShape: 'invalid', returnedModels: [] });
  });

  it('never includes credentials, paths, response prose or opaque cursor contents in diagnostics', () => {
    const secret = `sk-proj-${'A'.repeat(70)}`;
    const response = { id: 'PRIVATE_RESPONSE_ID', result: {
      data: [
        { model: secret, description: 'PRIVATE_RESPONSE_BODY' },
        { model: 'C:/Users/private/model', supportedReasoningEfforts: [{ description: secret }] },
        { model: '/home/private/model' },
        { model: 'relative/private/path' },
        { model: 'gpt-6-luna', private: secret },
      ],
      nextCursor: secret,
    } };
    const diagnostic = summarizeCodexModelValidation(response, secret);
    expect(diagnostic.expectedModel).toBe('[redacted-model-id]');
    expect(diagnostic.returnedModels).toContain('gpt-6-luna');
    const text = JSON.stringify(diagnostic);
    for (const forbidden of [secret, 'C:/Users', '/home/', 'relative/private', 'PRIVATE_RESPONSE', 'description']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('bounds catalog diagnostic rows and identifiers without truncating validation input', () => {
    const response = { result: { data: Array.from({ length: 101 }, (_, i) => ({ model: `gpt-fixture-${i}` })), nextCursor: null } };
    const diagnostic = summarizeCodexModelValidation(response, 'gpt-fixture-0');
    expect(diagnostic.rowCount).toBe(101);
    expect(diagnostic.inspectedRows).toBe(100);
    expect(diagnostic.returnedModels).toHaveLength(32);
    expect(diagnostic.modelsTruncated).toBe(true);
    expect(response.result.data).toHaveLength(101);
  });

  it('requests the complete official model page without inventing a catalog', () => {
    expect(buildCodexModelListRequest({ requestId: 'models_1' })).toEqual({
      id: 'models_1',
      method: 'model/list',
      params: { limit: 100, includeHidden: true },
    });
    expect(buildCodexModelListRequest({ requestId: 'models_2', cursor: 'next/page+2=' })).toEqual({
      id: 'models_2',
      method: 'model/list',
      params: { cursor: 'next/page+2=', limit: 100, includeHidden: true },
    });
    expect(() =>
      buildCodexModelListRequest({ requestId: 'models_2', cursor: 'unsafe\ncursor' }),
    ).toThrow(/cursor/iu);
  });

  it('validates the exact selected model, effort, and official Fast service tier', () => {
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: [model], nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({
      ok: true,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    });
  });

  it('continues pagination before declaring a selected model unavailable', () => {
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: [], nextCursor: 'page_2' } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'next_page', field: 'cursor', cursor: 'page_2' });
  });

  it('fails closed on request, model, effort, tier, and response-shape mismatch', () => {
    expect(
      validateCodexModelListResponse(
        { id: 'wrong', result: { data: [model], nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'request_mismatch', field: 'id' });
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: [], nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'capability_mismatch', field: 'model' });
    expect(
      validateCodexModelListResponse(
        {
          id: 'models_1',
          result: {
            data: [{ ...model, supportedReasoningEfforts: [] }],
            nextCursor: null,
          },
        },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'capability_mismatch', field: 'reasoningEffort' });
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: [{ ...model, serviceTiers: [] }], nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'capability_mismatch', field: 'serviceTier' });
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: [model, model], nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'invalid_response', field: 'model' });
    expect(
      validateCodexModelListResponse(
        { id: 'models_1', result: { data: 'not-an-array', nextCursor: null } },
        'models_1',
        IDENTITY,
      ),
    ).toEqual({ ok: false, reason: 'invalid_response', field: 'data' });
  });
});

describe('Codex native skill protocol', () => {
  const cwd = 'C:\\workspace\\game';
  const skill: CodexDiscoveredSkill = {
    cwd,
    name: 'safe-fast-fix',
    description: 'Implement focused fixes.',
    shortDescription: 'Focused fixes',
    path: 'C:\\Users\\viper\\.codex\\skills\\safe-fast-fix\\SKILL.md',
    scope: 'user',
    enabled: true,
    pluginId: null,
  };

  it('requests native skill discovery for exact active working directories', () => {
    expect(buildCodexSkillsListRequest({
      requestId: 'skills_1',
      cwds: [cwd],
      forceReload: true,
    })).toEqual({
      id: 'skills_1',
      method: 'skills/list',
      params: { cwds: [cwd], forceReload: true },
    });
    expect(() => buildCodexSkillsListRequest({ requestId: 'skills_1', cwds: ['relative/project'] }))
      .toThrow(/absolute safe path/iu);
    expect(() => buildCodexSkillsListRequest({ requestId: 'skills_1', cwds: [cwd, 'c:/WORKSPACE/GAME'] }))
      .toThrow(/unique/iu);
    expect(buildCodexSkillsRefreshRequest({ requestId: 'skills_refresh', cwds: [cwd] })).toEqual({
      id: 'skills_refresh', method: 'skills/list', params: { cwds: [cwd], forceReload: true },
    });
  });

  it('validates the exact native response while preserving disabled skills and per-directory errors', () => {
    const response = validateCodexSkillsListResponse({
      id: 'skills_1',
      result: {
        data: [{
          cwd,
          skills: [skill, { ...skill, name: 'disabled-skill', enabled: false }],
          errors: [{ path: 'C:\\workspace\\game\\.agents\\skills\\broken\\SKILL.md', message: 'Invalid metadata.' }],
        }],
      },
    }, 'skills_1', [cwd]);
    expect(response).toEqual({
      ok: true,
      entries: [{
        cwd,
        skills: [skill, { ...skill, name: 'disabled-skill', enabled: false }],
        errors: [{ cwd, path: 'C:\\workspace\\game\\.agents\\skills\\broken\\SKILL.md', message: 'Invalid metadata.' }],
      }],
    });
    expect(validateCodexSkillsListResponse({ id: 'other', result: { data: [] } }, 'skills_1', [cwd]))
      .toMatchObject({ ok: false, reason: 'request_mismatch' });
    expect(validateCodexSkillsListResponse({
      id: 'skills_1', result: { data: [{ cwd: 'C:\\other', skills: [skill], errors: [] }] },
    }, 'skills_1', [cwd]))
      .toMatchObject({ ok: false, reason: 'cwd_mismatch' });
    expect(validateCodexSkillsListResponse({
      id: 'skills_1', result: { data: [{ cwd, skills: [{ ...skill, path: 'C:\\workspace\\..\\outside\\SKILL.md' }], errors: [] }] },
    }, 'skills_1', [cwd])).toMatchObject({ ok: false, reason: 'invalid_response', field: 'skill.path' });
  });

  it('emits only enabled exact discovered paths as native UserInput skill references', () => {
    expect(buildCodexSkillUserInputs('Please use this skill.', [skill])).toEqual([
      { type: 'text', text: 'Please use this skill.', text_elements: [] },
      { type: 'skill', name: 'safe-fast-fix', path: skill.path },
    ]);
    expect(() => buildCodexSkillUserInputs('Use it.', [{ ...skill, enabled: false }])).toThrow(/disabled/iu);
    expect(() => buildCodexSkillUserInputs('Use it.', [skill, skill])).toThrow(/unique/iu);
    expect(() => buildCodexSkillUserInputs('Use it.', [{ ...skill, path: 'not-a-path' }])).toThrow(/absolute safe path/iu);
  });

  it('recognizes the native skill-change invalidation notification only', () => {
    expect(isCodexSkillsChangedNotification({ method: 'skills/changed', params: {} })).toBe(true);
    expect(isCodexSkillsChangedNotification({ method: 'skills/changed', params: { cwd: 'C:/work' } })).toBe(false);
    expect(isCodexSkillsChangedNotification({ method: 'skills/list', params: {} })).toBe(false);
  });

  it('carries native skill references through turn start, steer, and queue input', () => {
    const refs = [skill];
    const mode = { kind: 'ask' as const };
    const start = buildCodexTurnStartRequest({
      requestId: 'turn_skill', threadId: 'thread_1', clientUserMessageId: 'message_1',
      identity: IDENTITY, mode, text: 'Start with this skill.', skills: refs,
    });
    expect(start.params.input).toEqual(buildCodexSkillUserInputs('Start with this skill.', refs));
    const steer = buildCodexTurnSteerRequest({
      requestId: 'steer_skill', threadId: 'thread_1', expectedTurnId: 'turn_1',
      clientUserMessageId: 'message_2', text: 'Continue with this skill.', skills: refs,
    });
    expect(steer.params.input).toEqual(buildCodexSkillUserInputs('Continue with this skill.', refs));
    const queue = buildCodexThreadQueueAddRequest({
      requestId: 'queue_skill', threadId: 'thread_1', clientUserMessageId: 'message_3',
      text: 'Use this skill next.', skills: refs,
    });
    expect(queue.params.input).toEqual(buildCodexSkillUserInputs('Use this skill next.', refs));
  });
});

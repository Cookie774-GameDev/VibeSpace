import { describe, expect, it } from 'vitest';

import {
  buildCodexApprovalResponse,
  buildCodexModelListRequest,
  buildCodexQuestionResponse,
  buildCodexThreadResumeRequest,
  buildCodexThreadStartRequest,
  buildCodexTurnInterruptRequest,
  buildCodexTurnStartRequest,
  validateCodexModelListResponse,
  validateCodexThreadStartResponse,
  type CodexBackendIdentity,
} from './codexAppServerProtocol';

const IDENTITY: CodexBackendIdentity = {
  modelProvider: 'opencodex-vibespace',
  model: 'gpt-5.6-sol',
  effort: 'high',
  serviceTier: 'fast',
  cwd: 'C:\\workspace\\game',
};

describe('Codex app-server request protocol', () => {
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
    expect(buildCodexTurnStartRequest(input).params.input[0].text).toBe(input.text);
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
        config: { model_reasoning_effort: 'high' },
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
        config: { model_reasoning_effort: 'high' },
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

import { describe, expect, it } from 'vitest';
import { getAllActions } from '@/lib/actions/runner';
import type { ActionDef } from '@/lib/actions/types';
import {
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
  buildJarvisActionCatalog,
  createJarvisActionCatalog,
  isJarvisAutoApprovableRegistration,
  isRegisteredPluginToolExecutor,
  validateJarvisActionCatalog,
  type JarvisRegisteredActionDefinition,
} from './catalog';

function registration(
  overrides: Partial<JarvisRegisteredActionDefinition> = {},
): JarvisRegisteredActionDefinition {
  return {
    id: 'files.inspect',
    version: 1,
    title: 'Inspect file',
    description: 'Inspect one app-owned file.',
    inputSchema: {
      type: 'object',
      properties: { resourceId: { type: 'string' } },
      required: ['resourceId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', additionalProperties: false },
    requiredCapabilities: ['files.read'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads one app-owned file without changing it.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'file.open' },
    credentialBindings: [],
    validateParameters: (input) => ({ resourceId: String(input.resourceId) }),
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'file',
      resourceId: String(params.resourceId),
    }),
    ...overrides,
  };
}

describe('Jarvis action catalog', () => {
  it('permits auto approval only for literal read-only/never registrations', () => {
    expect(isJarvisAutoApprovableRegistration(registration())).toBe(true);
    expect(isJarvisAutoApprovableRegistration(registration({ risk: 'safe-write' }))).toBe(false);
    expect(isJarvisAutoApprovableRegistration(registration({ approval: 'always' }))).toBe(false);
  });

  it('keeps the literal native smoke actions on distinct safe, confirm, and dangerous risks', () => {
    expect(
      DEFAULT_JARVIS_ACTION_REGISTRATIONS.map(({ id, risk, approval }) => ({
        id,
        risk,
        approval,
      })),
    ).toEqual([
      { id: 'file.search', risk: 'read-only', approval: 'never' },
      { id: 'files.read', risk: 'read-only', approval: 'always' },
      { id: 'files.create', risk: 'safe-write', approval: 'always' },
      { id: 'files.edit', risk: 'safe-write', approval: 'always' },
      { id: 'github.identity', risk: 'read-only', approval: 'never' },
      { id: 'github.repository.read', risk: 'read-only', approval: 'never' },
      { id: 'github.issue.read', risk: 'read-only', approval: 'never' },
      { id: 'github.pull_request.read', risk: 'read-only', approval: 'never' },
      { id: 'github.commits.recent', risk: 'read-only', approval: 'never' },
      { id: 'github.release.latest', risk: 'read-only', approval: 'never' },
      { id: 'github.workflows.list', risk: 'read-only', approval: 'never' },
      { id: 'gmail.messages.search', risk: 'read-only', approval: 'never' },
      { id: 'gmail.message.read', risk: 'read-only', approval: 'never' },
      { id: 'gmail.thread.read', risk: 'read-only', approval: 'never' },
      {
        id: 'gmail.draft.create',
        risk: 'external-side-effect',
        approval: 'always',
      },
      {
        id: 'gmail.reply_draft.create',
        risk: 'external-side-effect',
        approval: 'always',
      },
      { id: 'gmail.draft.send', risk: 'external-side-effect', approval: 'always' },
      { id: 'google-drive.files.search', risk: 'read-only', approval: 'never' },
      { id: 'google-drive.document.read', risk: 'read-only', approval: 'never' },
      {
        id: 'google-drive.document.create',
        risk: 'external-side-effect',
        approval: 'always',
      },
      { id: 'canva.designs.search', risk: 'read-only', approval: 'never' },
      { id: 'canva.design.read', risk: 'read-only', approval: 'never' },
      { id: 'canva.brand_templates.search', risk: 'read-only', approval: 'never' },
      { id: 'canva.brand_template.dataset.read', risk: 'read-only', approval: 'never' },
      { id: 'canva.autofill_job.read', risk: 'read-only', approval: 'never' },
      {
        id: 'canva.design.create',
        risk: 'external-side-effect',
        approval: 'always',
      },
      {
        id: 'canva.design.autofill',
        risk: 'external-side-effect',
        approval: 'always',
      },
      { id: 'zapier.actions.discover', risk: 'read-only', approval: 'never' },
      {
        id: 'zapier.action.invoke',
        risk: 'external-side-effect',
        approval: 'always',
      },
      { id: 'browser.readPage', risk: 'read-only', approval: 'never' },
      { id: 'browser.navigate', risk: 'external-side-effect', approval: 'always' },
      { id: 'browser.click', risk: 'external-side-effect', approval: 'always' },
      { id: 'browser.type', risk: 'external-side-effect', approval: 'always' },
      { id: 'chat.model.switch', risk: 'external-side-effect', approval: 'always' },
      { id: 'mcp.invoke', risk: 'external-side-effect', approval: 'always' },
      { id: 'creator.start', risk: 'safe-write', approval: 'always' },
      { id: 'schedule.create', risk: 'safe-write', approval: 'always' },
      { id: 'agent.run', risk: 'external-side-effect', approval: 'always' },
      { id: 'terminal.create', risk: 'safe-write', approval: 'always' },
      { id: 'terminal.run', risk: 'external-side-effect', approval: 'always' },
      { id: 'terminal.start_cli', risk: 'external-side-effect', approval: 'always' },
      { id: 'terminal.send_input', risk: 'external-side-effect', approval: 'always' },
      { id: 'terminal.wait_for_output', risk: 'read-only', approval: 'never' },
      { id: 'terminal.collect_output', risk: 'read-only', approval: 'never' },
      { id: 'task.cancel', risk: 'destructive', approval: 'always' },
    ]);
  });

  it('registers bounded project-file actions behind explicit approval', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const read = catalog.resolve('files.read');
    const create = catalog.resolve('files.create');
    const edit = catalog.resolve('files.edit');

    expect(read).toMatchObject({
      requiredCapabilities: ['files.read'],
      risk: 'read-only',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'files.read' },
    });
    expect(create).toMatchObject({
      requiredCapabilities: ['files.write'],
      risk: 'safe-write',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'files.create' },
    });
    expect(edit).toMatchObject({
      requiredCapabilities: ['files.write'],
      risk: 'safe-write',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'files.edit' },
    });
    expect(read?.validateParameters({ path: 'C:\\safe\\input.txt' })).toEqual({
      path: 'C:\\safe\\input.txt',
    });
    expect(
      create?.validateParameters({
        path: 'C:\\safe\\output.txt',
        content: 'hello',
        attachToChat: true,
      }),
    ).toEqual({
      path: 'C:\\safe\\output.txt',
      content: 'hello',
      attachToChat: true,
    });
    expect(() => read?.validateParameters({ path: 'C:\\safe\\input.txt', secret: 'x' })).toThrow(
      /unknown fields/i,
    );
  });

  it('registers the bounded agent and skill creator launcher behind approval', () => {
    const creator = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'creator.start',
    );

    expect(creator).toMatchObject({
      requiredCapabilities: ['creator.open'],
      risk: 'safe-write',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'creator.start' },
    });
    expect(creator?.validateParameters({ kind: 'agent' })).toEqual({ kind: 'agent' });
    expect(creator?.validateParameters({ kind: 'skill' })).toEqual({ kind: 'skill' });
    expect(() => creator?.validateParameters({ kind: 'terminal' })).toThrow(/kind/i);
  });

  it('registers schedule creation behind canonical approval', () => {
    const schedule = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'schedule.create',
    );

    expect(schedule).toMatchObject({
      requiredCapabilities: ['schedule.write'],
      risk: 'safe-write',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'schedule.create' },
    });
    expect(
      schedule?.validateParameters({
        title: 'Owner Verify',
        prompt: 'Provide a local status reminder.',
        startAtMs: 1_786_626_000_000,
        recurrence: 'once',
      }),
    ).toEqual({
      title: 'Owner Verify',
      prompt: 'Provide a local status reminder.',
      startAtMs: 1_786_626_000_000,
      recurrence: 'once',
    });
  });

  it('registers one bounded child-agent launch behind canonical approval', () => {
    const runAgent = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'agent.run',
    );

    expect(runAgent).toMatchObject({
      requiredCapabilities: ['agent.execute'],
      risk: 'external-side-effect',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'agent.run' },
    });
    expect(
      runAgent?.validateParameters({
        task: 'Review the approved file without editing it.',
        agentId: 'agt_local_llama',
      }),
    ).toEqual({
      task: 'Review the approved file without editing it.',
      agentId: 'agt_local_llama',
    });
  });

  it('keeps bounded terminal CLI launch fail-closed until atomic ownership is available', () => {
    const startCli = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'terminal.start_cli',
    );

    expect(startCli).toMatchObject({
      requiredCapabilities: ['terminal.experimental.disabled'],
      risk: 'external-side-effect',
      approval: 'always',
      exposeToAI: false,
      executor: { kind: 'builtin', registryActionId: 'terminal.start_cli' },
      credentialBindings: [],
      inputSchema: {
        type: 'object',
        required: ['cli'],
        additionalProperties: false,
      },
    });
    const params = {
      cli: 'opencode --model current/free',
      cwd: 'C:\\safe\\project',
      label: 'OpenCode',
      timeoutMs: 120_000,
    };
    expect(startCli?.validateParameters(params)).toEqual(params);
    expect(
      startCli?.validateParameters({
        cli: '  opencode --model current/free  ',
        cwd: '  C:\\safe\\project  ',
        label: '  OpenCode  ',
        timeoutMs: 120_000,
      }),
    ).toEqual(params);
    expect(
      startCli?.deriveTarget({
        accountId: 'account-terminal',
        params: {
          cli: '  opencode --model current/free  ',
          cwd: '  C:\\safe\\project  ',
          label: '  OpenCode  ',
          timeoutMs: 120_000,
        },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'new-cli:OpenCode',
    });
    expect(
      startCli?.deriveTarget({
        accountId: 'account-terminal',
        params: { cli: 'opencode --model current/free' },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'new-cli:opencode',
    });
    expect(() => startCli?.validateParameters({ ...params, secret: 'x' })).toThrow(
      /unknown fields/i,
    );
    expect(() => startCli?.validateParameters({ ...params, cli: ' ' })).toThrow(/cli/i);
    expect(() => startCli?.validateParameters({ ...params, cli: 'x'.repeat(32_769) })).toThrow(
      /cli.*long/i,
    );
    expect(() => startCli?.validateParameters({ ...params, cwd: 'x'.repeat(32_769) })).toThrow(
      /cwd.*long/i,
    );
    expect(() => startCli?.validateParameters({ ...params, label: 'x'.repeat(241) })).toThrow(
      /label.*long/i,
    );
    expect(() => startCli?.validateParameters({ ...params, timeoutMs: 999 })).toThrow(/timeout/i);
    expect(startCli?.validateParameters({ ...params, timeoutMs: 1_800_000 })).toEqual({
      ...params,
      timeoutMs: 1_800_000,
    });
    expect(() => startCli?.validateParameters({ ...params, timeoutMs: 1_800_001 })).toThrow(
      /timeout/i,
    );
    expect(() => startCli?.validateParameters({ ...params, timeoutMs: 3_600_000 })).toThrow(
      /timeout/i,
    );
    expect(() => startCli?.validateParameters({ ...params, timeoutMs: 1_000.5 })).toThrow(
      /timeout/i,
    );
    for (const unsafe of ['\u0000', '\u0085', '\u202e', '\u200b', '\ufeff']) {
      expect(() =>
        startCli?.validateParameters({ ...params, cli: `opencode${unsafe} --version` }),
      ).toThrow(/cli.*control/i);
      expect(() =>
        startCli?.validateParameters({ ...params, cwd: `C:\\safe${unsafe}\\project` }),
      ).toThrow(/cwd.*control/i);
      expect(() => startCli?.validateParameters({ ...params, label: `Open${unsafe}Code` })).toThrow(
        /label.*control/i,
      );
    }
  });

  it('keeps targeted terminal actions fail-closed until atomic ownership is available', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const send = catalog.resolve('terminal.send_input');
    const wait = catalog.resolve('terminal.wait_for_output');
    const collect = catalog.resolve('terminal.collect_output');

    expect(send).toMatchObject({
      requiredCapabilities: ['terminal.experimental.disabled'],
      risk: 'external-side-effect',
      approval: 'always',
      exposeToAI: false,
      executor: { kind: 'builtin', registryActionId: 'terminal.send_input' },
      credentialBindings: [],
    });
    expect(wait).toMatchObject({
      requiredCapabilities: ['terminal.experimental.disabled'],
      risk: 'read-only',
      approval: 'never',
      exposeToAI: false,
      executor: { kind: 'builtin', registryActionId: 'terminal.wait_for_output' },
      credentialBindings: [],
    });
    expect(collect).toMatchObject({
      requiredCapabilities: ['terminal.experimental.disabled'],
      risk: 'read-only',
      approval: 'never',
      exposeToAI: false,
      executor: { kind: 'builtin', registryActionId: 'terminal.collect_output' },
      credentialBindings: [],
    });

    expect(
      send?.validateParameters({
        command: '  status --json  ',
        refsJson: ' { "sessionId": "session_123" } ',
      }),
    ).toEqual({
      command: 'status --json',
      refsJson: '{"sessionId":"session_123"}',
    });
    expect(
      send?.deriveTarget({
        accountId: 'account-terminal',
        params: { command: 'status --json', refsJson: '{"paneId":"pane_456"}' },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'pane:pane_456',
    });
    expect(
      wait?.validateParameters({
        sessionId: '  session_123  ',
        contains: '  completed  ',
        afterBytes: 0,
        timeoutMs: 60_000,
      }),
    ).toEqual({
      sessionId: 'session_123',
      contains: 'completed',
      afterBytes: 0,
      timeoutMs: 60_000,
    });
    expect(
      collect?.validateParameters({
        paneId: '  pane_456  ',
        maxChars: 16_000,
      }),
    ).toEqual({
      paneId: 'pane_456',
      maxChars: 16_000,
    });
    expect(
      wait?.deriveTarget({
        accountId: 'account-terminal',
        params: { sessionId: 'session_123' },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'session:session_123',
    });
    expect(
      collect?.deriveTarget({
        accountId: 'account-terminal',
        params: { paneId: 'pane_456' },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'pane:pane_456',
    });

    for (const action of [wait, collect]) {
      expect(() => action?.validateParameters({})).toThrow(/exactly one/i);
      expect(() =>
        action?.validateParameters({ sessionId: 'session_123', paneId: 'pane_456' }),
      ).toThrow(/exactly one/i);
      expect(() => action?.validateParameters({ agentSlug: 'agent-1' })).toThrow(
        /unknown fields|selector/i,
      );
      expect(() => action?.validateParameters({ all: true })).toThrow(/unknown fields|selector/i);
      expect(() => action?.validateParameters({ sessionId: { value: 'session_123' } })).toThrow(
        /sessionId|selector/i,
      );
      expect(() => action?.validateParameters({ sessionId: 'session_\u202e123' })).toThrow(
        /sessionId|selector/i,
      );
    }
    for (const refsJson of [
      '["session_123"]',
      '{"sessionId":"session_123","paneId":"pane_456"}',
      '{"agentSlug":"agent-1"}',
      '{"all":true}',
      '{"sessionId":{"value":"session_123"}}',
      '{"sessionId":"session_123","extra":true}',
      '{"sessionId":"session_\\u202e123"}',
    ]) {
      expect(() => send?.validateParameters({ command: 'status', refsJson })).toThrow(
        /refsJson|selector/i,
      );
    }
    expect(() =>
      send?.validateParameters({ command: `status${'\u0000'}`, refsJson: '{"paneId":"pane_456"}' }),
    ).toThrow(/command.*control/i);
    expect(() =>
      send?.validateParameters({
        command: 'x'.repeat(10_001),
        refsJson: '{"paneId":"pane_456"}',
      }),
    ).toThrow(/command.*long/i);
    expect(() =>
      send?.validateParameters({
        command: 'status',
        refsJson: '{"paneId":"pane_456"}',
        extra: true,
      }),
    ).toThrow(/unknown fields/i);

    expect(() => wait?.validateParameters({ sessionId: 'session_123', afterBytes: -1 })).toThrow(
      /afterBytes/i,
    );
    expect(() => wait?.validateParameters({ sessionId: 'session_123', afterBytes: 1.5 })).toThrow(
      /afterBytes/i,
    );
    expect(() => wait?.validateParameters({ sessionId: 'session_123', timeoutMs: 249 })).toThrow(
      /timeoutMs/i,
    );
    expect(() => wait?.validateParameters({ sessionId: 'session_123', timeoutMs: 60_001 })).toThrow(
      /timeoutMs/i,
    );
    expect(() => collect?.validateParameters({ paneId: 'pane_456', maxChars: 199 })).toThrow(
      /maxChars/i,
    );
    expect(() => collect?.validateParameters({ paneId: 'pane_456', maxChars: 16_001 })).toThrow(
      /maxChars/i,
    );
  });

  it('publishes only fixed browser operations behind canonical review bindings', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    expect(
      ['browser.readPage', 'browser.navigate', 'browser.click', 'browser.type'].map((id) => {
        const action = catalog.resolve(id)!;
        return {
          id,
          capability: action.requiredCapabilities[0],
          approval: action.approval,
          exposed: action.exposeToAI,
          executor: action.executor,
        };
      }),
    ).toEqual([
      {
        id: 'browser.readPage',
        capability: 'browser.operator',
        approval: 'never',
        exposed: false,
        executor: { kind: 'builtin', registryActionId: 'browser.readPage' },
      },
      {
        id: 'browser.navigate',
        capability: 'browser.operator',
        approval: 'always',
        exposed: false,
        executor: { kind: 'builtin', registryActionId: 'browser.navigate' },
      },
      {
        id: 'browser.click',
        capability: 'browser.operator',
        approval: 'always',
        exposed: false,
        executor: { kind: 'builtin', registryActionId: 'browser.click' },
      },
      {
        id: 'browser.type',
        capability: 'browser.operator',
        approval: 'always',
        exposed: false,
        executor: { kind: 'builtin', registryActionId: 'browser.type' },
      },
    ]);
    expect(catalog.resolve('browser.evaluate')).toBeUndefined();
    expect(catalog.resolve('browser.runJs')).toBeUndefined();

    const navigate = catalog.resolve('browser.navigate')!;
    const canonical = {
      schemaVersion: 1,
      reviewId: 'review-1',
      origin: 'https://example.test',
      tabId: 'tab-1',
      frameId: null,
      target: { currentUrl: 'https://example.test/start' },
      parameters: { url: 'https://example.test/next' },
      parametersHash: 'parameter-hash',
      reviewedHash: 'reviewed-hash',
      expectedEffect: 'Navigate the active browser tab.',
      reviewedRisk: 'confirm',
      capability: { id: 'browser.operator', operation: 'browser.navigate' },
    };
    expect(navigate.validateParameters(canonical)).toEqual(canonical);
    expect(() =>
      navigate.validateParameters({
        ...canonical,
        parameters: { url: 'https://example.test/next', expression: 'document.cookie' },
      }),
    ).toThrow(/unknown fields/i);
  });

  it('publishes one closed always-confirmed MCP invocation registration', () => {
    const invoke = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'mcp.invoke',
    );

    expect(invoke).toMatchObject({
      id: 'mcp.invoke',
      inputSchema: {
        type: 'object',
        required: ['serverId', 'toolName'],
        additionalProperties: false,
      },
      requiredCapabilities: ['mcp.external.invoke'],
      risk: 'external-side-effect',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'mcp.invoke' },
      credentialBindings: [],
    });
    expect(
      invoke?.validateParameters({
        serverId: 'github',
        toolName: 'repo.read',
        inputJson: '{"owner":"openai"}',
        timeoutMs: 2_000,
      }),
    ).toEqual({
      serverId: 'github',
      toolName: 'repo.read',
      inputJson: '{"owner":"openai"}',
      timeoutMs: 2_000,
    });
    expect(
      invoke?.deriveTarget({
        accountId: 'account-1',
        params: { serverId: 'github', toolName: 'repo.read' },
      }),
    ).toEqual({
      kind: 'external_resource',
      service: 'mcp',
      resourceId: 'github.repo.read',
    });
    expect(() =>
      invoke?.validateParameters({
        serverId: 'github',
        toolName: 'repo.read',
        credential: 'forbidden',
      }),
    ).toThrow(/unknown fields/i);
    expect(() =>
      invoke?.validateParameters({
        serverId: 'github',
        toolName: 'repo.read',
        inputJson: '[]',
      }),
    ).toThrow(/JSON object/i);
  });

  it('publishes a closed model-safe model-switch registration', () => {
    const modelSwitch = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'chat.model.switch',
    );

    expect(modelSwitch).toMatchObject({
      id: 'chat.model.switch',
      inputSchema: {
        type: 'object',
        required: ['request'],
        additionalProperties: false,
        properties: {
          request: { type: 'string' },
          needsImages: { type: 'boolean' },
          needsTools: { type: 'boolean' },
        },
      },
      requiredCapabilities: ['chat.actions'],
      risk: 'external-side-effect',
      approval: 'always',
      executor: { kind: 'builtin', registryActionId: 'chat.model.switch' },
      credentialBindings: [],
    });
    expect(
      modelSwitch?.validateParameters({
        request: '  Switch to Gemini.  ',
        needsImages: true,
        needsTools: false,
      }),
    ).toEqual({
      request: 'Switch to Gemini.',
      needsImages: true,
      needsTools: false,
    });
    expect(
      modelSwitch?.deriveTarget({
        accountId: 'account-model-switch',
        params: { request: 'Switch to Gemini.' },
      }),
    ).toEqual({
      kind: 'app_resource',
      namespace: 'chat-model',
      resourceId: 'active',
    });
    expect(() =>
      modelSwitch?.validateParameters({
        request: 'Switch to Gemini.',
        approvalId: 'must-not-be-model-controlled',
      }),
    ).toThrow(/unknown fields/i);
    expect(() =>
      modelSwitch?.validateParameters({ request: 'Switch to Gemini.', needsTools: 'yes' }),
    ).toThrow(/needsTools/i);
    expect(() => modelSwitch?.validateParameters({ request: ' '.repeat(2) })).toThrow(/request/i);
  });

  it('normalizes every executable action into a versioned typed definition', () => {
    const catalog = buildJarvisActionCatalog(getAllActions());

    expect(catalog.length).toBeGreaterThan(40);
    expect(validateJarvisActionCatalog(catalog)).toEqual([]);
    expect(catalog.every((action) => action.version === 1)).toBe(true);
    expect(catalog.every((action) => typeof action.handler === 'function')).toBe(true);

    expect(catalog.find((action) => action.id === 'terminal.bulkOpen')).toMatchObject({
      risk: 'external-side-effect',
      approval: 'always',
      inputSchema: {
        type: 'object',
        properties: expect.objectContaining({ count: expect.objectContaining({ type: 'number' }) }),
      },
    });
  });

  it('rejects credential-shaped fields from model-visible action schemas', () => {
    const invalid: ActionDef = {
      id: 'unsafe.secret',
      category: 'custom',
      label: 'Unsafe secret',
      description: 'Unsafe test action.',
      params: [{ key: 'apiKey', label: 'API key', type: 'string' }],
      run: async () => ({ ok: true }),
    };

    const errors = validateJarvisActionCatalog(buildJarvisActionCatalog([invalid]));

    expect(errors.join('\n')).toMatch(/credential field/i);
  });

  it('deep-freezes detached canonical registrations and keeps unregistered legacy actions unavailable', () => {
    const source = registration();
    const catalog = createJarvisActionCatalog([source]);
    const resolved = catalog.resolve(source.id)!;

    expect(resolved).not.toBe(source);
    expect(resolved.executor).not.toBe(source.executor);
    expect(resolved.inputSchema).not.toBe(source.inputSchema);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.executor)).toBe(true);
    expect(Object.isFrozen(resolved.inputSchema)).toBe(true);
    expect(Object.isFrozen(resolved.inputSchema.properties)).toBe(true);
    expect(catalog.resolve('legacy.only')).toBeUndefined();
    expect(
      buildJarvisActionCatalog([
        {
          id: 'legacy.only',
          category: 'custom',
          label: 'Legacy',
          description: 'Legacy only.',
          params: [],
          run: async () => ({ ok: true }),
        },
      ]),
    ).toHaveLength(1);
  });

  it.each([
    [registration(), registration()],
    [registration(), registration({ version: 2 })],
  ])('rejects duplicate action ids regardless of version', (...registrations) => {
    expect(() => createJarvisActionCatalog(registrations)).toThrow(/duplicate action id/i);
  });

  it.each(['plugin.call', 'plugin.invoke'])('rejects generic plugin action id %s', (id) => {
    expect(() => createJarvisActionCatalog([registration({ id })])).toThrow(/generic plugin/i);
  });

  it('fixes plugin and tool identity outside model parameters and recognizes only canonical executor identity', () => {
    const source = registration({
      id: 'shopify.orders.list',
      executor: { kind: 'plugin_tool', pluginId: 'shopify', toolName: 'orders.list' },
      credentialBindings: [
        {
          field: 'shopifyCredential',
          locator: { pluginId: 'shopify', fieldId: 'access-token' },
        },
      ],
      inputSchema: { type: 'object', additionalProperties: false },
      validateParameters: () => ({}),
      deriveTarget: ({ accountId }) => ({
        kind: 'plugin_tool',
        accountId,
        pluginId: 'shopify',
        toolName: 'orders.list',
        resourceId: 'orders',
      }),
    });
    const executor = createJarvisActionCatalog([source]).resolve(source.id)!.executor;

    expect(isRegisteredPluginToolExecutor(source.executor)).toBe(false);
    expect(isRegisteredPluginToolExecutor({ ...executor })).toBe(false);
    expect(isRegisteredPluginToolExecutor(executor)).toBe(true);
    expect(() =>
      createJarvisActionCatalog([
        registration({
          id: 'shopify.unsafe',
          executor: source.executor,
          inputSchema: { type: 'object', properties: { pluginId: { type: 'string' } } },
          deriveTarget: source.deriveTarget,
        }),
      ]),
    ).toThrow(/model-visible|pluginId/i);
    expect(() =>
      createJarvisActionCatalog([
        registration({
          id: 'builtin.unsafe',
          inputSchema: {
            type: 'object',
            properties: { pluginId: { type: 'string' } },
            additionalProperties: false,
          },
        }),
      ]),
    ).toThrow(/model-visible|pluginId/i);
    expect(() =>
      createJarvisActionCatalog([
        registration({
          id: 'builtin.tool-unsafe',
          inputSchema: {
            type: 'object',
            properties: { toolName: { type: 'string' } },
            additionalProperties: false,
          },
        }),
      ]),
    ).toThrow(/model-visible|toolName/i);
  });

  it('publishes only fixed model-safe provider registrations with account-bound credentials', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const identity = catalog.resolve('github.identity');
    const repository = catalog.resolve('github.repository.read');
    const issue = catalog.resolve('github.issue.read');
    const pullRequest = catalog.resolve('github.pull_request.read');
    const recentCommits = catalog.resolve('github.commits.recent');
    const latestRelease = catalog.resolve('github.release.latest');
    const workflows = catalog.resolve('github.workflows.list');

    expect(Object.isFrozen(DEFAULT_JARVIS_ACTION_REGISTRATIONS)).toBe(true);
    expect(
      catalog
        .listExposed()
        .filter((entry) => entry.executor.kind === 'plugin_tool')
        .map(({ id }) => id),
    ).toEqual([
      'github.identity',
      'github.repository.read',
      'github.issue.read',
      'github.pull_request.read',
      'github.commits.recent',
      'github.release.latest',
      'github.workflows.list',
      'gmail.messages.search',
      'gmail.message.read',
      'gmail.thread.read',
      'gmail.draft.create',
      'gmail.reply_draft.create',
      'gmail.draft.send',
      'google-drive.files.search',
      'google-drive.document.read',
      'google-drive.document.create',
      'canva.designs.search',
      'canva.design.read',
      'canva.brand_templates.search',
      'canva.brand_template.dataset.read',
      'canva.autofill_job.read',
      'canva.design.create',
      'canva.design.autofill',
      'zapier.actions.discover',
      'zapier.action.invoke',
    ]);
    expect(identity).toMatchObject({
      requiredCapabilities: ['plugin.github.identity'],
      risk: 'read-only',
      approval: 'never',
      executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'identity' },
      credentialBindings: [
        { field: 'githubCredential', locator: { pluginId: 'github', fieldId: 'token' } },
      ],
      inputSchema: { type: 'object', additionalProperties: false },
    });
    expect(identity?.validateParameters({})).toEqual({});
    expect(() => identity?.validateParameters({ token: 'model-controlled' })).toThrow(
      /unknown fields/i,
    );
    expect(repository).toMatchObject({
      requiredCapabilities: ['plugin.github.repository_context'],
      risk: 'read-only',
      approval: 'never',
      executor: {
        kind: 'plugin_tool',
        pluginId: 'github',
        toolName: 'repository_context',
      },
      credentialBindings: [
        { field: 'githubCredential', locator: { pluginId: 'github', fieldId: 'token' } },
      ],
      inputSchema: {
        type: 'object',
        required: ['owner', 'repository'],
        additionalProperties: false,
      },
    });
    expect(
      repository?.validateParameters({ owner: ' octocat ', repository: ' Hello-World ' }),
    ).toEqual({ owner: 'octocat', repository: 'Hello-World' });
    expect(
      repository?.deriveTarget({
        accountId: 'account-github',
        params: { owner: 'octocat', repository: 'Hello-World' },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-github',
      pluginId: 'github',
      toolName: 'repository_context',
      resourceId: 'octocat/Hello-World',
    });
    expect(() =>
      repository?.validateParameters({ owner: 'octocat/escape', repository: 'Hello-World' }),
    ).toThrow(/owner/i);
    expect(() =>
      repository?.validateParameters({
        owner: 'octocat',
        repository: 'Hello-World',
        pluginId: 'github',
      }),
    ).toThrow(/unknown fields/i);
    expect(JSON.stringify(repository?.inputSchema)).not.toMatch(/token|credential|secret/i);
    for (const [registration, actionId, toolName, capability] of [
      [issue, 'github.issue.read', 'issue_context', 'plugin.github.issue_context'],
      [
        pullRequest,
        'github.pull_request.read',
        'pull_request_context',
        'plugin.github.pull_request_context',
      ],
    ] as const) {
      expect(registration).toMatchObject({
        id: actionId,
        requiredCapabilities: [capability],
        risk: 'read-only',
        approval: 'never',
        executor: { kind: 'plugin_tool', pluginId: 'github', toolName },
        credentialBindings: [
          { field: 'githubCredential', locator: { pluginId: 'github', fieldId: 'token' } },
        ],
        inputSchema: {
          type: 'object',
          required: ['owner', 'repository', 'number'],
          additionalProperties: false,
        },
      });
      expect(
        registration?.validateParameters({
          owner: ' octocat ',
          repository: ' Hello-World ',
          number: 42,
        }),
      ).toEqual({ owner: 'octocat', repository: 'Hello-World', number: 42 });
      expect(
        registration?.deriveTarget({
          accountId: 'account-github',
          params: { owner: 'octocat', repository: 'Hello-World', number: 42 },
        }),
      ).toEqual({
        kind: 'plugin_tool',
        accountId: 'account-github',
        pluginId: 'github',
        toolName,
        resourceId: 'octocat/Hello-World#42',
      });
      expect(() =>
        registration?.validateParameters({
          owner: 'octocat',
          repository: 'Hello-World',
          number: 0,
        }),
      ).toThrow(/number/i);
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(/token|credential|secret/i);
    }
    for (const [registration, actionId, toolName, capability] of [
      [recentCommits, 'github.commits.recent', 'recent_commits', 'plugin.github.recent_commits'],
      [latestRelease, 'github.release.latest', 'latest_release', 'plugin.github.latest_release'],
      [workflows, 'github.workflows.list', 'workflows', 'plugin.github.workflows'],
    ] as const) {
      expect(registration).toMatchObject({
        id: actionId,
        requiredCapabilities: [capability],
        risk: 'read-only',
        approval: 'never',
        executor: { kind: 'plugin_tool', pluginId: 'github', toolName },
        credentialBindings: [
          { field: 'githubCredential', locator: { pluginId: 'github', fieldId: 'token' } },
        ],
        inputSchema: {
          type: 'object',
          required: ['owner', 'repository'],
          additionalProperties: false,
        },
      });
      expect(
        registration?.validateParameters({
          owner: ' octocat ',
          repository: ' Hello-World ',
        }),
      ).toEqual({ owner: 'octocat', repository: 'Hello-World' });
      expect(
        registration?.deriveTarget({
          accountId: 'account-github',
          params: { owner: 'octocat', repository: 'Hello-World' },
        }),
      ).toEqual({
        kind: 'plugin_tool',
        accountId: 'account-github',
        pluginId: 'github',
        toolName,
        resourceId: 'octocat/Hello-World',
      });
      expect(() =>
        registration?.validateParameters({
          owner: 'octocat',
          repository: 'Hello-World',
          perPage: 100,
        }),
      ).toThrow(/unknown fields/i);
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(/token|credential|secret/i);
    }
  });

  it('publishes bounded Gmail reads and always-approved Gmail writes without model-visible credentials', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const search = catalog.resolve('gmail.messages.search');
    const read = catalog.resolve('gmail.message.read');
    const thread = catalog.resolve('gmail.thread.read');
    const createDraft = catalog.resolve('gmail.draft.create');
    const replyDraft = catalog.resolve('gmail.reply_draft.create');
    const sendDraft = catalog.resolve('gmail.draft.send');
    const credentials = [
      { field: 'gmailClientIdGrant', locator: { pluginId: 'gmail', fieldId: 'client_id' } },
      { field: 'gmailRefreshGrant', locator: { pluginId: 'gmail', fieldId: 'refresh_token' } },
    ];
    const draftFingerprint = 'a'.repeat(64);

    for (const [registration, id, toolName, capability] of [
      [search, 'gmail.messages.search', 'message_search', 'plugin.gmail.message_search'],
      [read, 'gmail.message.read', 'message_read', 'plugin.gmail.message_read'],
      [thread, 'gmail.thread.read', 'thread_read', 'plugin.gmail.thread_read'],
    ] as const) {
      expect(registration).toMatchObject({
        id,
        risk: 'read-only',
        approval: 'never',
        requiredCapabilities: [capability],
        executor: { kind: 'plugin_tool', pluginId: 'gmail', toolName },
        credentialBindings: credentials,
        inputSchema: { type: 'object', additionalProperties: false },
      });
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(
        /token|credential|secret|clientId/i,
      );
    }
    for (const [registration, id, toolName, capability] of [
      [createDraft, 'gmail.draft.create', 'draft_create', 'plugin.gmail.draft_create'],
      [
        replyDraft,
        'gmail.reply_draft.create',
        'reply_draft_create',
        'plugin.gmail.reply_draft_create',
      ],
      [sendDraft, 'gmail.draft.send', 'draft_send', 'plugin.gmail.draft_send'],
    ] as const) {
      expect(registration).toMatchObject({
        id,
        risk: 'external-side-effect',
        approval: 'always',
        requiredCapabilities: [capability],
        executor: { kind: 'plugin_tool', pluginId: 'gmail', toolName },
        credentialBindings: credentials,
        inputSchema: { type: 'object', additionalProperties: false },
      });
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(
        /token|credential|secret|clientId/i,
      );
    }

    expect(search?.validateParameters({ query: ' in:inbox is:unread ', maxResults: 10 })).toEqual({
      query: 'in:inbox is:unread',
      maxResults: 10,
    });
    expect(read?.validateParameters({ messageId: 'message_123-abc' })).toEqual({
      messageId: 'message_123-abc',
    });
    expect(thread?.validateParameters({ threadId: 'thread_123-abc' })).toEqual({
      threadId: 'thread_123-abc',
    });
    expect(
      createDraft?.validateParameters({
        to: 'person@example.com, second@example.com',
        subject: '  Project update  ',
        body: 'Hello.\r\n\r\nThe work is ready.',
      }),
    ).toEqual({
      to: 'person@example.com, second@example.com',
      subject: 'Project update',
      body: 'Hello.\n\nThe work is ready.',
    });
    expect(
      replyDraft?.validateParameters({
        messageId: 'message_123-abc',
        body: ' Thanks. ',
      }),
    ).toEqual({
      messageId: 'message_123-abc',
      body: ' Thanks. ',
    });
    expect(
      sendDraft?.validateParameters({
        draftId: 'draft_123-abc',
        draftFingerprint,
      }),
    ).toEqual({
      draftId: 'draft_123-abc',
      draftFingerprint,
    });
    expect(() =>
      createDraft?.validateParameters({
        to: 'person@example.com\r\nBcc: attacker@example.com',
        subject: 'Hello',
        body: 'Safe body',
      }),
    ).toThrow(/recipient/i);
    expect(() =>
      createDraft?.validateParameters({
        to: 'person@example.com',
        subject: 'Hello\r\nBcc: attacker@example.com',
        body: 'Safe body',
      }),
    ).toThrow(/subject/i);
    expect(() =>
      sendDraft?.validateParameters({
        draftId: 'draft_123-abc',
        draftFingerprint,
        approvalId: 'model-controlled',
      }),
    ).toThrow(/unknown fields/i);
    expect(() =>
      sendDraft?.validateParameters({
        draftId: 'draft_123-abc',
        draftFingerprint: 'a'.repeat(63),
      }),
    ).toThrow(/fingerprint/i);
    expect(
      createDraft?.deriveTarget({
        accountId: 'account-gmail',
        params: {
          to: 'person@example.com',
          subject: 'Project update',
          body: 'Safe body',
        },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-gmail',
      pluginId: 'gmail',
      toolName: 'draft_create',
      resourceId: 'new-draft',
    });
    expect(
      sendDraft?.deriveTarget({
        accountId: 'account-gmail',
        params: { draftId: 'draft_123-abc', draftFingerprint },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-gmail',
      pluginId: 'gmail',
      toolName: 'draft_send',
      resourceId: `draft_123-abc@${draftFingerprint}`,
    });
  });

  it('publishes bounded Drive reads and always-approved document creation without raw queries or credentials', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const search = catalog.resolve('google-drive.files.search');
    const read = catalog.resolve('google-drive.document.read');
    const create = catalog.resolve('google-drive.document.create');
    const credentials = [
      {
        field: 'googleDriveClientIdGrant',
        locator: { pluginId: 'google-drive', fieldId: 'client_id' },
      },
      {
        field: 'googleDriveRefreshGrant',
        locator: { pluginId: 'google-drive', fieldId: 'refresh_token' },
      },
    ];

    for (const [registration, id, toolName, capability] of [
      [search, 'google-drive.files.search', 'files_search', 'plugin.google-drive.files_search'],
      [read, 'google-drive.document.read', 'document_read', 'plugin.google-drive.document_read'],
    ] as const) {
      expect(registration).toMatchObject({
        id,
        risk: 'read-only',
        approval: 'never',
        requiredCapabilities: [capability],
        executor: { kind: 'plugin_tool', pluginId: 'google-drive', toolName },
        credentialBindings: credentials,
        inputSchema: { type: 'object', additionalProperties: false },
      });
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(
        /token|credential|secret|clientId|rawQuery/i,
      );
    }
    expect(create).toMatchObject({
      id: 'google-drive.document.create',
      risk: 'external-side-effect',
      approval: 'always',
      requiredCapabilities: ['plugin.google-drive.document_create'],
      executor: {
        kind: 'plugin_tool',
        pluginId: 'google-drive',
        toolName: 'document_create',
      },
      credentialBindings: credentials,
      inputSchema: { type: 'object', additionalProperties: false },
    });
    expect(JSON.stringify(create?.inputSchema)).not.toMatch(
      /token|credential|secret|clientId|rawQuery/i,
    );

    expect(search?.validateParameters({ term: '  project plan  ', maxResults: 10 })).toEqual({
      term: 'project plan',
      maxResults: 10,
    });
    expect(read?.validateParameters({ fileId: 'drive-file_123' })).toEqual({
      fileId: 'drive-file_123',
    });
    expect(
      create?.validateParameters({
        title: '  Approved project brief  ',
        content: 'Line one.\r\n\r\nLine two.',
      }),
    ).toEqual({
      title: 'Approved project brief',
      content: 'Line one.\n\nLine two.',
    });
    expect(() =>
      search?.validateParameters({
        term: 'project',
        maxResults: 10,
        rawQuery: "trashed = true or name != ''",
      }),
    ).toThrow(/unknown fields/i);
    expect(() =>
      read?.validateParameters({
        fileId: '../private',
      }),
    ).toThrow(/fileId/i);
    expect(() =>
      create?.validateParameters({
        title: 'Injected\r\nHeader: value',
        content: 'Safe body.',
      }),
    ).toThrow(/title/i);
    expect(
      read?.deriveTarget({
        accountId: 'account-drive',
        params: { fileId: 'drive-file_123' },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-drive',
      pluginId: 'google-drive',
      toolName: 'document_read',
      resourceId: 'drive-file_123',
    });
    expect(
      create?.deriveTarget({
        accountId: 'account-drive',
        params: {
          title: 'Approved project brief',
          content: 'Safe body.',
        },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-drive',
      pluginId: 'google-drive',
      toolName: 'document_create',
      resourceId: 'new-document',
    });
  });

  it('publishes bounded Canva reads and always-approved stable design creation without credentials', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const search = catalog.resolve('canva.designs.search');
    const read = catalog.resolve('canva.design.read');
    const templates = catalog.resolve('canva.brand_templates.search');
    const dataset = catalog.resolve('canva.brand_template.dataset.read');
    const job = catalog.resolve('canva.autofill_job.read');
    const create = catalog.resolve('canva.design.create');
    const autofill = catalog.resolve('canva.design.autofill');
    const credentials = [
      {
        field: 'canvaClientIdGrant',
        locator: { pluginId: 'canva', fieldId: 'client_id' },
      },
      {
        field: 'canvaClientSecretGrant',
        locator: { pluginId: 'canva', fieldId: 'client_secret' },
      },
      {
        field: 'canvaRefreshGrant',
        locator: { pluginId: 'canva', fieldId: 'refresh_token' },
      },
    ];

    for (const [registration, id, toolName, capability] of [
      [search, 'canva.designs.search', 'designs_search', 'plugin.canva.designs_search'],
      [read, 'canva.design.read', 'design_read', 'plugin.canva.design_read'],
      [
        templates,
        'canva.brand_templates.search',
        'brand_templates_search',
        'plugin.canva.brand_templates_search',
      ],
      [
        dataset,
        'canva.brand_template.dataset.read',
        'brand_template_dataset_read',
        'plugin.canva.brand_template_dataset_read',
      ],
      [job, 'canva.autofill_job.read', 'autofill_job_read', 'plugin.canva.autofill_job_read'],
    ] as const) {
      expect(registration).toMatchObject({
        id,
        risk: 'read-only',
        approval: 'never',
        requiredCapabilities: [capability],
        executor: { kind: 'plugin_tool', pluginId: 'canva', toolName },
        credentialBindings: credentials,
        inputSchema: { type: 'object', additionalProperties: false },
      });
      expect(JSON.stringify(registration?.inputSchema)).not.toMatch(
        /token|credential|secret|clientId|rawQuery/i,
      );
    }
    expect(create).toMatchObject({
      id: 'canva.design.create',
      risk: 'external-side-effect',
      approval: 'always',
      requiredCapabilities: ['plugin.canva.design_create'],
      executor: { kind: 'plugin_tool', pluginId: 'canva', toolName: 'design_create' },
      credentialBindings: credentials,
      inputSchema: { type: 'object', additionalProperties: false },
    });
    expect(autofill).toMatchObject({
      id: 'canva.design.autofill',
      risk: 'external-side-effect',
      approval: 'always',
      requiredCapabilities: ['plugin.canva.design_autofill'],
      executor: { kind: 'plugin_tool', pluginId: 'canva', toolName: 'design_autofill' },
      credentialBindings: credentials,
      inputSchema: { type: 'object', additionalProperties: false },
    });
    expect(JSON.stringify(autofill?.inputSchema)).not.toMatch(
      /token|credential|secret|clientId|rawQuery/i,
    );

    expect(search?.validateParameters({ query: '  launch plan  ', maxResults: 10 })).toEqual({
      query: 'launch plan',
      maxResults: 10,
    });
    expect(read?.validateParameters({ designId: 'DAFVztcvd9z' })).toEqual({
      designId: 'DAFVztcvd9z',
    });
    expect(dataset?.validateParameters({ brandTemplateId: 'DAFBrandTemplate123' })).toEqual({
      brandTemplateId: 'DAFBrandTemplate123',
    });
    expect(job?.validateParameters({ jobId: '450a76e7-f96f-43ae-9c37-0e1ce492ac72' })).toEqual({
      jobId: '450a76e7-f96f-43ae-9c37-0e1ce492ac72',
    });
    expect(
      create?.validateParameters({
        title: '  Approved  launch deck  ',
        preset: 'presentation',
      }),
    ).toEqual({
      title: 'Approved  launch deck',
      preset: 'presentation',
    });
    expect(
      autofill?.validateParameters({
        brandTemplateId: 'DAFBrandTemplate123',
        title: '  Approved launch campaign  ',
        textDataJson: '{"launch_subtitle":"Built with care","launch_headline":"Ship today"}',
      }),
    ).toEqual({
      brandTemplateId: 'DAFBrandTemplate123',
      title: 'Approved launch campaign',
      textDataJson: '{"launch_headline":"Ship today","launch_subtitle":"Built with care"}',
    });
    expect(() =>
      search?.validateParameters({ query: 'launch', maxResults: 2, continuation: 'hidden' }),
    ).toThrow(/unknown fields/i);
    expect(() => read?.validateParameters({ designId: '../private' })).toThrow(/designId/i);
    expect(() =>
      create?.validateParameters({ title: 'Injected\r\nHeader', preset: 'presentation' }),
    ).toThrow(/title/i);
    expect(() => create?.validateParameters({ title: 'Approved', preset: 'social' })).toThrow(
      /preset/i,
    );
    expect(() =>
      autofill?.validateParameters({
        brandTemplateId: 'DAFBrandTemplate123',
        title: 'Approved',
        textDataJson: '{"launch_image":{"url":"https://attacker.invalid"}}',
      }),
    ).toThrow(/autofill/i);
    expect(
      read?.deriveTarget({
        accountId: 'account-canva',
        params: { designId: 'DAFVztcvd9z' },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-canva',
      pluginId: 'canva',
      toolName: 'design_read',
      resourceId: 'DAFVztcvd9z',
    });
    expect(
      create?.deriveTarget({
        accountId: 'account-canva',
        params: { title: 'Approved launch deck', preset: 'presentation' },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-canva',
      pluginId: 'canva',
      toolName: 'design_create',
      resourceId: 'new-design',
    });
    expect(
      autofill?.deriveTarget({
        accountId: 'account-canva',
        params: {
          brandTemplateId: 'DAFBrandTemplate123',
          title: 'Approved launch campaign',
          textDataJson: '{"launch_headline":"Ship today"}',
        },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-canva',
      pluginId: 'canva',
      toolName: 'design_autofill',
      resourceId: 'DAFBrandTemplate123',
    });
  });

  it('publishes Zapier discovery and exact always-approved action execution without credentials', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const discover = catalog.resolve('zapier.actions.discover');
    const invoke = catalog.resolve('zapier.action.invoke');
    const credentials = [
      {
        field: 'zapierConnectionGrant',
        locator: { pluginId: 'zapier', fieldId: 'connection_token' },
      },
    ];
    const fingerprint = `sha256:${'a'.repeat(64)}`;

    expect(discover).toMatchObject({
      id: 'zapier.actions.discover',
      risk: 'read-only',
      approval: 'never',
      requiredCapabilities: ['plugin.zapier.actions_discover'],
      executor: { kind: 'plugin_tool', pluginId: 'zapier', toolName: 'actions_discover' },
      credentialBindings: credentials,
      inputSchema: { type: 'object', additionalProperties: false },
    });
    expect(invoke).toMatchObject({
      id: 'zapier.action.invoke',
      risk: 'external-side-effect',
      approval: 'always',
      requiredCapabilities: ['plugin.zapier.action_invoke'],
      executor: { kind: 'plugin_tool', pluginId: 'zapier', toolName: 'action_invoke' },
      credentialBindings: credentials,
      inputSchema: {
        type: 'object',
        required: ['actionId', 'actionTitle', 'downstreamApp', 'schemaFingerprint', 'inputJson'],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify([discover?.inputSchema, invoke?.inputSchema])).not.toMatch(
      /connection_token|connectionGrant|credential|secret/i,
    );
    expect(discover?.validateParameters({ query: '  slack  ', maxResults: 5 })).toEqual({
      query: 'slack',
      maxResults: 5,
    });
    expect(
      invoke?.validateParameters({
        actionId: 'slack_send_channel_message',
        actionTitle: 'Slack: Send Channel Message',
        downstreamApp: 'Slack',
        schemaFingerprint: fingerprint,
        inputJson: '{ "channel": "C123", "message": "Approved" }',
      }),
    ).toEqual({
      actionId: 'slack_send_channel_message',
      actionTitle: 'Slack: Send Channel Message',
      downstreamApp: 'Slack',
      schemaFingerprint: fingerprint,
      inputJson: '{"channel":"C123","message":"Approved"}',
    });
    expect(() => discover?.validateParameters({ query: 'slack', maxResults: 51 })).toThrow(
      /maxResults/i,
    );
    expect(() =>
      invoke?.validateParameters({
        actionId: 'slack_send_channel_message',
        actionTitle: 'Slack: Send Channel Message',
        downstreamApp: 'Slack',
        schemaFingerprint: fingerprint,
        inputJson: '{}',
        token: 'model-controlled',
      }),
    ).toThrow(/unknown fields/i);
    expect(
      discover?.deriveTarget({
        accountId: 'account-zapier',
        params: { query: 'slack' },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-zapier',
      pluginId: 'zapier',
      toolName: 'actions_discover',
      resourceId: 'currently-exposed-actions',
    });
    expect(
      invoke?.deriveTarget({
        accountId: 'account-zapier',
        params: {
          actionId: 'slack_send_channel_message',
          actionTitle: 'Slack: Send Channel Message',
          downstreamApp: 'Slack',
          schemaFingerprint: fingerprint,
          inputJson: '{"channel":"C123","message":"Approved"}',
        },
      }),
    ).toEqual({
      kind: 'plugin_tool',
      accountId: 'account-zapier',
      pluginId: 'zapier',
      toolName: 'action_invoke',
      resourceId: 'slack_send_channel_message',
    });
  });
});

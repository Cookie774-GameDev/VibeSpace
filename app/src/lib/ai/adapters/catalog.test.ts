import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderCatalog,
  CONNECTION_MODEL_OPTIONS,
  PROVIDER_CATALOG,
  PROVIDER_CONNECTIONS,
  getProviderConnectionDescriptor,
} from './catalog';
import {
  CLI_BRIDGE_EVENT,
  MAX_CLI_PROMPT_CHARS,
  probeCliBridge,
  requireModelId,
  streamCliBridge,
  type CliBridgeEvent,
  type CliProbeRequest,
  type CliStartRequest,
} from './cliBridge';
import { buildClaudeInvocation } from './claude';
import {
  buildCodexInvocation,
  classifyCodexAuthProbe,
  codexCliAdapter,
  CODEX_CLI_DEFINITION,
} from './codex';
import { buildCopilotInvocation } from './copilot';
import { buildGeminiInvocation } from './gemini';
import { buildOpenCodeInvocation } from './opencode';
import { buildQwenInvocation } from './qwen';

const EXPECTED_CONNECTIONS = [
  'openai-codex',
  'openai-api',
  'anthropic-claude-code',
  'anthropic-api',
  'google-gemini-cli',
  'google-gemini-api',
  'google-vertex',
  'github-copilot-cli',
  'xai-api',
  'deepseek-api',
  'zai-api',
  'zai-coding-plan',
  'qwen-code',
  'qwen-api',
  'groq-api',
  'openrouter-api',
  'mistral-api',
  'together-api',
  'ollama-local',
  'opencode-cli',
] as const;

describe('provider capability catalog', () => {
  it('adds the dedicated credential-free smoke surface only behind the exact dev gate', () => {
    const disabled = buildProviderCatalog({ devBuild: true, explicitFlag: undefined });
    const production = buildProviderCatalog({ devBuild: false, explicitFlag: '1' });
    const enabled = buildProviderCatalog({ devBuild: true, explicitFlag: '1' });

    expect(disabled.catalog).not.toHaveProperty('vibespace-kernel-smoke');
    expect(production.catalog).not.toHaveProperty('vibespace-kernel-smoke');
    expect(disabled.connections.some(({ id }) => id === 'vibespace-kernel-smoke-cli')).toBe(false);
    expect(enabled.catalog['vibespace-kernel-smoke']).toMatchObject({
      id: 'vibespace-kernel-smoke',
      externalCli: {
        adapterId: 'vibespace-kernel-smoke-cli',
        connectionId: 'vibespace-kernel-smoke-cli',
        executableName: 'vibespace_kernel_smoke_cli',
      },
    });
    expect(
      enabled.connections.filter(({ providerId }) => providerId === 'vibespace-kernel-smoke'),
    ).toEqual([
      expect.objectContaining({
        id: 'vibespace-kernel-smoke-native',
        adapterId: 'vibespace-kernel-smoke-native',
        providerId: 'vibespace-kernel-smoke',
        mode: 'native-api',
        authSource: 'debug-native-attestation',
        promptTransport: 'native-system',
      }),
      expect.objectContaining({
        id: 'vibespace-kernel-smoke-cli',
        adapterId: 'vibespace-kernel-smoke-cli',
        providerId: 'vibespace-kernel-smoke',
        mode: 'external-cli',
        authSource: 'debug-native-attestation',
      }),
    ]);
  });

  it('covers every implemented chat family and distinct connection', () => {
    expect(Object.keys(PROVIDER_CATALOG)).toEqual([
      'openai',
      'anthropic',
      'google',
      'github',
      'xai',
      'deepseek',
      'zai',
      'qwen',
      'groq',
      'openrouter',
      'mistral',
      'together',
      'ollama',
      'opencode',
    ]);
    expect(PROVIDER_CONNECTIONS.map(({ id }) => id)).toEqual(EXPECTED_CONNECTIONS);
    expect(new Set(PROVIDER_CONNECTIONS.map(({ id }) => id)).size).toBe(
      EXPECTED_CONNECTIONS.length,
    );
  });

  it('keeps every approved connection mode explicit', () => {
    const modes = Object.fromEntries(PROVIDER_CONNECTIONS.map(({ id, mode }) => [id, mode]));
    expect(modes).toEqual({
      'openai-codex': 'external-cli',
      'openai-api': 'native-api',
      'anthropic-claude-code': 'external-cli',
      'anthropic-api': 'native-api',
      'google-gemini-cli': 'external-cli',
      'google-gemini-api': 'native-api',
      'google-vertex': 'native-api',
      'github-copilot-cli': 'external-cli',
      'xai-api': 'native-api',
      'deepseek-api': 'native-api',
      'zai-api': 'native-api',
      'zai-coding-plan': 'external-cli',
      'qwen-code': 'external-cli',
      'qwen-api': 'native-api',
      'groq-api': 'native-api',
      'openrouter-api': 'native-api',
      'mistral-api': 'native-api',
      'together-api': 'native-api',
      'ollama-local': 'local',
      'opencode-cli': 'external-cli',
    });
  });

  it('does not invent external bridges for xAI or DeepSeek', () => {
    for (const id of ['xai', 'deepseek'] as const) {
      expect(PROVIDER_CATALOG[id].externalCli).toBeUndefined();
      expect(PROVIDER_CATALOG[id].connections).toHaveLength(1);
      expect(PROVIDER_CATALOG[id].connections[0]?.mode).toBe('native-api');
    }
  });

  it('keeps Z.AI API and Z.AI Coding Plan as separate catalog identities', () => {
    expect(PROVIDER_CATALOG.zai.connections.map((connection) => connection.id)).toEqual([
      'zai-api',
      'zai-coding-plan',
    ]);
    expect(PROVIDER_CATALOG.zai.connections[0]).toMatchObject({
      id: 'zai-api',
      mode: 'native-api',
      authSource: 'api-key',
    });
    expect(PROVIDER_CATALOG.zai.connections[1]).toMatchObject({
      id: 'zai-coding-plan',
      mode: 'external-cli',
      adapterId: 'opencode-cli',
      authSource: 'opencode-provider-session',
    });
    expect(PROVIDER_CATALOG.zai.externalCli).toMatchObject({
      connectionId: 'zai-coding-plan',
      executableName: 'opencode',
      modelListArgs: ['models', 'zai', '--refresh'],
    });
  });

  it('keeps executable metadata off native and local connection descriptors', () => {
    for (const connection of PROVIDER_CONNECTIONS) {
      expect(Object.isFrozen(connection)).toBe(true);
      expect(Object.isFrozen(connection.capabilities)).toBe(true);
      if (connection.mode !== 'external-cli') {
        expect('executableName' in connection).toBe(false);
      }
    }
  });

  it('declares exact conservative capabilities for every connection surface', () => {
    const external = {
      text: true,
      images: false,
      files: false,
      tools: false,
      modelSelection: true,
      structuredOutput: true,
      streaming: true,
      cancellation: true,
      resumeSession: false,
      systemPrompt: false,
      workingDirectory: true,
      usage: true,
      subscriptionQuota: false,
      localOnly: false,
    };
    expect(getProviderConnectionDescriptor('openai-codex').capabilities).toEqual({
      ...external,
      tools: true,
    });
    expect(getProviderConnectionDescriptor('openai-codex').toolAllowlist).toEqual([
      'vibespace_context',
    ]);
    expect(Object.isFrozen(getProviderConnectionDescriptor('openai-codex').toolAllowlist)).toBe(
      true,
    );
    expect(getProviderConnectionDescriptor('anthropic-claude-code').capabilities).toEqual(external);
    expect(getProviderConnectionDescriptor('google-gemini-cli').capabilities).toEqual({
      ...external,
      modelSelection: false,
    });
    expect(getProviderConnectionDescriptor('github-copilot-cli').capabilities).toEqual({
      ...external,
      streaming: false,
      usage: false,
    });
    expect(getProviderConnectionDescriptor('qwen-code').capabilities).toEqual(external);
    expect(getProviderConnectionDescriptor('opencode-cli').capabilities).toEqual(external);
    expect(getProviderConnectionDescriptor('zai-coding-plan').capabilities).toEqual(external);

    const native = {
      text: true,
      images: false,
      files: false,
      tools: false,
      modelSelection: true,
      structuredOutput: false,
      streaming: true,
      cancellation: true,
      resumeSession: false,
      systemPrompt: true,
      workingDirectory: false,
      usage: true,
      subscriptionQuota: false,
      localOnly: false,
    };
    for (const id of [
      'xai-api',
      'deepseek-api',
      'zai-api',
      'qwen-api',
      'groq-api',
      'openrouter-api',
      'mistral-api',
      'together-api',
    ]) {
      expect(getProviderConnectionDescriptor(id).capabilities).toEqual(native);
    }
    for (const id of ['openai-api', 'anthropic-api', 'google-gemini-api', 'google-vertex']) {
      expect(getProviderConnectionDescriptor(id).capabilities).toEqual({
        ...native,
        images: true,
      });
    }
    expect(getProviderConnectionDescriptor('ollama-local').capabilities).toEqual({
      ...native,
      images: true,
      files: true,
      tools: true,
      localOnly: true,
    });
    expect(() => getProviderConnectionDescriptor('missing')).toThrowError(
      'Unknown provider connection: missing',
    );
  });

  it('exposes only the approved read-only detection and auth vectors', () => {
    expect(PROVIDER_CATALOG.openai.externalCli).toMatchObject({
      executableName: 'codex',
      versionArgs: ['--version'],
      authProbeArgs: ['login', 'status'],
    });
    expect(PROVIDER_CATALOG.anthropic.externalCli).toMatchObject({
      executableName: 'claude',
      versionArgs: ['--version'],
      authProbeArgs: ['auth', 'status'],
    });
    expect(PROVIDER_CATALOG.google.externalCli).toMatchObject({
      executableName: 'gemini',
      versionArgs: ['--version'],
      modelListArgs: ['/model'],
    });
    expect(PROVIDER_CATALOG.google.externalCli?.authProbeArgs).toBeUndefined();
    expect(PROVIDER_CATALOG.github.externalCli).toMatchObject({
      executableName: 'copilot',
      versionArgs: ['version'],
      modelListArgs: ['/model'],
    });
    expect(PROVIDER_CATALOG.github.externalCli?.authProbeArgs).toBeUndefined();
    expect(PROVIDER_CATALOG.qwen.externalCli).toMatchObject({
      executableName: 'qwen',
      versionArgs: ['--version'],
      modelListArgs: ['/model'],
    });
    expect(PROVIDER_CATALOG.qwen.externalCli?.authProbeArgs).toBeUndefined();
    expect(PROVIDER_CATALOG.opencode.externalCli).toMatchObject({
      executableName: 'opencode',
      versionArgs: ['--version'],
      authProbeArgs: ['auth', 'list'],
      modelListArgs: ['models', 'openai', '--refresh'],
    });
  });

  it('publishes a frozen current model catalog only for the Codex subscription connection', () => {
    expect(CONNECTION_MODEL_OPTIONS['openai-codex']?.map((option) => option.id)).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.3-codex',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.5-codex',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
    expect(
      CONNECTION_MODEL_OPTIONS['openai-codex']?.find((option) => option.id === 'gpt-5.3-codex-spark'),
    ).toEqual({
      id: 'gpt-5.3-codex-spark',
      label: 'GPT-5.3 Codex Spark',
      contextWindowTokens: 128_000,
    });
    expect(Object.isFrozen(CONNECTION_MODEL_OPTIONS)).toBe(true);
    expect(Object.isFrozen(CONNECTION_MODEL_OPTIONS['openai-codex'])).toBe(true);
    expect(
      CONNECTION_MODEL_OPTIONS['openai-codex']?.every((option) => Object.isFrozen(option)),
    ).toBe(true);
    expect(CONNECTION_MODEL_OPTIONS['openai-api']).toBeUndefined();
  });

  it('enables the Codex subscription bridge only for an exact ChatGPT login method', () => {
    const probe = (
      stdout: string,
      overrides: Partial<{
        exitCode: number | null;
        stderr: string;
        timedOut: boolean;
        truncated: boolean;
      }> = {},
    ) => ({
      exitCode: overrides.exitCode ?? 0,
      stdout: { data: stdout, truncated: overrides.truncated ?? false },
      stderr: { data: overrides.stderr ?? '', truncated: false },
      timedOut: overrides.timedOut ?? false,
    });

    expect(classifyCodexAuthProbe(probe('Logged in using ChatGPT'))).toEqual({
      status: 'authenticated',
      detail: 'Authenticated through ChatGPT.',
    });
    expect(classifyCodexAuthProbe(probe('Logged in using an API key'))).toEqual({
      status: 'unauthenticated',
      detail: 'Codex is using an API key, not a ChatGPT subscription session.',
    });
    expect(classifyCodexAuthProbe(probe('Unexpected future output'))).toEqual({
      status: 'unauthenticated',
      detail: 'ChatGPT subscription sign-in is not active.',
    });
    for (const result of [
      probe('Logged in using ChatGPT', { truncated: true }),
      probe('', { exitCode: 1 }),
      probe('', { timedOut: true }),
    ]) {
      expect(classifyCodexAuthProbe(result)).toEqual({
        status: 'unknown',
        detail: 'Codex sign-in status could not be verified.',
      });
    }
    expect(CODEX_CLI_DEFINITION.classifyAuthProbe).toBe(classifyCodexAuthProbe);
  });
});

describe('shell-free provider command vectors', () => {
  const prompt = 'explain a & whoami; $(Get-ChildItem) | request';

  it('builds Codex arguments without embedding the prompt', () => {
    const invocation = buildCodexInvocation({
      prompt,
      modelId: 'gpt-5.6-luna',
      workingDirectory: 'C:\\work space',
      reasoningEffort: 'xhigh',
    });
    expect(invocation).toEqual({
      args: [
        'exec',
        '--ignore-user-config',
        '--ephemeral',
        '--json',
        '--cd',
        'C:\\work space',
        '--model',
        'gpt-5.6-luna',
        '-c',
        'model_reasoning_effort="xhigh"',
      ],
      stdin: prompt,
      cwd: 'C:\\work space',
    });
    expect(invocation.args.filter((arg) => arg === '--ignore-user-config')).toHaveLength(1);
    expect(invocation.args.filter((arg) => arg === '--ephemeral')).toHaveLength(1);
    expect(invocation.args.join(' ')).not.toContain(prompt);
  });

  it('passes a validated Codex reasoning effort as a literal config argument', () => {
    expect(
      buildCodexInvocation({
        prompt,
        modelId: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
      }).args,
    ).toEqual([
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--json',
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="xhigh"',
    ]);
    expect(() =>
      buildCodexInvocation({ prompt, reasoningEffort: 'high; Remove-Item C:\\' }),
    ).toThrowError('Codex CLI reasoning effort is unsupported');
  });

  it('marks only an exact Context Map request for the native run-scoped bridge', () => {
    expect(
      buildCodexInvocation({
        prompt,
        modelId: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        tools: { vibespace_context: true },
      }),
    ).toEqual({
      args: ['exec', '--json', '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="xhigh"'],
      stdin: prompt,
      toolScope: 'vibespace_context',
    });
    const invalidToolScopes: ReadonlyArray<Readonly<Record<string, boolean>>> = [
      { 'terminal.list': true },
      { vibespace_context: true, 'terminal.list': true },
    ];
    for (const tools of invalidToolScopes) {
      expect(() => buildCodexInvocation({ prompt, tools })).toThrowError(
        'Codex CLI tool scope is unsupported',
      );
    }
  });

  it('keeps Claude and OpenCode prompts on stdin', () => {
    expect(buildClaudeInvocation({ prompt, modelId: 'claude-sonnet' })).toEqual({
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model',
        'claude-sonnet',
      ],
      stdin: prompt,
    });
    expect(buildOpenCodeInvocation({ prompt, modelId: 'anthropic/claude-sonnet' })).toEqual({
      args: ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet'],
      stdin: prompt,
    });
    expect(
      buildOpenCodeInvocation({
        prompt,
        modelId: 'gpt-5.3-codex-spark',
        reasoningEffort: 'xhigh',
      }),
    ).toEqual({
      args: ['run', '--format', 'json', '--model', 'openai/gpt-5.3-codex-spark#xhigh'],
      stdin: prompt,
    });
  });

  it('keeps required prompt arguments as one literal argument', () => {
    expect(buildGeminiInvocation({ prompt }).args).toEqual([
      '-p',
      prompt,
      '--output-format',
      'stream-json',
    ]);
    expect(buildCopilotInvocation({ prompt, modelId: 'gpt-5' }).args).toEqual([
      '-p',
      prompt,
      '--output-format=json',
      '--model=gpt-5',
    ]);
    expect(buildQwenInvocation({ prompt, modelId: 'qwen3-coder' }).args).toEqual([
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--model',
      'qwen3-coder',
    ]);
  });

  it('keeps option-looking prompts as exact single argv values', () => {
    const optionLookingPrompt = '--yolo --model=attacker/value';
    expect(buildGeminiInvocation({ prompt: optionLookingPrompt }).args).toEqual([
      '-p',
      optionLookingPrompt,
      '--output-format',
      'stream-json',
    ]);
    expect(buildCopilotInvocation({ prompt: optionLookingPrompt, modelId: 'gpt-5' }).args).toEqual([
      '-p',
      optionLookingPrompt,
      '--output-format=json',
      '--model=gpt-5',
    ]);
    expect(
      buildQwenInvocation({ prompt: optionLookingPrompt, modelId: 'qwen3-coder' }).args,
    ).toEqual([
      '-p',
      optionLookingPrompt,
      '--output-format',
      'stream-json',
      '--model',
      'qwen3-coder',
    ]);
  });

  it('forwards Codex cwd separately for Task 2 validation without splitting its argv value', () => {
    const optionLookingCwd = '--dangerously-skip-permissions';
    const invocation = buildCodexInvocation({
      prompt,
      modelId: 'gpt-5.5-codex',
      workingDirectory: optionLookingCwd,
    });

    expect(invocation.args).toEqual([
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--json',
      '--cd',
      optionLookingCwd,
      '--model',
      'gpt-5.5-codex',
    ]);
    expect(invocation.args.filter((value) => value === optionLookingCwd)).toHaveLength(1);
    expect(invocation.cwd).toBe(optionLookingCwd);
  });

  it('never adds dangerous permission-bypass flags', () => {
    const vectors = [
      buildCodexInvocation({ prompt, modelId: 'codex' }),
      buildClaudeInvocation({ prompt, modelId: 'claude' }),
      buildGeminiInvocation({ prompt }),
      buildCopilotInvocation({ prompt, modelId: 'gpt-5' }),
      buildQwenInvocation({ prompt, modelId: 'qwen' }),
      buildOpenCodeInvocation({ prompt, modelId: 'openai/gpt-5' }),
    ];
    const args = vectors.flatMap((invocation) => invocation.args);
    for (const blocked of [
      '--yolo',
      '--allow-all',
      '--dangerously-skip-permissions',
      '--full-auto',
    ]) {
      expect(args).not.toContain(blocked);
    }
  });

  it('rejects prompts beyond the explicit frontend bridge bound', () => {
    const oversized = 'x'.repeat(MAX_CLI_PROMPT_CHARS + 1);
    expect(() => buildGeminiInvocation({ prompt: oversized })).toThrowError(
      `CLI prompt exceeds ${MAX_CLI_PROMPT_CHARS} characters`,
    );
  });

  it('rejects model IDs that could be parsed as provider flags', () => {
    expect(() =>
      buildCodexInvocation({ prompt, modelId: '--dangerously-skip-permissions' }),
    ).toThrowError('Codex CLI model ID contains unsafe characters');
  });

  it('preserves bounded supported model punctuation and spaces as one literal argv item', () => {
    const modelId = 'model family/v2 + preview';
    const vectors = [
      buildCodexInvocation({ prompt, modelId }).args,
      buildClaudeInvocation({ prompt, modelId }).args,
      buildCopilotInvocation({ prompt, modelId }).args,
      buildQwenInvocation({ prompt, modelId }).args,
      buildOpenCodeInvocation({ prompt, modelId }).args,
    ];

    expect(vectors[0]).toContain(modelId);
    expect(vectors[1]).toContain(modelId);
    expect(vectors[2]).toContain(`--model=${modelId}`);
    expect(vectors[3]).toContain(modelId);
    expect(vectors[4]).toContain(modelId);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['option-leading', '--dangerously-skip-permissions'],
    ['control-bearing', 'safe\nunsafe'],
    ['bidi-bearing', 'safe\u202eunsafe'],
    ['oversized', `m${'x'.repeat(512)}`],
  ])('rejects %s model IDs before constructing provider argv', (_label, modelId) => {
    expect(() => requireModelId(modelId, 'Test')).toThrow();
  });
});

describe('fail-closed CLI version detection', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  async function detectCodex() {
    if (!codexCliAdapter.detect) throw new Error('Codex detection is not registered');
    return codexCliAdapter.detect();
  }

  function mockCodexVersionProbe(probe: {
    exitCode: number | null;
    stdout: { data: string; truncated: boolean };
    stderr: { data: string; truncated: boolean };
    timedOut: boolean;
  }): void {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        executables: [
          {
            executableId: 'codex-safe-id',
            requestedName: 'codex',
            executablePath: 'C:\\safe\\codex.exe',
          },
        ],
      })
      .mockResolvedValueOnce(probe);
  }

  it('keeps a bounded well-formed version available', async () => {
    mockCodexVersionProbe({
      exitCode: 0,
      stdout: { data: 'codex-cli 1.2.3\n', truncated: false },
      stderr: { data: '', truncated: false },
      timedOut: false,
    });

    await expect(detectCodex()).resolves.toEqual({
      status: 'available',
      executablePath: 'C:\\safe\\codex.exe',
      version: 'codex-cli 1.2.3',
    });
  });

  it.each([
    [
      'stdout truncation',
      {
        exitCode: 0,
        stdout: { data: 'codex-cli 1.2.3', truncated: true },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'stderr truncation',
      {
        exitCode: 0,
        stdout: { data: 'codex-cli 1.2.3', truncated: false },
        stderr: { data: 'bounded diagnostic', truncated: true },
        timedOut: false,
      },
    ],
    [
      'empty output',
      {
        exitCode: 0,
        stdout: { data: '', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'control-only output',
      {
        exitCode: 0,
        stdout: { data: '\u001b[31m\u0000', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'malformed output',
      {
        exitCode: 0,
        stdout: { data: 'unexpected future response', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'oversized output',
      {
        exitCode: 0,
        stdout: { data: `codex-cli 1.2.3 ${'x'.repeat(256)}`, truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'bidi-bearing output',
      {
        exitCode: 0,
        stdout: { data: 'codex-cli 1.2.3\u202efake', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'secret-shaped output',
      {
        exitCode: 0,
        stdout: { data: 'sk-abcdefgh1234', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: false,
      },
    ],
    [
      'nonzero exit',
      {
        exitCode: 1,
        stdout: { data: 'codex-cli 1.2.3', truncated: false },
        stderr: { data: 'sensitive detail must not surface', truncated: false },
        timedOut: false,
      },
    ],
    [
      'timeout',
      {
        exitCode: null,
        stdout: { data: '', truncated: false },
        stderr: { data: '', truncated: false },
        timedOut: true,
      },
    ],
  ])('requires attention for %s without surfacing probe output', async (_label, probe) => {
    mockCodexVersionProbe(probe);

    const result = await detectCodex();

    expect(result.status).toBe('requires_attention');
    expect(result).not.toHaveProperty('version');
    if (probe.stdout.data) expect(JSON.stringify(result)).not.toContain(probe.stdout.data);
    if (probe.stderr.data) expect(JSON.stringify(result)).not.toContain(probe.stderr.data);
  });

  it('does not surface a raw native detection exception', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error('native bridge failed with token=should-never-surface'),
    );

    const result = await detectCodex();

    expect(result).toEqual({
      status: 'requires_attention',
      detail: 'CLI detection failed.',
    });
    expect(JSON.stringify(result)).not.toContain('should-never-surface');
  });
});

describe('typed Tauri CLI bridge client', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  it('passes probe arguments as an array in the Rust request object', async () => {
    const request: CliProbeRequest = {
      executableId: 'cli-17',
      args: ['auth', 'status', 'literal & argument'],
      timeoutMs: 3_000,
      outputLimitBytes: 16_384,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      exitCode: 0,
      stdout: { data: 'ok', truncated: false },
      stderr: { data: '', truncated: false },
      timedOut: false,
    });

    await expect(probeCliBridge(request)).resolves.toMatchObject({ exitCode: 0 });
    expect(invoke).toHaveBeenCalledWith('cli_bridge_probe', { request });
  });

  it('cancels again after a pending start resolves when abort raced registration', async () => {
    let resolveStart: (() => void) | undefined;
    let emitBridgeEvent: ((event: { payload: CliBridgeEvent }) => void) | undefined;
    const startPending = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      expect(eventName).toBe(CLI_BRIDGE_EVENT);
      emitBridgeEvent = handler as (event: { payload: CliBridgeEvent }) => void;
      return () => {};
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'cli_bridge_start') return startPending;
      if (command === 'cli_bridge_cancel') return true;
      throw new Error(`Unexpected command: ${command}`);
    });

    const request: CliStartRequest = {
      requestId: 'request-pending-start',
      executableId: 'cli-17',
      args: ['exec', '--json'],
      cwd: null,
      stdin: 'hello',
      timeoutMs: 30_000,
      outputLimitBytes: 65_536,
    };
    const controller = new AbortController();
    const stream = streamCliBridge(request, controller.signal);
    const firstEvent = stream.next();
    const aborted = expect(firstEvent).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('cli_bridge_start', { request });
    });
    controller.abort();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('cli_bridge_cancel', {
        requestId: request.requestId,
      });
    });
    resolveStart?.();

    let deferredAssertion: unknown;
    try {
      await vi.waitFor(() => {
        const cancelCalls = vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === 'cli_bridge_cancel');
        expect(cancelCalls).toHaveLength(2);
      });
    } catch (error) {
      deferredAssertion = error;
    } finally {
      emitBridgeEvent?.({
        payload: {
          requestId: request.requestId,
          stream: 'status',
          data: '',
          exitCode: null,
          status: 'cancelled',
        },
      });
      await aborted;
      await stream.return(undefined);
    }

    if (deferredAssertion) throw deferredAssertion;
  });
});

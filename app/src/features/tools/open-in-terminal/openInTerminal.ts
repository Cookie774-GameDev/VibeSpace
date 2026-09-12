import type { CliDetectionResult, CliScanRequest } from '@/lib/ai/adapters/cliBridge';
import type { TerminalExecution } from '@/features/terminals/terminalExecutionStore';

export type OpenInTerminalProviderId =
  | 'opencode'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor-agent'
  | 'cline'
  | 'aider'
  | 'goose'
  | 'qwen'
  | 'openai';

export type OpenInTerminalProvider = Readonly<{
  id: OpenInTerminalProviderId;
  name: string;
  executable: string;
  setup: string;
  setupUrl: string;
}>;

export const OPEN_IN_TERMINAL_PROVIDERS: readonly OpenInTerminalProvider[] = Object.freeze([
  {
    id: 'opencode',
    name: 'OpenCode',
    executable: 'opencode',
    setup: 'Install OpenCode, then connect a model provider from its /connect command.',
    setupUrl: 'https://opencode.ai/docs',
  },
  {
    id: 'claude',
    name: 'Claude / Clawd',
    executable: 'claude',
    setup: 'Install Claude Code and complete its sign-in flow.',
    setupUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
  },
  {
    id: 'codex',
    name: 'Codex',
    executable: 'codex',
    setup: 'Install the Codex CLI and sign in with your OpenAI account.',
    setupUrl: 'https://developers.openai.com/codex/cli',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    executable: 'gemini',
    setup: 'Install Gemini CLI and authenticate a Google account or API key.',
    setupUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    executable: 'cursor-agent',
    setup: 'Install Cursor CLI and complete cursor-agent authentication.',
    setupUrl: 'https://docs.cursor.com/en/cli/installation',
  },
  {
    id: 'cline',
    name: 'Cline',
    executable: 'cline',
    setup: 'Install Cline CLI, then run cline auth.',
    setupUrl: 'https://docs.cline.bot/getting-started/installing-cline',
  },
  {
    id: 'aider',
    name: 'Aider',
    executable: 'aider',
    setup: 'Install Aider and configure a supported model credential.',
    setupUrl: 'https://aider.chat/docs/install.html',
  },
  {
    id: 'goose',
    name: 'Goose',
    executable: 'goose',
    setup: 'Install Goose CLI and configure a provider.',
    setupUrl: 'https://block.github.io/goose/docs/getting-started/installation',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    executable: 'qwen',
    setup: 'Install Qwen Code and complete provider authentication.',
    setupUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/',
  },
  {
    id: 'openai',
    name: 'OpenAI CLI',
    executable: 'openai',
    setup: 'Install the OpenAI CLI and configure its API credential.',
    setupUrl: 'https://platform.openai.com/docs/quickstart',
  },
]);

export type OpenTerminalSession = Readonly<{
  id: string;
  status: 'running' | 'detached';
  lastActiveAt: number;
}>;

export type OpenTerminalInventory = Readonly<{
  total: number;
  active: number;
  idle: number;
}>;

export type OpenTerminalPlatform = 'windows' | 'unix';

export type OpenTerminalLaunchInput = Readonly<{
  desiredTotal: number;
  providerId: OpenInTerminalProviderId | 'custom';
  providerCommand: string;
  directory: string;
  followUp: string;
}>;

export type OpenTerminalLaunchPlan = OpenTerminalLaunchInput &
  Readonly<{
    launchCount: number;
    inventory: OpenTerminalInventory;
    preservedSessionIds: readonly string[];
    startupCommands: readonly string[];
  }>;

const RUN_STORAGE_KEY = 'vibespace.open-in-terminal.run.v1';
const ACTIVE_WINDOW_MS = 60_000;
const MAX_FOLLOW_UP_CHARS = 16_384;

export type PersistedOpenTerminalRun = Readonly<{
  schemaVersion: 1;
  state: 'launching' | 'partial' | 'complete' | 'cancelled';
  desiredTotal: number;
  providerId: string;
  executionIds: readonly string[];
  updatedAt: number;
}>;

function cleanText(value: string): string {
  return value.trim();
}

function assertSafeProviderCommand(command: string): void {
  if (
    !command ||
    command.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(command) ||
    /[;&|`]/u.test(command)
  ) {
    throw new TypeError('Choose a validated terminal provider executable.');
  }
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function quotePosixLiteral(value: string): string {
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}

export function composeStartupCommands(input: {
  platform: OpenTerminalPlatform;
  directory: string;
  providerCommand: string;
  providerIsPath?: boolean;
  followUp: string;
}): string[] {
  const directory = cleanText(input.directory);
  const providerCommand = cleanText(input.providerCommand);
  const followUp = input.followUp.trim();
  if (input.providerIsPath) {
    if (
      !providerCommand ||
      providerCommand.length > 4_096 ||
      /[\u0000\r\n]/u.test(providerCommand)
    ) {
      throw new TypeError('Choose a validated terminal provider executable.');
    }
  } else {
    assertSafeProviderCommand(providerCommand);
  }
  if (followUp.length > MAX_FOLLOW_UP_CHARS || followUp.includes('\u0000')) {
    throw new TypeError(
      `The optional command or prompt must be at most ${MAX_FOLLOW_UP_CHARS} characters.`,
    );
  }
  const commands: string[] = [];
  if (directory) {
    if (/[\u0000\r\n]/u.test(directory)) throw new TypeError('Choose a valid project directory.');
    commands.push(
      input.platform === 'windows'
        ? `Set-Location -LiteralPath ${quotePowerShellLiteral(directory)}`
        : `cd -- ${quotePosixLiteral(directory)}`,
    );
  }
  commands.push(
    input.providerIsPath
      ? input.platform === 'windows'
        ? `& ${quotePowerShellLiteral(providerCommand)}`
        : quotePosixLiteral(providerCommand)
      : providerCommand,
  );
  if (followUp) commands.push(followUp);
  return commands;
}

export function buildLaunchPlan(
  input: OpenTerminalLaunchInput & {
    sessions: readonly OpenTerminalSession[];
    now: number;
    platform: OpenTerminalPlatform;
  },
): OpenTerminalLaunchPlan {
  if (
    !Number.isSafeInteger(input.desiredTotal) ||
    input.desiredTotal < 1 ||
    input.desiredTotal > 10
  ) {
    throw new RangeError('Choose a desired terminal total from 1 through 10.');
  }
  const active = input.sessions.filter(
    (session) =>
      session.status === 'running' && input.now - session.lastActiveAt <= ACTIVE_WINDOW_MS,
  ).length;
  const inventory = Object.freeze({
    total: input.sessions.length,
    active,
    idle: input.sessions.length - active,
  });
  return Object.freeze({
    desiredTotal: input.desiredTotal,
    providerId: input.providerId,
    providerCommand: cleanText(input.providerCommand),
    directory: cleanText(input.directory),
    followUp: input.followUp.trim(),
    inventory,
    launchCount: Math.max(0, input.desiredTotal - inventory.total),
    preservedSessionIds: Object.freeze(input.sessions.map((session) => session.id)),
    startupCommands: Object.freeze(
      composeStartupCommands({
        platform: input.platform,
        directory: input.directory,
        providerCommand: input.providerCommand,
        providerIsPath: input.providerId === 'custom',
        followUp: input.followUp,
      }),
    ),
  });
}

function persistedRun(value: unknown): PersistedOpenTerminalRun | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<PersistedOpenTerminalRun>;
  if (
    row.schemaVersion !== 1 ||
    !['launching', 'partial', 'complete', 'cancelled'].includes(row.state ?? '') ||
    !Number.isSafeInteger(row.desiredTotal) ||
    (row.desiredTotal ?? 0) < 1 ||
    (row.desiredTotal ?? 0) > 10 ||
    typeof row.providerId !== 'string' ||
    !Array.isArray(row.executionIds) ||
    row.executionIds.some((id) => typeof id !== 'string' || id.length > 160) ||
    !Number.isSafeInteger(row.updatedAt)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    state: row.state!,
    desiredTotal: row.desiredTotal!,
    providerId: row.providerId,
    executionIds: Object.freeze([...row.executionIds]),
    updatedAt: row.updatedAt!,
  });
}

export function savePersistedRun(
  receipt: PersistedOpenTerminalRun,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  storage.setItem(RUN_STORAGE_KEY, JSON.stringify(receipt));
}

export function loadPersistedRun(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): PersistedOpenTerminalRun | null {
  const raw = storage.getItem(RUN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return persistedRun(JSON.parse(raw));
  } catch {
    return null;
  }
}

export type OpenTerminalProviderDetection = Readonly<{
  available: readonly (OpenInTerminalProvider & { executablePath: string })[];
  unavailable: readonly OpenInTerminalProvider[];
}>;

type QueueRequest = Readonly<{
  command: string;
  label: string;
  startupCommands: readonly string[];
  cwd?: string;
  preserveExisting: true;
}>;

export type OpenInTerminalRuntimeDependencies = Readonly<{
  listProjectSessions(): Promise<readonly OpenTerminalSession[]>;
  validateDirectory(path: string): Promise<string>;
  scanExecutables(request: CliScanRequest): Promise<CliDetectionResult>;
  queue(request: QueueRequest): string;
  cancelQueued(id: string): boolean;
  cancelRunning(sessionId: string): Promise<void>;
  readExecution(id: string): TerminalExecution | undefined;
  markQueued(id: string): void;
  navigateToTerminals(): void;
  now(): number;
  platform: OpenTerminalPlatform;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}>;

export type OpenInTerminalRuntime = ReturnType<typeof createOpenInTerminalRuntime>;

async function defaultDependencies(): Promise<OpenInTerminalRuntimeDependencies> {
  const [
    { useAuthStore },
    { terminalSessionRepo },
    { scanCliBridge },
    queueModule,
    executionModule,
    { useUIStore },
    { invoke },
  ] = await Promise.all([
    import('@/stores/auth'),
    import('@/lib/db/repositories'),
    import('@/lib/ai/adapters/cliBridge'),
    import('@/features/terminals/terminalCommandQueue'),
    import('@/features/terminals/terminalExecutionStore'),
    import('@/stores/ui'),
    import('@tauri-apps/api/core'),
  ]);
  return {
    async listProjectSessions() {
      const auth = useAuthStore.getState();
      if (!auth.workspaceId) throw new Error('Open a workspace before launching terminal agents.');
      const rows = auth.projectId
        ? await terminalSessionRepo.listByProject(auth.projectId)
        : await terminalSessionRepo.listByWorkspace(auth.workspaceId);
      return rows
        .filter((row) => row.status !== 'exited')
        .map((row) => ({
          id: row.id,
          status: row.status === 'running' ? ('running' as const) : ('detached' as const),
          lastActiveAt: row.last_active_at,
        }));
    },
    validateDirectory: (path) => invoke<string>('terminal_validate_directory', { path }),
    scanExecutables: scanCliBridge,
    queue: (request) =>
      queueModule.enqueueTerminalCommand({
        command: request.command,
        label: request.label,
        startupCommands: [...request.startupCommands],
        cwd: request.cwd,
        preserveExisting: true,
      }),
    cancelQueued: queueModule.cancelQueuedTerminalCommand,
    async cancelRunning(sessionId) {
      await invoke('terminal_kill', { sessionId });
    },
    readExecution: (id) => executionModule.useTerminalExecutionStore.getState().executions[id],
    markQueued: (id) => executionModule.markTerminalExecution(id, 'queued'),
    navigateToTerminals: () => useUIStore.getState().setRoute('terminal'),
    now: Date.now,
    platform: navigator.userAgent.includes('Windows') ? 'windows' : 'unix',
    storage: window.localStorage,
  };
}

export function createOpenInTerminalRuntime(dependencies: OpenInTerminalRuntimeDependencies) {
  const detect = async (customPath?: string): Promise<OpenTerminalProviderDetection> => {
    const result = await dependencies.scanExecutables({
      executableNames: OPEN_IN_TERMINAL_PROVIDERS.map((provider) => provider.executable),
      customPath: customPath?.trim() || null,
      customPathConfirmed: Boolean(customPath?.trim()),
    });
    const paths = new Map(
      result.executables
        .filter((item) => item.requestedName)
        .map((item) => [item.requestedName!, item.executablePath]),
    );
    return Object.freeze({
      available: Object.freeze(
        OPEN_IN_TERMINAL_PROVIDERS.flatMap((provider) => {
          const executablePath = paths.get(provider.executable);
          return executablePath ? [{ ...provider, executablePath }] : [];
        }),
      ),
      unavailable: Object.freeze(
        OPEN_IN_TERMINAL_PROVIDERS.filter((provider) => !paths.has(provider.executable)),
      ),
    });
  };

  const inspect = async (): Promise<OpenTerminalSession[]> => [
    ...(await dependencies.listProjectSessions()),
  ];

  const launch = async (
    input: OpenTerminalLaunchInput,
    controls?: Readonly<{
      shouldCancel?: () => boolean;
      onProgress?: (completed: number, total: number) => void;
    }>,
  ) => {
    let providerCommand = input.providerCommand.trim();
    if (input.providerId === 'custom') {
      const custom = await dependencies.scanExecutables({
        executableNames: [],
        customPath: providerCommand || null,
        customPathConfirmed: true,
      });
      const executable = custom.executables[0];
      if (!executable) throw new Error('The custom executable is unavailable.');
      providerCommand = executable.executablePath;
    } else {
      const provider = OPEN_IN_TERMINAL_PROVIDERS.find((item) => item.id === input.providerId);
      if (!provider || provider.executable !== providerCommand) {
        throw new Error('The selected terminal provider is unavailable.');
      }
    }
    const validatedDirectory = input.directory.trim()
      ? await dependencies.validateDirectory(input.directory.trim())
      : '';
    const plan = buildLaunchPlan({
      ...input,
      providerCommand,
      directory: validatedDirectory,
      sessions: await inspect(),
      now: dependencies.now(),
      platform: dependencies.platform,
    });
    const executionIds: string[] = [];
    const failures: Array<{ index: number; error: string }> = [];
    for (let index = 0; index < plan.launchCount; index += 1) {
      if (controls?.shouldCancel?.()) break;
      try {
        const id = dependencies.queue({
          command: providerCommand,
          label: `${input.providerId} ${index + 1}`,
          startupCommands: plan.startupCommands,
          ...(validatedDirectory ? { cwd: validatedDirectory } : {}),
          preserveExisting: true,
        });
        dependencies.markQueued(id);
        executionIds.push(id);
      } catch (error) {
        failures.push({
          index,
          error: error instanceof Error ? error.message : 'Terminal queue unavailable.',
        });
      }
      controls?.onProgress?.(index + 1, plan.launchCount);
    }
    const cancelled = Boolean(controls?.shouldCancel?.());
    const state = cancelled
      ? 'cancelled'
      : failures.length > 0
        ? 'partial'
        : plan.launchCount === 0
          ? 'complete'
          : 'launching';
    if (dependencies.storage) {
      savePersistedRun(
        {
          schemaVersion: 1,
          state,
          desiredTotal: plan.desiredTotal,
          providerId: plan.providerId,
          executionIds,
          updatedAt: dependencies.now(),
        },
        dependencies.storage,
      );
    }
    return Object.freeze({
      plan,
      executionIds: Object.freeze(executionIds),
      failures: Object.freeze(failures),
      cancelled,
    });
  };

  const cancel = async (ids: readonly string[]): Promise<void> => {
    await Promise.all(
      ids.map(async (id) => {
        if (dependencies.cancelQueued(id)) return;
        const execution = dependencies.readExecution(id);
        if (
          execution?.sessionId &&
          !['complete', 'failed', 'cancelled'].includes(execution.status)
        ) {
          await dependencies.cancelRunning(execution.sessionId);
        }
      }),
    );
  };

  return Object.freeze({
    detect,
    inspect,
    launch,
    cancel,
    readExecution: dependencies.readExecution,
    navigateToTerminals: dependencies.navigateToTerminals,
  });
}

let productionRuntime: Promise<OpenInTerminalRuntime> | undefined;

export async function getOpenInTerminalRuntime(): Promise<OpenInTerminalRuntime> {
  productionRuntime ??= defaultDependencies().then(createOpenInTerminalRuntime);
  return productionRuntime;
}

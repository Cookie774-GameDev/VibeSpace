import { CLAUDE_CLI_DEFINITION } from './claude';
import { CODEX_CLI_DEFINITION } from './codex';
import { COPILOT_CLI_DEFINITION } from './copilot';
import { GEMINI_CLI_DEFINITION } from './gemini';
import {
  ANTHROPIC_API_CONNECTION,
  DEEPSEEK_API_CONNECTION,
  GEMINI_API_CONNECTION,
  GROQ_API_CONNECTION,
  MISTRAL_API_CONNECTION,
  OLLAMA_LOCAL_CONNECTION,
  OPENAI_API_CONNECTION,
  OPENROUTER_API_CONNECTION,
  QWEN_API_CONNECTION,
  TOGETHER_API_CONNECTION,
  VERTEX_API_CONNECTION,
  XAI_API_CONNECTION,
  ZAI_API_CONNECTION,
} from './nativeCatalog';
import { OPENCODE_CLI_DEFINITION } from './opencode';
import { QWEN_CLI_DEFINITION } from './qwen';
import { KERNEL_SMOKE_CLI_DEFINITION, type CliProviderDefinition } from './cliBridge';
import type { ProviderCapabilities, ProviderConnection } from './types';
import { isKernelSmokeEnabled, type KernelSmokeConfigInput } from '@/lib/jarvis/smoke/config';

type BaseProviderFamilyId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'github'
  | 'xai'
  | 'deepseek'
  | 'zai'
  | 'qwen'
  | 'groq'
  | 'openrouter'
  | 'mistral'
  | 'together'
  | 'ollama'
  | 'opencode';

export type ProviderFamilyId = BaseProviderFamilyId | 'vibespace-kernel-smoke';

export interface ProviderFamilyDescriptor {
  id: ProviderFamilyId;
  displayName: string;
  connections: readonly Readonly<ProviderConnection>[];
  externalCli?: ExternalCliCatalogDescriptor;
}

export interface ExternalCliCatalogDescriptor {
  adapterId: string;
  connectionId: string;
  executableName: string;
  promptTransport: 'prefixed-preamble' | 'unsupported';
  versionArgs: readonly string[];
  authProbeArgs?: readonly string[];
  modelListArgs?: readonly string[];
}

function externalCapabilities(
  overrides: Partial<ProviderCapabilities> = {},
): Readonly<ProviderCapabilities> {
  return Object.freeze({
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
    ...overrides,
  });
}

function externalConnection(input: {
  id: string;
  adapterId: string;
  providerId: string;
  displayName: string;
  authSource: string;
  promptTransport: 'prefixed-preamble' | 'unsupported';
  capabilities?: Partial<ProviderCapabilities>;
  toolAllowlist?: ProviderConnection['toolAllowlist'];
}): Readonly<ProviderConnection> {
  return Object.freeze({
    id: input.id,
    adapterId: input.adapterId,
    providerId: input.providerId,
    displayName: input.displayName,
    mode: 'external-cli' as const,
    authSource: input.authSource,
    capabilities: externalCapabilities(input.capabilities),
    ...(input.toolAllowlist ? { toolAllowlist: Object.freeze([...input.toolAllowlist]) } : {}),
    promptTransport: input.promptTransport,
    enabled: true,
  });
}

export const CODEX_CLI_CONNECTION = externalConnection({
  id: 'openai-codex',
  adapterId: CODEX_CLI_DEFINITION.adapterId,
  providerId: 'openai',
  displayName: 'Codex CLI',
  authSource: 'codex-cli-session',
  promptTransport: CODEX_CLI_DEFINITION.promptTransport,
  capabilities: { tools: true },
  toolAllowlist: ['vibespace_context'],
});

export interface ConnectionModelOption {
  id: string;
  label: string;
  contextWindowTokens?: number;
}

function frozenModelOption(
  id: string,
  label: string,
  contextWindowTokens?: number,
): Readonly<ConnectionModelOption> {
  return Object.freeze({
    id,
    label,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  });
}

export const CONNECTION_MODEL_OPTIONS: Readonly<
  Partial<Record<string, readonly Readonly<ConnectionModelOption>[]>>
> = Object.freeze({
  'openai-codex': Object.freeze([
    frozenModelOption('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 128_000),
    frozenModelOption('gpt-5.3-codex', 'GPT-5.3 Codex', 1_000_000),
    frozenModelOption('gpt-5.4-mini', 'GPT-5.4 Mini', 1_000_000),
    frozenModelOption('gpt-5.4', 'GPT-5.4', 1_000_000),
    frozenModelOption('gpt-5.5-codex', 'GPT-5.5 Codex', 1_000_000),
    frozenModelOption('gpt-5.5', 'GPT-5.5', 1_000_000),
    frozenModelOption('gpt-5.5-pro', 'GPT-5.5 Pro', 1_000_000),
    frozenModelOption('gpt-5.6-luna', 'GPT-5.6 Luna', 1_000_000),
    frozenModelOption('gpt-5.6-terra', 'GPT-5.6 Terra', 1_000_000),
    frozenModelOption('gpt-5.6-sol', 'GPT-5.6 Sol', 1_000_000),
  ]),
});

export const CLAUDE_CLI_CONNECTION = externalConnection({
  id: 'anthropic-claude-code',
  adapterId: CLAUDE_CLI_DEFINITION.adapterId,
  providerId: 'anthropic',
  displayName: 'Claude Code CLI',
  authSource: 'claude-code-session',
  promptTransport: CLAUDE_CLI_DEFINITION.promptTransport,
});

export const GEMINI_CLI_CONNECTION = externalConnection({
  id: 'google-gemini-cli',
  adapterId: GEMINI_CLI_DEFINITION.adapterId,
  providerId: 'google',
  displayName: 'Gemini CLI',
  authSource: 'gemini-cli-session',
  promptTransport: GEMINI_CLI_DEFINITION.promptTransport,
  capabilities: { modelSelection: false },
});

export const COPILOT_CLI_CONNECTION = externalConnection({
  id: 'github-copilot-cli',
  adapterId: COPILOT_CLI_DEFINITION.adapterId,
  providerId: 'github',
  displayName: 'GitHub Copilot CLI',
  authSource: 'github-copilot-session',
  promptTransport: COPILOT_CLI_DEFINITION.promptTransport,
  capabilities: { streaming: false, usage: false },
});

export const QWEN_CLI_CONNECTION = externalConnection({
  id: 'qwen-code',
  adapterId: QWEN_CLI_DEFINITION.adapterId,
  providerId: 'qwen',
  displayName: 'Qwen Code CLI',
  authSource: 'qwen-code-session',
  promptTransport: QWEN_CLI_DEFINITION.promptTransport,
});

export const ZAI_CODING_PLAN_CONNECTION = externalConnection({
  id: 'zai-coding-plan',
  adapterId: OPENCODE_CLI_DEFINITION.adapterId,
  providerId: 'zai',
  displayName: 'Z.AI Coding Plan',
  authSource: 'opencode-provider-session',
  promptTransport: OPENCODE_CLI_DEFINITION.promptTransport,
});

export const OPENCODE_CLI_CONNECTION = externalConnection({
  id: 'opencode-cli',
  adapterId: OPENCODE_CLI_DEFINITION.adapterId,
  providerId: 'opencode',
  displayName: 'OpenCode Bridge',
  authSource: 'opencode-provider-session',
  promptTransport: OPENCODE_CLI_DEFINITION.promptTransport,
});

function family(
  id: ProviderFamilyId,
  displayName: string,
  connections: readonly Readonly<ProviderConnection>[],
  externalCli?: ExternalCliCatalogDescriptor,
): Readonly<ProviderFamilyDescriptor> {
  for (const connection of connections) {
    if (connection.mode !== 'external-cli') continue;
    if (
      !externalCli ||
      externalCli.adapterId !== connection.adapterId ||
      externalCli.connectionId !== connection.id ||
      externalCli.promptTransport !== connection.promptTransport
    ) {
      throw new Error(`External prompt transport mismatch: ${connection.id}`);
    }
  }
  return Object.freeze({
    id,
    displayName,
    connections: Object.freeze([...connections]),
    ...(externalCli ? { externalCli } : {}),
  });
}

function externalCliDescriptor(
  definition: CliProviderDefinition,
): Readonly<ExternalCliCatalogDescriptor> {
  return Object.freeze({
    adapterId: definition.adapterId,
    connectionId: definition.connectionId,
    executableName: definition.executableName,
    promptTransport: definition.promptTransport,
    versionArgs: definition.versionArgs,
    ...(definition.authProbeArgs ? { authProbeArgs: definition.authProbeArgs } : {}),
    ...(definition.modelListArgs ? { modelListArgs: definition.modelListArgs } : {}),
  });
}

const CODEX_CLI_SURFACE = externalCliDescriptor(CODEX_CLI_DEFINITION);
const CLAUDE_CLI_SURFACE = externalCliDescriptor(CLAUDE_CLI_DEFINITION);
const GEMINI_CLI_SURFACE = externalCliDescriptor(GEMINI_CLI_DEFINITION);
const COPILOT_CLI_SURFACE = externalCliDescriptor(COPILOT_CLI_DEFINITION);
const QWEN_CLI_SURFACE = externalCliDescriptor(QWEN_CLI_DEFINITION);
const OPENCODE_CLI_SURFACE = externalCliDescriptor(OPENCODE_CLI_DEFINITION);
const ZAI_CODING_PLAN_SURFACE: Readonly<ExternalCliCatalogDescriptor> = Object.freeze({
  adapterId: OPENCODE_CLI_DEFINITION.adapterId,
  connectionId: ZAI_CODING_PLAN_CONNECTION.id,
  executableName: OPENCODE_CLI_DEFINITION.executableName,
  promptTransport: OPENCODE_CLI_DEFINITION.promptTransport,
  versionArgs: OPENCODE_CLI_DEFINITION.versionArgs,
  ...(OPENCODE_CLI_DEFINITION.authProbeArgs
    ? { authProbeArgs: OPENCODE_CLI_DEFINITION.authProbeArgs }
    : {}),
  modelListArgs: Object.freeze(['models', 'zai', '--refresh']),
});
const KERNEL_SMOKE_CLI_SURFACE = externalCliDescriptor(KERNEL_SMOKE_CLI_DEFINITION);

const KERNEL_SMOKE_CLI_CONNECTION = externalConnection({
  id: KERNEL_SMOKE_CLI_DEFINITION.connectionId,
  adapterId: KERNEL_SMOKE_CLI_DEFINITION.adapterId,
  providerId: 'vibespace-kernel-smoke',
  displayName: 'VibeSpace Kernel Smoke',
  authSource: 'debug-native-attestation',
  promptTransport: KERNEL_SMOKE_CLI_DEFINITION.promptTransport,
  capabilities: { localOnly: true },
});

const KERNEL_SMOKE_NATIVE_CONNECTION: Readonly<ProviderConnection> = Object.freeze({
  id: 'vibespace-kernel-smoke-native',
  adapterId: 'vibespace-kernel-smoke-native',
  providerId: 'vibespace-kernel-smoke',
  displayName: 'VibeSpace Kernel Smoke Provider',
  mode: 'native-api',
  authSource: 'debug-native-attestation',
  capabilities: externalCapabilities({
    systemPrompt: true,
    workingDirectory: false,
    localOnly: true,
  }),
  promptTransport: 'native-system',
  enabled: true,
});

type ProviderCatalog = Readonly<
  Record<BaseProviderFamilyId, Readonly<ProviderFamilyDescriptor>> &
    Partial<Record<'vibespace-kernel-smoke', Readonly<ProviderFamilyDescriptor>>>
>;

const BASE_PROVIDER_CATALOG: Readonly<
  Record<BaseProviderFamilyId, Readonly<ProviderFamilyDescriptor>>
> = Object.freeze({
  openai: family(
    'openai',
    'OpenAI',
    [CODEX_CLI_CONNECTION, OPENAI_API_CONNECTION],
    CODEX_CLI_SURFACE,
  ),
  anthropic: family(
    'anthropic',
    'Anthropic',
    [CLAUDE_CLI_CONNECTION, ANTHROPIC_API_CONNECTION],
    CLAUDE_CLI_SURFACE,
  ),
  google: family(
    'google',
    'Google',
    [GEMINI_CLI_CONNECTION, GEMINI_API_CONNECTION, VERTEX_API_CONNECTION],
    GEMINI_CLI_SURFACE,
  ),
  github: family('github', 'GitHub', [COPILOT_CLI_CONNECTION], COPILOT_CLI_SURFACE),
  xai: family('xai', 'xAI', [XAI_API_CONNECTION]),
  deepseek: family('deepseek', 'DeepSeek', [DEEPSEEK_API_CONNECTION]),
  zai: family(
    'zai',
    'Z.AI / GLM',
    [ZAI_API_CONNECTION, ZAI_CODING_PLAN_CONNECTION],
    ZAI_CODING_PLAN_SURFACE,
  ),
  qwen: family('qwen', 'Qwen', [QWEN_CLI_CONNECTION, QWEN_API_CONNECTION], QWEN_CLI_SURFACE),
  groq: family('groq', 'Groq', [GROQ_API_CONNECTION]),
  openrouter: family('openrouter', 'OpenRouter', [OPENROUTER_API_CONNECTION]),
  mistral: family('mistral', 'Mistral', [MISTRAL_API_CONNECTION]),
  together: family('together', 'Together AI', [TOGETHER_API_CONNECTION]),
  ollama: family('ollama', 'Ollama', [OLLAMA_LOCAL_CONNECTION]),
  opencode: family('opencode', 'OpenCode', [OPENCODE_CLI_CONNECTION], OPENCODE_CLI_SURFACE),
});

const BASE_PROVIDER_CONNECTIONS: readonly Readonly<ProviderConnection>[] = Object.freeze([
  CODEX_CLI_CONNECTION,
  OPENAI_API_CONNECTION,
  CLAUDE_CLI_CONNECTION,
  ANTHROPIC_API_CONNECTION,
  GEMINI_CLI_CONNECTION,
  GEMINI_API_CONNECTION,
  VERTEX_API_CONNECTION,
  COPILOT_CLI_CONNECTION,
  XAI_API_CONNECTION,
  DEEPSEEK_API_CONNECTION,
  ZAI_API_CONNECTION,
  ZAI_CODING_PLAN_CONNECTION,
  QWEN_CLI_CONNECTION,
  QWEN_API_CONNECTION,
  GROQ_API_CONNECTION,
  OPENROUTER_API_CONNECTION,
  MISTRAL_API_CONNECTION,
  TOGETHER_API_CONNECTION,
  OLLAMA_LOCAL_CONNECTION,
  OPENCODE_CLI_CONNECTION,
]);

export function buildProviderCatalog(config: KernelSmokeConfigInput): Readonly<{
  catalog: ProviderCatalog;
  connections: readonly Readonly<ProviderConnection>[];
}> {
  const smokeEnabled = isKernelSmokeEnabled(config);
  return Object.freeze({
    catalog: Object.freeze({
      ...BASE_PROVIDER_CATALOG,
      ...(smokeEnabled
        ? {
            'vibespace-kernel-smoke': family(
              'vibespace-kernel-smoke',
              'VibeSpace Kernel Smoke',
              [KERNEL_SMOKE_NATIVE_CONNECTION, KERNEL_SMOKE_CLI_CONNECTION],
              KERNEL_SMOKE_CLI_SURFACE,
            ),
          }
        : {}),
    }) as ProviderCatalog,
    connections: Object.freeze([
      ...BASE_PROVIDER_CONNECTIONS,
      ...(smokeEnabled ? [KERNEL_SMOKE_NATIVE_CONNECTION, KERNEL_SMOKE_CLI_CONNECTION] : []),
    ]),
  });
}

const BUILT_PROVIDER_CATALOG = buildProviderCatalog({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

export const PROVIDER_CATALOG = BUILT_PROVIDER_CATALOG.catalog;
export const PROVIDER_CONNECTIONS = BUILT_PROVIDER_CATALOG.connections;

const CONNECTIONS_BY_ID = new Map(
  PROVIDER_CONNECTIONS.map((connection) => [connection.id, connection]),
);

export function getProviderConnectionDescriptor(
  connectionId: string,
): Readonly<ProviderConnection> {
  const connection = CONNECTIONS_BY_ID.get(connectionId);
  if (!connection) throw new Error(`Unknown provider connection: ${connectionId}`);
  return connection;
}

export const providerCatalog = PROVIDER_CATALOG;

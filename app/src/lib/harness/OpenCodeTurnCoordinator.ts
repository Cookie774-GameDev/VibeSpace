import {
  DEFAULT_CHAT_RUNTIME_SETTINGS,
  applyChatRuntimeCommand,
  parseChatRuntimeCommand,
  type ApplyRuntimeCommandResult,
  type ChatRuntimeSettings,
} from '../../features/chat/runtime/chatRuntimeCommandController';
import {
  resolveRuntimeModelControls,
  type LiveModelRuntimeMetadata,
} from '../../features/chat/runtime/runtimeModelControls';
import {
  buildEffectivePermissionProfile,
  type AgentApprovalMode,
  type AccessLevel,
  type EffectivePermissionProfile,
  type InteractionMode,
  type OpenCodeExecutionAgentId,
} from '../permissions/OpenCodePermissionProfile';
import {
  buildOpenCodeRequestControls,
  type OpenCodeRequestControls,
} from './OpenCodeRequestControls';
import {
  canonicalOpenCodeSkillBasePath,
  type OpenCodeCommandDescriptor,
  type OpenCodeNativeSkillDescriptor,
} from './OpenCodeSdkSessionClient';
import {
  OpenCodeSessionPool,
  type HarnessScope,
  type OpenCodeSessionClient,
} from './OpenCodeSessionPool';

export interface ExactModelSelection {
  connectionId: string;
  providerId: string;
  modelId: string;
  metadata: LiveModelRuntimeMetadata;
}

/** Exact chat-scoped reference to a native or compatible discovered skill. */
export interface OpenCodeNativeSkillReference {
  origin: 'opencode' | 'codex';
  name: string;
  path: string;
  executionHost: string;
  sourceRevision: string;
}

export interface PersistentOpenCodeTurnClient extends OpenCodeSessionClient {
  sendAsync(input: {
    sessionId: string;
    controls: OpenCodeRequestControls;
    text: string;
    system?: string;
    agent: OpenCodeExecutionAgentId;
    tools?: Readonly<Record<string, boolean>>;
  }): Promise<void>;
  sendCommandAsync?(input: {
    sessionId: string;
    controls: OpenCodeRequestControls;
    command: string;
    arguments: string;
    agent: OpenCodeExecutionAgentId;
    signal?: AbortSignal;
  }): Promise<void>;
  listCommandsAsync?(): Promise<readonly OpenCodeCommandDescriptor[]>;
  listSkillsAsync?(): Promise<readonly OpenCodeNativeSkillDescriptor[]>;
}

export interface TurnPolicyInput {
  mode: InteractionMode;
  access: AccessLevel;
  approveAllForRun: boolean;
  /** Persisted per-chat Agent profile captured for this exact dispatch. */
  agentApprovalMode?: AgentApprovalMode;
  projectRoot: string;
}

export interface OpenCodeTurnInput {
  scope: HarnessScope;
  chatId: string;
  chatTitle?: string;
  text: string;
  settings?: Readonly<ChatRuntimeSettings>;
  selection: Readonly<ExactModelSelection>;
  policy: Readonly<TurnPolicyInput>;
  system?: string;
  agent?: string;
  tools?: Readonly<Record<string, boolean>>;
  /** Selected native skills, revalidated against the active OpenCode host before dispatch. */
  nativeSkillRefs?: readonly OpenCodeNativeSkillReference[];
  expectedSessionId?: string;
  requireExactRuntimeControls?: boolean;
  signal?: AbortSignal;
}

export type OpenCodeTurnResult =
  | {
      kind: 'command';
      commandResult: ApplyRuntimeCommandResult;
      settings: ChatRuntimeSettings;
    }
  | {
      kind: 'rejected';
      code: 'MODEL_CONTROL_UNSUPPORTED' | 'HARNESS_INCOMPATIBLE';
      message: string;
      settings: ChatRuntimeSettings;
    }
  | {
      kind: 'dispatched';
      /** Native commands finish only after tools/approvals; consume events meanwhile. */
      commandOutcome?: Promise<{ ok: true } | { ok: false; error: unknown }>;
      sessionId: string;
      runtimeGeneration: string;
      controls: OpenCodeRequestControls;
      permissions: EffectivePermissionProfile;
      settings: ChatRuntimeSettings;
    };

function isPersistentTurnClient(
  client: OpenCodeSessionClient,
): client is PersistentOpenCodeTurnClient {
  return typeof (client as Partial<PersistentOpenCodeTurnClient>).sendAsync === 'function';
}

function slashCommandCandidate(text: string): { command: string; arguments: string } | null {
  const match = text.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]+))?$/iu);
  if (!match) return null;
  return { command: match[1]!.toLowerCase(), arguments: (match[2] ?? '').trim() };
}

function nativeSkillReferenceError(
  refs: readonly OpenCodeNativeSkillReference[],
  catalog?: readonly OpenCodeNativeSkillDescriptor[],
): string | undefined {
  const selectedNames = new Set<string>();
  for (const ref of refs) {
    if (
      !ref ||
      (ref.origin !== 'opencode' && ref.origin !== 'codex') ||
      typeof ref.name !== 'string' || !ref.name || ref.name.length > 256 || ref.name !== ref.name.trim() ||
      /[\u0000-\u001f\u007f]/u.test(ref.name) ||
      typeof ref.sourceRevision !== 'string' || !ref.sourceRevision || ref.sourceRevision.length > 512 ||
      ref.sourceRevision !== ref.sourceRevision.trim() ||
      ref.executionHost !== 'local'
    ) return 'A selected skill reference is invalid or belongs to a non-local execution host.';
    if (selectedNames.has(ref.name)) {
      return 'Selected native skills contain an ambiguous duplicate name.';
    }
    selectedNames.add(ref.name);
    const selectedBase = canonicalOpenCodeSkillBasePath(ref.path);
    if (!selectedBase) return `Selected native skill ${ref.name} has an invalid path.`;
    if (!catalog) continue;
    const matches = catalog.filter((skill) => skill.name === ref.name);
    if (matches.length !== 1) {
      return `Selected native skill ${ref.name} is not unique in the active OpenCode catalog.`;
    }
    const nativeBase = canonicalOpenCodeSkillBasePath(matches[0]?.location);
    if (!nativeBase || nativeBase !== selectedBase) {
      return `Selected native skill ${ref.name} no longer matches its verified native path.`;
    }
  }
  return undefined;
}

function systemWithNativeSkillReminder(
  baseSystem: string | undefined,
  refs: readonly OpenCodeNativeSkillReference[],
): string {
  const names = JSON.stringify(refs.map((ref) => ref.name));
  const reminder =
    `Before answering, load every selected skill by calling the native OpenCode skill tool ` +
    `with each exact name in this JSON array: ${names}. Complete these loads in the same turn, ` +
    'then continue the user\'s original request. Do not claim a skill is loaded unless its native tool call completes successfully.';
  return baseSystem?.trim() ? `${baseSystem}\n\n${reminder}` : reminder;
}

/**
 * Central production seam for one VibeSpace Chat turn. Commands are consumed by
 * VibeSpace, exact controls are validated before send, permission authority is
 * derived once, and a chat reuses its persistent OpenCode server/session.
 */
export class OpenCodeTurnCoordinator {
  constructor(private readonly sessions: OpenCodeSessionPool) {}

  async dispatch(input: Readonly<OpenCodeTurnInput>): Promise<OpenCodeTurnResult> {
    const settings: ChatRuntimeSettings = {
      ...DEFAULT_CHAT_RUNTIME_SETTINGS,
      ...(input.settings ?? {}),
    };
    const text = input.text.trim();
    if (!text) {
      return {
        kind: 'rejected',
        code: 'HARNESS_INCOMPATIBLE',
        message: 'A non-empty chat message is required.',
        settings,
      };
    }

    const nativeSkillRefs = input.nativeSkillRefs ?? [];
    const command = parseChatRuntimeCommand(text);
    if (nativeSkillRefs.length && command) {
      return {
        kind: 'rejected',
        code: 'HARNESS_INCOMPATIBLE',
        message: 'A local Chat command cannot load selected native skills in the same turn; the user message was not sent.',
        settings,
      };
    }

    if (command) {
      const commandResult = applyChatRuntimeCommand(settings, command);
      return {
        kind: 'command',
        commandResult,
        settings: commandResult.settings,
      };
    }

    const commandCandidate = slashCommandCandidate(text);
    const officialCommand = commandCandidate?.command === 'goal' ? commandCandidate : null;
    if (officialCommand?.command === 'goal' && !officialCommand.arguments) {
      return {
        kind: 'rejected',
        code: 'HARNESS_INCOMPATIBLE',
        message:
          'Use /goal <objective>. The registered OpenCode goal command requires an objective.',
        settings,
      };
    }

    let runtimeResolution = resolveRuntimeModelControls(
      { effort: settings.effort, fastMode: settings.fastMode },
      input.selection.metadata,
    );
    // Codex Spark (and similar) only expose medium. Token Final Boss / leftover
    // /effort max must still send the selected model, not fail the Jarvis turn.
    if (
      !input.requireExactRuntimeControls &&
      !runtimeResolution.ok &&
      runtimeResolution.code === 'EFFORT_UNSUPPORTED'
    ) {
      runtimeResolution = resolveRuntimeModelControls(
        { effort: 'auto', fastMode: settings.fastMode },
        input.selection.metadata,
      );
    }
    if (!runtimeResolution.ok) {
      return {
        kind: 'rejected',
        code: 'MODEL_CONTROL_UNSUPPORTED',
        message: runtimeResolution.message,
        settings,
      };
    }

    const permissions = buildEffectivePermissionProfile(input.policy);
    const session = await this.sessions.sessionForChat(input.scope, input.chatId, input.chatTitle);
    if (input.expectedSessionId && session.sessionId !== input.expectedSessionId) {
      throw new Error('kernel_explicit_root_session_changed_before_dispatch');
    }
    if (!isPersistentTurnClient(session.client)) {
      return {
        kind: 'rejected',
        code: 'HARNESS_INCOMPATIBLE',
        message:
          'The active OpenCode client does not expose persistent async send; refusing per-turn CLI fallback.',
        settings,
      };
    }

    const controls = buildOpenCodeRequestControls({
      connectionId: input.selection.connectionId,
      providerId: input.selection.providerId,
      modelId: input.selection.modelId,
      runtime: runtimeResolution.controls,
      performance: settings.performance,
      rlmEnabled: settings.rlmEnabled,
    });

    let turnSystem = input.system;
    let turnTools = input.tools;
    if (nativeSkillRefs.length) {
      if (commandCandidate) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'An OpenCode slash command cannot load selected native skills in the same turn; the user message was not sent.',
          settings,
        };
      }
      if (input.tools?.skill === false) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The selected native skill tool is disabled for this turn; the user message was not sent.',
          settings,
        };
      }
      const inputReferenceError = nativeSkillReferenceError(nativeSkillRefs);
      if (inputReferenceError) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: `${inputReferenceError} The user message was not sent.`,
          settings,
        };
      }
      if (!session.client.listSkillsAsync) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The active OpenCode client cannot inspect its native skill catalog; the user message was not sent.',
          settings,
        };
      }
      let skillCatalog: readonly OpenCodeNativeSkillDescriptor[];
      try {
        skillCatalog = await session.client.listSkillsAsync();
      } catch {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The active OpenCode skill catalog could not be read; the user message was not sent.',
          settings,
        };
      }
      const referenceError = nativeSkillReferenceError(nativeSkillRefs, skillCatalog);
      if (referenceError) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: `${referenceError} The user message was not sent.`,
          settings,
        };
      }
      turnSystem = systemWithNativeSkillReminder(input.system, nativeSkillRefs);
      turnTools = Object.freeze({ ...input.tools, skill: true });
    }

    let liveCommand = officialCommand;
    if (!liveCommand && commandCandidate) {
      if (!session.client.listCommandsAsync) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The active OpenCode client cannot inspect registered slash commands.',
          settings,
        };
      }
      let commands: readonly OpenCodeCommandDescriptor[];
      try {
        commands = await session.client.listCommandsAsync();
      } catch {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The live OpenCode command catalog could not be read; command was not sent.',
          settings,
        };
      }
      if (commands.some((command) => command.name.toLocaleLowerCase('en-US') === commandCandidate.command)) {
        liveCommand = commandCandidate;
      } else {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: `OpenCode command /${commandCandidate.command} is not registered in the live command catalog.`,
          settings,
        };
      }
    }

    let commandOutcome: Extract<OpenCodeTurnResult, { kind: 'dispatched' }>['commandOutcome'];
    if (liveCommand) {
      if (!session.client.sendCommandAsync) {
        return {
          kind: 'rejected',
          code: 'HARNESS_INCOMPATIBLE',
          message: 'The active OpenCode client cannot execute registered session commands.',
          settings,
        };
      }
      commandOutcome = session.client.sendCommandAsync({
        sessionId: session.sessionId,
        controls,
        ...liveCommand,
        agent: permissions.openCodeAgent,
        signal: input.signal,
      }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    } else {
      await session.client.sendAsync({
        sessionId: session.sessionId,
        controls,
        text,
        ...(turnSystem?.trim() ? { system: turnSystem } : {}),
        agent: permissions.openCodeAgent,
        ...(turnTools ? { tools: turnTools } : {}),
      });
    }

    return {
      kind: 'dispatched',
      ...(commandOutcome ? { commandOutcome } : {}),
      sessionId: session.sessionId,
      runtimeGeneration: session.runtimeGeneration,
      controls,
      permissions,
      settings,
    };
  }
}

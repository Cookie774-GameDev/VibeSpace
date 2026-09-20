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
  listCommandsAsync?(): Promise<readonly { name: string }[]>;
}

export interface TurnPolicyInput {
  mode: InteractionMode;
  access: AccessLevel;
  approveAllForRun: boolean;
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

    const command = parseChatRuntimeCommand(text);
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
      let commands: readonly { name: string }[];
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
      if (commands.some((command) => command.name === commandCandidate.command)) {
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
        ...(input.system?.trim() ? { system: input.system } : {}),
        agent: permissions.openCodeAgent,
        ...(input.tools ? { tools: input.tools } : {}),
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

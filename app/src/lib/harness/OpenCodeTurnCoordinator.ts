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
    agent?: string;
    tools?: Readonly<Record<string, boolean>>;
  }): Promise<void>;
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
      sessionId: string;
      runtimeGeneration: string;
      controls: OpenCodeRequestControls;
      permissions: EffectivePermissionProfile;
      settings: ChatRuntimeSettings;
    };

function isPersistentTurnClient(client: OpenCodeSessionClient): client is PersistentOpenCodeTurnClient {
  return typeof (client as Partial<PersistentOpenCodeTurnClient>).sendAsync === 'function';
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

    const runtimeResolution = resolveRuntimeModelControls(
      { effort: settings.effort, fastMode: settings.fastMode },
      input.selection.metadata,
    );
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

    await session.client.sendAsync({
      sessionId: session.sessionId,
      controls,
      text,
      ...(input.system?.trim() ? { system: input.system } : {}),
      ...(input.agent?.trim() ? { agent: input.agent } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
    });

    return {
      kind: 'dispatched',
      sessionId: session.sessionId,
      runtimeGeneration: session.runtimeGeneration,
      controls,
      permissions,
      settings,
    };
  }
}

import type { ToolGatewayRelayPort } from '@/lib/harness/toolGatewayProduction';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { canParticipateInRelay, type RelaySettings } from '@/features/settings/relaySettings';
import { RELAY_GROUP_TOOL_NAMES, type RelayParticipantHandle } from './relayHostBridge';

type RelaySessionRequest = Parameters<ToolGatewayRelayPort['forSession']>[0];
type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type NativeContext = {
  generation: number;
  context: {
    accountId: string;
    workspaceId: string | null;
    projectId: string;
    chatId: string;
  } | null;
};

type NativeBinding = {
  bindingId: string;
  relayWorkspaceId: string;
  relayAgentId: string;
  relayAgentName: string;
  channelName: string;
};

type BoundSession = {
  bindingId: string;
  relayAgentId: string;
  generation: number;
  epoch: number;
  handle: RelayParticipantHandle;
};

export type RelayLocalParticipant = Readonly<{
  relayAgentId: string;
  chatId: string;
  sessionId: string;
  projectId: string;
}>;

const localParticipants = new Map<string, RelayLocalParticipant & { bindingId: string }>();

/** Verified local mappings for the room profile. No Relay credentials or prompts are stored. */
export function readRelayLocalParticipants(): readonly RelayLocalParticipant[] {
  return [...localParticipants.values()].map(({ bindingId: _bindingId, ...participant }) => participant);
}

function removeLocalParticipant(session: BoundSession): void {
  if (localParticipants.get(session.relayAgentId)?.bindingId === session.bindingId)
    localParticipants.delete(session.relayAgentId);
}

export interface RelayProductionClientOptions {
  invoke: NativeInvoke;
  readSettings(): RelaySettings;
  subscribeSettings(listener: () => void): () => void;
  installPort(port: ToolGatewayRelayPort): () => void;
}

const CHANNEL = 'vibespace';
const allowedNames = new Set<string>(RELAY_GROUP_TOOL_NAMES);

function activeContext(value: unknown): NativeContext | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as NativeContext;
  if (!Number.isSafeInteger(result.generation) || result.generation < 1 || !result.context)
    return null;
  const context = result.context;
  if (!context.accountId || !context.workspaceId || !context.projectId || !context.chatId)
    return null;
  return result;
}

function binding(value: unknown): NativeBinding | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as NativeBinding;
  return result.bindingId &&
    result.relayWorkspaceId &&
    result.relayAgentId &&
    result.relayAgentName &&
    result.channelName === CHANNEL
    ? result
    : null;
}

/**
 * Main-window adapter to the native-only SDK/MCP host. No workspace key or
 * participant token enters the renderer. The native host rechecks the scope,
 * generation and policy for each operation.
 */
export function createRelayProductionClient(options: RelayProductionClientOptions) {
  let started = false;
  let epoch = 0;
  let lastPolicyRevision = 0;
  let policyReady: Promise<boolean> = Promise.resolve(false);
  let uninstallPort: (() => void) | undefined;
  let unsubscribeSettings: (() => void) | undefined;
  const bound = new Map<string, BoundSession>();
  const pending = new Map<string, Promise<RelayParticipantHandle | null>>();
  const skipped = (reason: string): null => {
    appActivityLog.recordMetadata('agent-relay', 'enrollment_skipped', { reason });
    return null;
  };

  const unbind = (session: BoundSession) =>
    options
      .invoke('relay_participant_unbind', {
        bindingId: session.bindingId,
        generation: session.generation,
      })
      .catch(() => undefined);

  function publishPolicy(forced?: RelaySettings): void {
    epoch += 1;
    const old = [...bound.values()];
    bound.clear();
    pending.clear();
    old.forEach(removeLocalParticipant);
    const settings = forced ?? options.readSettings();
    const previous = policyReady;
    policyReady = previous
      .catch(() => false)
      .then(async () => {
        try {
          for (let attempt = 0; ; attempt += 1) {
            const nativePolicy = (await options.invoke('relay_policy_snapshot')) as {
              revision?: unknown;
            };
            const nativeRevision = nativePolicy?.revision;
            if (
              !Number.isSafeInteger(nativeRevision) ||
              (nativeRevision as number) < 0 ||
              (nativeRevision as number) >= Number.MAX_SAFE_INTEGER
            ) {
              throw new Error('Relay policy snapshot invalid');
            }
            const revision = Math.max(Date.now(), lastPolicyRevision + 1, (nativeRevision as number) + 1);
            lastPolicyRevision = revision;
            try {
              await options.invoke('relay_policy_set', {
                policy: {
                  revision,
                  scope: settings.scope === 'entire-app' ? 'entireApp' : settings.scope,
                  excludedProjectIds: settings.excludedParticipants,
                  excludedSessionIds: settings.excludedParticipants,
                },
              });
              break;
            } catch (error) {
              const stale = typeof error === 'string' ? error.includes('stale') :
                error instanceof Error && error.message.includes('stale');
              if (!stale || attempt >= 4) throw error;
              appActivityLog.recordMetadata('agent-relay', 'policy_retry', { attempt: attempt + 1 });
            }
          }
          await Promise.allSettled(old.map(unbind));
          if (settings.scope === 'off') {
            await options.invoke('relay_engine_stop').catch(() => undefined);
          }
          return true;
        } catch (error) {
          const reason =
            typeof error === 'string' && error.includes('stale')
              ? 'stale_revision'
              : error instanceof Error && error.message.includes('stale')
                ? 'stale_revision'
                : 'native_rejected';
          appActivityLog.recordMetadata('agent-relay', 'policy_failed', { reason });
          return false;
        }
      });
  }

  async function forSession(input: RelaySessionRequest): Promise<RelayParticipantHandle | null> {
    if (!started) return skipped('client_stopped');
    const requestEpoch = epoch;
    if (!(await policyReady) || requestEpoch !== epoch) return skipped('policy_unavailable');
    const settings = options.readSettings();
    if (!canParticipateInRelay(settings, input, input.projectId)) return skipped('scope_excluded');
    const messageChatId = input.chatId;
    if (!messageChatId || requestEpoch !== epoch) return skipped('message_chat_unavailable');
    const snapshot = activeContext(
      await options.invoke('relay_active_context_snapshot').catch(() => null),
    );
    if (!snapshot || requestEpoch !== epoch) return skipped('native_context_unavailable');
    const context = snapshot.context!;
    if (
      context.accountId !== input.accountId ||
      context.workspaceId !== input.workspaceId ||
      context.projectId !== input.projectId ||
      context.chatId !== messageChatId
    )
      return skipped('scope_mismatch');
    const key = JSON.stringify([
      input.sessionId,
      input.accountId,
      input.workspaceId,
      input.projectId,
      context.chatId,
      snapshot.generation,
    ]);
    const existing = bound.get(key);
    if (existing?.epoch === requestEpoch) return existing.handle;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const enrollment = (async (): Promise<RelayParticipantHandle | null> => {
      let native: NativeBinding | null = null;
      let stage = 'engine_start';
      try {
        await options.invoke('relay_engine_start');
        stage = 'participant_bind';
        native = binding(
          await options.invoke('relay_participant_bind', {
            scope: { ...context },
            sessionId: input.sessionId,
            generation: snapshot.generation,
            agentName: 'VibeSpace chat',
            role: 'agent',
          }),
        );
        if (!native) return skipped('invalid_native_binding');
        stage = 'tools_list';
        const discovered = (await options.invoke('relay_tools_list', {
          bindingId: native.bindingId,
          generation: snapshot.generation,
        })) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> };
        const latest = activeContext(
          await options.invoke('relay_active_context_snapshot').catch(() => null),
        );
        stage = 'context_recheck';
        if (
          !latest ||
          latest.generation !== snapshot.generation ||
          latest.context?.accountId !== context.accountId ||
          latest.context?.workspaceId !== context.workspaceId ||
          latest.context?.projectId !== context.projectId ||
          latest.context?.chatId !== context.chatId
        )
          return skipped('stale_native_context');
        const availableTools = (discovered.tools ?? [])
          .filter(
            (tool): tool is { name: string; description?: string; inputSchema: object } =>
              typeof tool.name === 'string' &&
              allowedNames.has(tool.name) &&
              !!tool.inputSchema &&
              typeof tool.inputSchema === 'object' &&
              !Array.isArray(tool.inputSchema),
          )
          .map((tool) => ({
            name: tool.name,
            description:
              typeof tool.description === 'string' ? tool.description.slice(0, 2000) : undefined,
            inputSchema: tool.inputSchema,
          }));
        const availableToolNames = [...new Set(availableTools.map((tool) => tool.name))];
        if (!availableToolNames.length || requestEpoch !== epoch) return skipped('no_allowed_upstream_tools');
        const bindingId = native.bindingId;
        const generation = snapshot.generation;
        const handle: RelayParticipantHandle = Object.freeze({
          role: 'agent',
          sessionId: input.sessionId,
          availableToolNames: Object.freeze(availableToolNames),
          availableTools: Object.freeze(availableTools),
          async call(operation: string, args: unknown): Promise<unknown> {
            if (
              requestEpoch !== epoch ||
              !started ||
              !canParticipateInRelay(options.readSettings(), input, input.projectId)
            ) {
              throw new Error('Relay participant revoked');
            }
            if (!availableToolNames.includes(operation)) throw new Error('Relay tool unavailable');
            const startedAt = performance.now();
            const result = await options.invoke('relay_participant_call', {
              bindingId,
              generation,
              operation,
              args,
            });
            appActivityLog.recordMetadata('agent-relay', 'tool_call', {
              operation,
              durationMs: Math.round(performance.now() - startedAt),
            });
            if (requestEpoch !== epoch || !started) throw new Error('Relay participant revoked');
            return result;
          },
        });
        bound.set(key, { bindingId, relayAgentId: native.relayAgentId,
          generation, epoch: requestEpoch, handle });
        localParticipants.set(native.relayAgentId, {
          bindingId, relayAgentId: native.relayAgentId,
          chatId: context.chatId, sessionId: input.sessionId, projectId: context.projectId,
        });
        native = null;
        return handle;
      } catch {
        return skipped(`native_${stage}_failed`);
      } finally {
        if (native) {
          await options
            .invoke('relay_participant_unbind', {
              bindingId: native.bindingId,
              generation: snapshot.generation,
            })
            .catch(() => undefined);
        }
      }
    })();
    pending.set(key, enrollment);
    try {
      return await enrollment;
    } finally {
      if (pending.get(key) === enrollment) pending.delete(key);
    }
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      uninstallPort = options.installPort({
        channel: CHANNEL,
        availableToolNames: RELAY_GROUP_TOOL_NAMES,
        forSession,
      });
      unsubscribeSettings = options.subscribeSettings(publishPolicy);
      publishPolicy();
    },
    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      uninstallPort?.();
      unsubscribeSettings?.();
      // A React host unmount (including hot reload) is not a user opt-out.
      // Revoke this client's handles without overriding the persisted policy.
      epoch += 1;
      const old = [...bound.values()];
      bound.clear();
      pending.clear();
      old.forEach(removeLocalParticipant);
      await policyReady;
      await Promise.allSettled(old.map(unbind));
    },
  };
}

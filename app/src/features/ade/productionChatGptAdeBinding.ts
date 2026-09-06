import * as React from 'react';

import { getStoredProjectRoot } from '@/features/files/projectFiles';
import { readChatRuntimePolicyState } from '@/features/chat/runtime/chatRuntimeSettingsStore';
import type { ChatRuntimeSettings } from '@/features/chat/runtime/chatRuntimeCommandController';
import { resolveRuntimeModelControls } from '@/features/chat/runtime/runtimeModelControls';
import type { LiveVariant } from '@/lib/ai/catalog/modelVariants';
import { getProviderConnectionDescriptor } from '@/lib/ai/adapters/catalog';
import { openCodePersistentAdapter } from '@/lib/ai/adapters/opencodePersistent';
import type { ProviderAdapter, ProviderConnection, ProviderRequest } from '@/lib/ai/adapters/types';
import { selectionOptionId, type ChatModelSelection } from '@/lib/ai/modelSelection';
import {
  readOpenCodeCatalogEvidence,
  requestOpenCodeModelCatalogRefresh,
  useAccessibleChatModels,
  type ModelPickerOption,
  type OpenCodeCatalogEvidence,
} from '@/lib/ai/useAccessibleChatModels';
import { resolveAccountIdentity, type AccountIdentity } from '@/lib/accountIdentity';
import {
  readToolGatewayObservedExecutionAuthority,
  type ToolGatewayObservedExecutionAuthority,
} from '@/lib/harness/toolGatewayAuthority';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type {
  ExecutionIdentity,
  ContextScopeRevision,
} from '@/features/context/gateway/contextGatewayContracts';
import type { ChatGptAdeDispatcher } from './ChatGptAdeAdapter';
import type { ChatGptAdeTaskDraft, ChatGptAdeTaskRun } from './ChatGptAdeTaskSurface';
import {
  createChatGptAdeRunSeed,
  createDurableProductionChatGptAdeRun,
  readLatestChatGptAdeRecovery,
  type ChatGptAdeRecoveryProjection,
} from './productionChatGptAde';

const SAFE_SHA = /^[0-9a-f]{64}$/u;
const READ_TOOLS = Object.freeze({
  'terminal.list': true,
  'terminal.read': true,
  'command.list': true,
  'context.list': true,
  'context.read': true,
  'skills.list': true,
  'plugins.list': true,
  'mcp.list': true,
  'app.getState': true,
  vibespace_context: false,
});

type UnavailableCode =
  | 'scope_unavailable'
  | 'route_unavailable'
  | 'catalog_unavailable'
  | 'runtime_authority_unavailable';

export type ChatGptAdeMissingScope = 'account' | 'workspace' | 'project' | 'worktree' | 'chat';

export type ProductionChatGptAdeAuthority =
  | Readonly<{
      kind: 'unavailable';
      code: 'scope_unavailable';
      message: string;
      missingScope: readonly ChatGptAdeMissingScope[];
    }>
  | Readonly<{
      kind: 'unavailable';
      code: Exclude<UnavailableCode, 'scope_unavailable'>;
      message: string;
    }>
  | Readonly<{
      kind: 'ready';
      accountSource: AccountIdentity['source'];
      scope: Readonly<ContextScopeRevision>;
      executionIdentity: Readonly<ExecutionIdentity>;
      performance: ChatRuntimeSettings['performance'];
      runtimeSettings: Readonly<ChatRuntimeSettings>;
      connection: Readonly<ProviderConnection>;
    }>;

interface ResolveAuthorityInput {
  account: Readonly<AccountIdentity> | null;
  workspaceId: string | null;
  projectId: string | null;
  worktreeId: string;
  activeChatId: string | null;
  selection: ChatModelSelection;
  connection: Readonly<ProviderConnection> | null;
  liveModel: Readonly<Pick<ModelPickerOption, 'id' | 'label' | 'variants'>> | null;
  catalogEvidence: Readonly<OpenCodeCatalogEvidence> | undefined;
  runtime: Readonly<ChatRuntimeSettings>;
}

function unavailable(
  code: Exclude<UnavailableCode, 'scope_unavailable'>,
  message: string,
): ProductionChatGptAdeAuthority {
  return Object.freeze({ kind: 'unavailable', code, message });
}

function safePart(value: string | null | undefined): value is string {
  const clean = value?.trim() ?? '';
  return Boolean(clean && clean.length <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(clean));
}

function forbiddenLocalRoute(value: string): boolean {
  return /(?:ollama|(?:^|[^0-9])11434(?:[^0-9]|$))/iu.test(value);
}

function liveVariants(values: readonly string[] | undefined): readonly LiveVariant[] {
  return Object.freeze(
    (values ?? []).flatMap((raw) => {
      const id = raw.trim();
      if (!safePart(id)) return [];
      const normalized = id.toLocaleLowerCase('en-US');
      const effort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find(
        (candidate) =>
          normalized === candidate ||
          normalized.startsWith(`${candidate}-`) ||
          normalized.endsWith(`-${candidate}`),
      ) as LiveVariant['reasoningEffort'];
      const fast =
        normalized === 'fast' || normalized.includes('-fast') || normalized.includes('fast-');
      return [
        {
          id,
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(fast ? { fast: true } : {}),
          ...(fast && effort
            ? { kind: 'combined' as const }
            : fast
              ? { kind: 'latency' as const }
              : effort
                ? { kind: 'reasoning' as const }
                : {}),
        },
      ];
    }),
  );
}

export function resolveProductionChatGptAdeAuthority(
  input: Readonly<ResolveAuthorityInput>,
): ProductionChatGptAdeAuthority {
  const missingScope: ChatGptAdeMissingScope[] = [];
  if (!input.account || !safePart(input.account.accountId)) missingScope.push('account');
  if (!safePart(input.workspaceId)) missingScope.push('workspace');
  if (!safePart(input.projectId)) missingScope.push('project');
  if (!safePart(input.worktreeId)) missingScope.push('worktree');
  if (!safePart(input.activeChatId)) missingScope.push('chat');
  if (missingScope.length > 0) {
    return Object.freeze({
      kind: 'unavailable',
      code: 'scope_unavailable',
      message: 'An exact account, workspace, project, worktree, and chat scope is required.',
      missingScope: Object.freeze(missingScope),
    });
  }
  const account = input.account!;
  const workspaceId = input.workspaceId!;
  const projectId = input.projectId!;
  const selection = input.selection;
  const connection = input.connection;
  if (
    selection.mode !== 'single' ||
    !connection ||
    connection.id !== 'opencode-cli' ||
    connection.adapterId !== 'opencode-persistent' ||
    connection.mode !== 'external-cli' ||
    selection.connectionId !== connection.id ||
    selection.connectionMode !== connection.mode ||
    selection.authSource !== connection.authSource ||
    !safePart(selection.modelId) ||
    forbiddenLocalRoute(`${selection.providerId}:${selection.modelId}:${connection.providerId}`)
  ) {
    return unavailable(
      'route_unavailable',
      'The exact authenticated OpenCode route is unavailable.',
    );
  }
  const evidence = input.catalogEvidence;
  if (
    !evidence ||
    evidence.connectionId !== connection.id ||
    evidence.authority !== 'current-session-authenticated' ||
    evidence.auth !== 'authenticated' ||
    evidence.available !== true ||
    evidence.sessionChecked !== true ||
    evidence.lastVerifiedAt < evidence.refreshRequestedAt ||
    evidence.routeCount < 1 ||
    !SAFE_SHA.test(evidence.catalogSha256)
  ) {
    return unavailable(
      'catalog_unavailable',
      'Authenticated live OpenCode catalog authority is unavailable.',
    );
  }
  if (
    !input.liveModel ||
    input.liveModel.id !== selection.modelId ||
    input.runtime.effort === 'auto' ||
    input.runtime.fastMode !== 'on'
  ) {
    return unavailable(
      'runtime_authority_unavailable',
      'Choose an explicit supported effort and turn Fast on for the selected live model.',
    );
  }
  const variants = liveVariants(input.liveModel.variants);
  const resolution = resolveRuntimeModelControls(
    { effort: input.runtime.effort, fastMode: input.runtime.fastMode },
    { connectionId: connection.id, modelId: selection.modelId, variants },
  );
  if (!resolution.ok || !resolution.controls.variant) {
    return unavailable(
      'runtime_authority_unavailable',
      'The selected live provider route does not expose that exact effort and Fast combination.',
    );
  }
  const separator = selection.modelId.indexOf('/');
  if (separator <= 0 || separator === selection.modelId.length - 1) {
    return unavailable('route_unavailable', 'The live OpenCode model is not provider-qualified.');
  }
  const upstreamProviderId = selection.modelId.slice(0, separator);
  const upstreamModelId = selection.modelId.slice(separator + 1);
  if (upstreamProviderId !== selection.providerId) {
    return unavailable(
      'route_unavailable',
      'The selected provider does not match the live model route.',
    );
  }
  const executionIdentity: Readonly<ExecutionIdentity> = Object.freeze({
    transportConnectionId: connection.id,
    transportAdapterId: connection.adapterId,
    upstreamProviderId,
    upstreamModelId,
    providerQualifiedModelId: selection.modelId,
    authBillingRoute: connection.authSource,
    effort: input.runtime.effort,
    fastVariant: resolution.controls.variant,
    catalogRevision: `sha256:${evidence.catalogSha256}`,
    observedProviderIdentity: selection.modelId,
  });
  return Object.freeze({
    kind: 'ready',
    accountSource: account.source,
    scope: Object.freeze({
      accountId: account.accountId,
      workspaceId,
      projectId,
      worktreeId: input.worktreeId,
      revision: `ade-scope-${evidence.accountGeneration}-${evidence.catalogGeneration}`,
    }),
    executionIdentity,
    performance: input.runtime.performance,
    runtimeSettings: Object.freeze({ ...input.runtime }),
    connection,
  });
}

function sameObservedRoute(
  expected: Readonly<ExecutionIdentity>,
  observed: Readonly<ToolGatewayObservedExecutionAuthority>,
  performance: ChatRuntimeSettings['performance'],
): boolean {
  const actual = observed.executionIdentity;
  return (
    observed.performance === performance &&
    actual.transportConnectionId === expected.transportConnectionId &&
    actual.transportAdapterId === expected.transportAdapterId &&
    actual.upstreamProviderId === expected.upstreamProviderId &&
    actual.upstreamModelId === expected.upstreamModelId &&
    actual.providerQualifiedModelId === expected.providerQualifiedModelId &&
    actual.authBillingRoute === expected.authBillingRoute &&
    actual.effort === expected.effort &&
    actual.fastVariant === expected.fastVariant &&
    actual.observedProviderIdentity === expected.observedProviderIdentity &&
    /^sha256:[0-9a-f]{64}$/u.test(actual.catalogRevision)
  );
}

export function createOpenCodeChatGptAdeDispatcher(dependencies: {
  adapter: Readonly<ProviderAdapter>;
  connection: Readonly<ProviderConnection>;
  runtimeSettings: Readonly<ChatRuntimeSettings>;
  readObservedAuthority(sessionId: string): Readonly<ToolGatewayObservedExecutionAuthority> | null;
}): Readonly<ChatGptAdeDispatcher> {
  const active = new Set<string>();
  const dispatcher: ChatGptAdeDispatcher = {
    async dispatch(input) {
      if (active.has(input.runId) || !dependencies.adapter.send)
        throw new Error('ade_dispatch_unavailable');
      active.add(input.runId);
      let output = '';
      let sessionId = '';
      let modelId = '';
      try {
        const request: ProviderRequest = {
          requestId: input.runId,
          connection: dependencies.connection,
          chatId: input.runId,
          accountId: input.scope.accountId,
          workspaceId: input.scope.workspaceId,
          projectId: input.scope.projectId,
          worktreeId: input.scope.worktreeId,
          prompt: input.instruction,
          modelId: input.executionIdentity.providerQualifiedModelId,
          reasoningEffort: input.executionIdentity.effort,
          systemPrompt: input.contextPromptBlock,
          workingDirectory: input.scope.worktreeId,
          runtimeSettings: dependencies.runtimeSettings,
          interactionMode: 'ask',
          accessLevel: 'read-only',
          approveAllForRun: false,
          tools: {
            ...READ_TOOLS,
            vibespace_context: dependencies.runtimeSettings.rlmEnabled,
          },
          signal: input.signal,
        };
        for await (const event of dependencies.adapter.send(request)) {
          if (input.signal.aborted) throw new DOMException('ADE dispatch cancelled.', 'AbortError');
          if (event.type === 'session') sessionId = event.sessionId;
          if (event.type === 'model') modelId = event.modelId;
          if (event.type === 'text') {
            output = event.mode === 'replace' ? event.delta : output + event.delta;
            input.onOutput(event.delta);
          }
          if (event.type === 'question') throw new Error('ade_interactive_request_rejected');
          if (event.type === 'error') throw new Error('ade_provider_failed');
        }
        const observed = sessionId ? dependencies.readObservedAuthority(sessionId) : null;
        if (
          !observed ||
          modelId !== input.executionIdentity.providerQualifiedModelId ||
          !sameObservedRoute(
            input.executionIdentity,
            observed,
            dependencies.runtimeSettings.performance,
          )
        ) {
          throw new Error('ADE observed authority mismatch.');
        }
        return Object.freeze({
          output,
          observedExecutionIdentity: Object.freeze({ ...input.executionIdentity }),
          observedScope: Object.freeze({ ...input.scope }),
        });
      } finally {
        active.delete(input.runId);
      }
    },
    cancel(runId) {
      if (!safePart(runId) || !dependencies.adapter.cancel) return;
      void dependencies.adapter.cancel(runId).catch(() => undefined);
    },
  };
  return Object.freeze(dispatcher);
}

export interface ProductionChatGptAdePageBinding {
  authority: ProductionChatGptAdeAuthority;
  recovery: Readonly<ChatGptAdeRecoveryProjection> | null;
  refresh(): void;
}

export function useProductionChatGptAdePageBinding(): ProductionChatGptAdePageBinding {
  const auth = useAuthStore();
  const account = resolveAccountIdentity(auth);
  const activeChatId = useUIStore((state) => state.activeChatId);
  const { flatOptions } = useAccessibleChatModels();
  const selectedId = selectionOptionId(auth.chatModelSelection);
  const option = flatOptions.find((candidate) => candidate.id === selectedId) ?? null;
  const connection = (() => {
    if (auth.chatModelSelection.mode !== 'single' || !auth.chatModelSelection.connectionId)
      return null;
    try {
      return getProviderConnectionDescriptor(auth.chatModelSelection.connectionId);
    } catch {
      return null;
    }
  })();
  const runtime = activeChatId
    ? readChatRuntimePolicyState(activeChatId).settings
    : readChatRuntimePolicyState('').settings;
  const authority = resolveProductionChatGptAdeAuthority({
    account,
    workspaceId: auth.workspaceId,
    projectId: auth.projectId,
    worktreeId: getStoredProjectRoot(auth.projectId),
    activeChatId,
    selection: auth.chatModelSelection,
    connection,
    liveModel: option?.catalogSource === 'opencode-live' ? option : null,
    catalogEvidence: readOpenCodeCatalogEvidence(),
    runtime,
  });
  const [recovery, setRecovery] = React.useState<Readonly<ChatGptAdeRecoveryProjection> | null>(
    null,
  );
  React.useEffect(() => {
    if (!account || !safePart(auth.projectId)) {
      setRecovery(null);
      return;
    }
    let cancelled = false;
    void readLatestChatGptAdeRecovery({
      accountId: account.accountId,
      projectId: auth.projectId,
    })
      .then((value) => {
        if (!cancelled) setRecovery(value);
      })
      .catch(() => {
        if (!cancelled) setRecovery(null);
      });
    return () => {
      cancelled = true;
    };
  }, [account?.accountId, auth.projectId]);
  return React.useMemo(
    () =>
      Object.freeze({
        authority,
        recovery,
        refresh: requestOpenCodeModelCatalogRefresh,
      }),
    [authority, recovery],
  );
}

export function createProductionChatGptAdeTaskRun(
  authority: Extract<ProductionChatGptAdeAuthority, { kind: 'ready' }>,
  draft: Readonly<ChatGptAdeTaskDraft>,
): Readonly<ChatGptAdeTaskRun> {
  if (draft.access !== 'read') throw new Error('ade_write_approval_unavailable');
  const runId = `ade-${crypto.randomUUID()}`;
  const dispatcher = createOpenCodeChatGptAdeDispatcher({
    adapter: openCodePersistentAdapter,
    connection: authority.connection,
    runtimeSettings: authority.runtimeSettings,
    readObservedAuthority: readToolGatewayObservedExecutionAuthority,
  });
  const durable = createDurableProductionChatGptAdeRun({
    seed: createChatGptAdeRunSeed({
      runId,
      scope: authority.scope,
      executionIdentity: authority.executionIdentity,
    }),
    dispatcher,
  });
  return Object.freeze({
    execute: () =>
      durable.run({
        runId,
        requestId: runId,
        selectedHarness: 'chatgpt',
        instruction: draft.instruction,
        taskKind: draft.taskKind,
        access: 'read',
        workingSet: 'unknown',
        scope: authority.scope,
        executionIdentity: authority.executionIdentity,
        performance: authority.performance,
        optionalEnrichmentEnabled: true,
        userIntent: draft.userIntent,
        broadChange: draft.broadChange,
      }),
    cancel: durable.cancel,
    subscribe: durable.subscribe,
  });
}

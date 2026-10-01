import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import type { JarvisRepositories } from '@/lib/db/jarvisRepositories';
import type { JarvisEntitlementSnapshotProvider } from '@/lib/admin';
import { createExistingPluginCredentialAdapter } from '@/features/plugins/credentials';
import type {
  JarvisExistingCredentialAuthorization,
  JarvisExistingCredentialAuthorizationAuthority,
  PluginCredentialAccountGrantRepository,
} from '@/features/plugins/credentialAuthorization';
import {
  createAccountScopedPluginRuntime,
  type CanonicalPluginArtifactCapability,
  type PluginManagementCapability,
} from '@/features/plugins/runtime';
import type { PluginStore } from '@/features/plugins/store';
import {
  canonicalizeJarvisApprovalJson,
  hashCanonicalJarvisApprovalJson,
  type JarvisRecoveryApprovalVerifier,
} from '@/lib/jarvis/contracts';
import type { JarvisCapabilitySnapshotProvider } from '@/lib/jarvis/capabilitySnapshot';
import type {
  JarvisActionCatalog,
  JarvisRegisteredActionDefinition,
} from '@/lib/jarvis/actions/catalog';
import {
  createJarvisApprovalBindingSelectors,
  createJarvisApprovalEngine,
  type JarvisApprovalActionBinder,
  type JarvisIssuedActionExecution,
  type JarvisIssuedApprovalLifecycle,
  type JarvisRegisteredActionDispatchOutcome,
} from '@/lib/jarvis/approvalEngine';
import { createJarvisSecretHandleAuthority } from '@/lib/jarvis/secretHandlePort';

export type JarvisSecurityRuntime = Readonly<{
  readonly recoveryVerifier: JarvisRecoveryApprovalVerifier;
  bindKernelActions: JarvisApprovalActionBinder;
  pluginManagement: PluginManagementCapability;
  runReadOnlyPlugin(input: JarvisReadOnlyPluginRequest): Promise<ActionResult>;
  invalidateAccount(accountId: string): void;
  invalidateAll(): void;
}>;

export type JarvisReadOnlyPluginRequest = Readonly<{
  pluginId: string;
  operation: string;
  params: Readonly<Record<string, unknown>>;
  context: Readonly<{
    requestId: string;
    sessionId: string;
    messageId: string;
  }>;
}>;

export type CreateJarvisSecurityRuntimeInput = {
  repositories: JarvisRepositories;
  catalog: JarvisActionCatalog;
  capabilitySnapshots: JarvisCapabilitySnapshotProvider;
  entitlementSnapshots: JarvisEntitlementSnapshotProvider;
  credentialGrants: PluginCredentialAccountGrantRepository;
  credentialAuthorization: JarvisExistingCredentialAuthorizationAuthority;
  pluginConnections: Pick<PluginStore, 'upsertConnection' | 'removeConnection'>;
  /** @internal Synchronous deep-composition handoff; never retained on the public runtime. */
  bindKernelPluginArtifacts?(capability: CanonicalPluginArtifactCapability): void;
  activeAccountId(): string | undefined;
  executeRegisteredAction(input: {
    registration: Readonly<JarvisRegisteredActionDefinition>;
    params: Readonly<Record<string, unknown>>;
    context: RegisteredActionExecutionContext;
    execution: JarvisIssuedActionExecution;
  }): Promise<JarvisRegisteredActionDispatchOutcome>;
  bootId: string;
  randomUUID: () => string;
  now: () => number;
};

function authorityRevoked(): never {
  const error = new Error('JARVIS account authority was revoked.');
  error.name = 'JarvisApprovalAuthorityRevokedError';
  throw error;
}

/**
 * Trusted deep-module composition for approval, credential, and plugin
 * authority. No constructor or executable boot capability escapes this file.
 */
export function createJarvisSecurityRuntime(
  input: CreateJarvisSecurityRuntimeInput,
): JarvisSecurityRuntime {
  const boundRevocations = new Map<string, Set<AbortController>>();
  const credentialAdapter = createExistingPluginCredentialAdapter();
  const secretAuthority = createJarvisSecretHandleAuthority({
    credentials: credentialAdapter,
    credentialAuthorization: input.credentialAuthorization,
    bootId: input.bootId,
    randomUUID: input.randomUUID,
  });
  const pluginRuntime = createAccountScopedPluginRuntime({
    activeAccountId: input.activeAccountId,
    grants: input.credentialGrants,
    credentialAuthorization: input.credentialAuthorization,
    credentialAdapter,
    connections: input.pluginConnections,
    randomUUID: input.randomUUID,
    now: input.now,
  });
  input.bindKernelPluginArtifacts?.(pluginRuntime.canonicalArtifacts);
  const bindingSelectors = createJarvisApprovalBindingSelectors({
    catalog: input.catalog,
    capabilitySnapshots: input.capabilitySnapshots,
    entitlementSnapshots: input.entitlementSnapshots,
  });

  const approvalEngine = createJarvisApprovalEngine({
    runs: input.repositories.run,
    approvals: input.repositories.approval,
    catalog: input.catalog,
    bindingSelectors,
    secretHandles: secretAuthority.port,
    async executeRegisteredAction(dispatchInput) {
      if (input.catalog.resolve(dispatchInput.registration.id) !== dispatchInput.registration) {
        throw new Error('Registered action authority changed before dispatch.');
      }
      const executor = dispatchInput.registration.executor;
      if (executor.kind !== 'plugin_tool') {
        return await input.executeRegisteredAction(dispatchInput);
      }

      const credentialValues: Record<string, string> = {};
      const credentialAuthorizations: JarvisExistingCredentialAuthorization[] = [];
      for (const binding of dispatchInput.registration.credentialBindings) {
        const reference = (dispatchInput.execution.approval.secretHandleRefs ?? []).find(
          (candidate) => candidate.field === binding.field,
        );
        if (!reference) throw new Error('Registered credential handle is unavailable.');
        const resolved = await secretAuthority.resolveOnceWithAuthorization({
          accountId: dispatchInput.context.accountId,
          actionId: dispatchInput.registration.id,
          actionVersion: dispatchInput.registration.version,
          field: binding.field,
          handleId: reference.handleId,
        });
        credentialValues[binding.locator.fieldId] = resolved.value;
        credentialAuthorizations.push(resolved.authorization);
      }

      // The issued handle remains private. Beginning the registered plugin
      // operation in this synchronous callback makes revocation-before-start a
      // zero-call outcome and propagates the exact issued abort signal.
      const started = dispatchInput.execution.beginExternalEffect((signal) => ({
        completion: pluginRuntime.registeredTools.startPrepared({
          accountId: dispatchInput.context.accountId,
          registration: executor,
          params: dispatchInput.params,
          context: Object.freeze({ ...dispatchInput.context, signal }),
          credentialValues,
          credentialAuthorizations: Object.freeze(credentialAuthorizations),
        }),
      }));
      if (started.kind !== 'committed') authorityRevoked();
      return {
        kind: 'executor_returned',
        result: await started.value.completion,
      };
    },
    newApprovalId: () => `jappr_${input.randomUUID()}`,
    now: input.now,
    canonicalizeJson: canonicalizeJarvisApprovalJson,
    hashCanonicalJson: hashCanonicalJarvisApprovalJson,
  });

  async function bindCredentialReferences(
    accountId: string,
    actionId: string,
    actionVersion: number,
  ): Promise<readonly { field: string; handleId: string }[]> {
    const registration = input.catalog.resolve(actionId);
    if (!registration || registration.version !== actionVersion) {
      throw new Error('Registered credential binding is unavailable.');
    }
    const references: Array<{ field: string; handleId: string }> = [];
    try {
      for (const binding of registration.credentialBindings) {
        const issued = await secretAuthority.bindExistingCredential({
          accountId,
          actionId,
          actionVersion,
          field: binding.field,
          locator: binding.locator,
        });
        references.push(Object.freeze({ field: issued.field, handleId: issued.handleId }));
      }
      return Object.freeze(references);
    } catch (error) {
      // There is deliberately no public single-handle revoker. Revoking the
      // account scope is the only safe cleanup if a multi-field bind is partial.
      secretAuthority.invalidateAccount(accountId);
      throw error;
    }
  }

  function credentialBindingLifecycle(
    lifecycle: JarvisIssuedApprovalLifecycle,
  ): JarvisIssuedApprovalLifecycle {
    const revocation = new AbortController();
    const accountRevocations = boundRevocations.get(lifecycle.accountId) ?? new Set();
    accountRevocations.add(revocation);
    boundRevocations.set(lifecycle.accountId, accountRevocations);
    const revoke = () => {
      if (!revocation.signal.aborted) revocation.abort();
      accountRevocations.delete(revocation);
      if (
        accountRevocations.size === 0 &&
        boundRevocations.get(lifecycle.accountId) === accountRevocations
      ) {
        boundRevocations.delete(lifecycle.accountId);
      }
    };
    if (lifecycle.revocationSignal.aborted) revoke();
    else {
      lifecycle.revocationSignal.addEventListener('abort', revoke, { once: true });
    }
    const ensureLive = () => {
      if (revocation.signal.aborted) authorityRevoked();
    };
    const wrapped = Object.create(lifecycle) as JarvisIssuedApprovalLifecycle;
    Object.defineProperties(wrapped, {
      revocationSignal: {
        enumerable: true,
        value: revocation.signal,
      },
      putPreparedApproval: {
        enumerable: true,
        value: async (
          prepared: Parameters<JarvisIssuedApprovalLifecycle['putPreparedApproval']>[0],
        ) => {
          ensureLive();
          const secretHandleRefs = await bindCredentialReferences(
            lifecycle.accountId,
            prepared.actionId,
            prepared.actionVersion,
          );
          ensureLive();
          return await lifecycle.putPreparedApproval({ ...prepared, secretHandleRefs });
        },
      },
      decidePreparedApproval: {
        enumerable: true,
        value: async (
          decision: Parameters<JarvisIssuedApprovalLifecycle['decidePreparedApproval']>[0],
        ) => {
          ensureLive();
          return await lifecycle.decidePreparedApproval(decision);
        },
      },
      claimApprovedExecution: {
        enumerable: true,
        value: async (
          claim: Parameters<JarvisIssuedApprovalLifecycle['claimApprovedExecution']>[0],
        ) => {
          ensureLive();
          return await lifecycle.claimApprovedExecution(claim);
        },
      },
      claimAutoApprovedExecution: {
        enumerable: true,
        value: async (
          claim: Parameters<JarvisIssuedApprovalLifecycle['claimAutoApprovedExecution']>[0],
        ) => {
          ensureLive();
          const secretHandleRefs = await bindCredentialReferences(
            lifecycle.accountId,
            claim.approval.actionId,
            claim.approval.actionVersion,
          );
          ensureLive();
          return await lifecycle.claimAutoApprovedExecution({
            ...claim,
            approval: { ...claim.approval, secretHandleRefs },
          });
        },
      },
      dispose: {
        enumerable: true,
        value: () => {
          revoke();
          lifecycle.dispose();
        },
      },
    });
    return Object.freeze(wrapped);
  }

  let invalidatedAll = false;
  const runtime: JarvisSecurityRuntime = Object.freeze({
    recoveryVerifier: approvalEngine.recoveryVerifier,
    bindKernelActions(lifecycle) {
      if (invalidatedAll || input.activeAccountId() !== lifecycle.accountId) authorityRevoked();
      const wrapped = credentialBindingLifecycle(lifecycle);
      try {
        return approvalEngine.bindIssuedLifecycle(wrapped);
      } catch (error) {
        wrapped.dispose();
        throw error;
      }
    },
    pluginManagement: pluginRuntime.management,
    async runReadOnlyPlugin({ pluginId, operation, params, context }) {
      const accountId = input.activeAccountId();
      if (invalidatedAll || !accountId) authorityRevoked();
      const matches = input.catalog
        .listExposed()
        .filter(
          (registration) =>
            registration.executor.kind === 'plugin_tool' &&
            registration.executor.pluginId === pluginId &&
            registration.executor.toolName === operation,
        );
      if (matches.length !== 1) throw new Error('plugin_operation_unavailable');
      const registration = matches[0];
      if (registration.risk !== 'read-only' || registration.approval !== 'never') {
        throw new Error('plugin_operation_unavailable');
      }
      const executor = registration.executor;
      if (executor.kind !== 'plugin_tool') throw new Error('plugin_operation_unavailable');
      const validated = registration.validateParameters(params);
      return await pluginRuntime.registeredTools.execute({
        accountId,
        registration: executor,
        params: validated,
        context: Object.freeze({
          source: 'ai',
          accountId,
          chatId: context.sessionId,
          messageId: context.messageId,
          callId: context.requestId,
          runId: context.sessionId,
          approvalId: context.requestId,
          requestId: context.requestId,
          attemptNumber: 1,
        }),
      });
    },
    invalidateAccount(accountId) {
      if (!accountId.trim()) return;
      for (const revocation of boundRevocations.get(accountId) ?? []) revocation.abort();
      boundRevocations.delete(accountId);
      secretAuthority.invalidateAccount(accountId);
      pluginRuntime.canonicalArtifacts.invalidateAccount(accountId);
    },
    invalidateAll() {
      if (invalidatedAll) return;
      invalidatedAll = true;
      for (const revocations of boundRevocations.values()) {
        for (const revocation of revocations) revocation.abort();
      }
      boundRevocations.clear();
      secretAuthority.invalidateAll();
      pluginRuntime.canonicalArtifacts.invalidateAll();
    },
  });
  return runtime;
}

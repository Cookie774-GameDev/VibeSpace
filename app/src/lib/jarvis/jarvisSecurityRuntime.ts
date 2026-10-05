import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import type { JarvisRepositories } from '@/lib/db/jarvisRepositories';
import type { JarvisEntitlementSnapshotProvider } from '@/lib/admin';
import { createExistingPluginCredentialAdapter } from '@/features/plugins/credentials';
import {
  createGitHubDeviceAuthorizationAuthority,
  VIBESPACE_GITHUB_OAUTH_CLIENT_ID,
} from '@/features/plugins/githubDeviceAuthorization';
import {
  withPluginCredentialLocatorLocks,
  type JarvisExistingCredentialAuthorization,
  type JarvisExistingCredentialAuthorizationAuthority,
  type PluginCredentialAccountGrantRepository,
  type PluginCredentialAccountGrantV1,
} from '@/features/plugins/credentialAuthorization';
import {
  createAccountScopedPluginRuntime,
  type CanonicalPluginArtifactCapability,
  type PluginAuthorizationAuthority,
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
  /** Registered public OAuth-app identifier. This is not a credential or secret. */
  githubOAuthClientId?: string;
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
  let invalidatedAll = false;
  const credentialAdapter = createExistingPluginCredentialAdapter();
  const secretAuthority = createJarvisSecretHandleAuthority({
    credentials: credentialAdapter,
    credentialAuthorization: input.credentialAuthorization,
    bootId: input.bootId,
    randomUUID: input.randomUUID,
  });
  let pluginRuntime!: ReturnType<typeof createAccountScopedPluginRuntime>;
  type DeviceLifetime = {
    accountId: string;
    pluginId: string;
    active: boolean;
    grant?: PluginCredentialAccountGrantV1;
  };
  const deviceLifetimes = new Map<string, DeviceLifetime>();
  const deviceKey = (accountId: string, pluginId: string) => JSON.stringify([accountId, pluginId]);
  const deviceIsCurrent = (lifetime: DeviceLifetime) =>
    lifetime.active &&
    !invalidatedAll &&
    input.activeAccountId() === lifetime.accountId &&
    deviceLifetimes.get(deviceKey(lifetime.accountId, lifetime.pluginId)) === lifetime;
  const retireDevice = (lifetime: DeviceLifetime) => {
    const key = deviceKey(lifetime.accountId, lifetime.pluginId);
    if (deviceLifetimes.get(key) === lifetime) deviceLifetimes.delete(key);
  };
  const cleanRevokedDeviceGrant = async (lifetime: DeviceLifetime) => {
    const locator = { pluginId: 'github', fieldId: 'token' };
    await withPluginCredentialLocatorLocks([locator], async (locks) => {
      const grant = await input.credentialGrants.getLocked({ locks, locator });
      const owned = lifetime.grant;
      // A newer/manual grant may already own this locator. Never remove it.
      if (
        !grant ||
        !owned ||
        grant.accountId !== owned.accountId ||
        grant.grantId !== owned.grantId ||
        grant.revision !== owned.revision
      )
        return;
      await input.credentialGrants.removeExact({
        locks,
        locator,
        expected: {
          accountId: owned.accountId,
          pluginId: owned.pluginId,
          fieldId: owned.fieldId,
          grantId: owned.grantId,
          revision: owned.revision,
        },
      });
      await credentialAdapter.deleteExistingCredential(locator);
    });
  };
  const revokeDevice = (lifetime: DeviceLifetime) => {
    lifetime.active = false;
    retireDevice(lifetime);
    // Do not wait on an uninterruptible keychain write while canceling. Its
    // guarded adapter rolls back under the same lock; exact grants are cleaned
    // independently without ever deleting a replacement attempt's credential.
    void cleanRevokedDeviceGrant(lifetime).catch(() => {
      console.warn('[plugins] Canceled device credential cleanup failed.');
    });
    return providerAuthorization.cancel({
      accountId: lifetime.accountId,
      pluginId: lifetime.pluginId,
    });
  };
  const providerAuthorization = createGitHubDeviceAuthorizationAuthority({
    clientId:
      input.githubOAuthClientId ??
      import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID ??
      VIBESPACE_GITHUB_OAUTH_CLIENT_ID,
    async onConnected({ accountId, credential }) {
      const lifetime = deviceLifetimes.get(deviceKey(accountId, 'github'));
      if (!lifetime || !deviceIsCurrent(lifetime)) return;
      // Reuse the existing credential/grant implementation with this one
      // callback's lifetime, rather than borrowing the current account string.
      const callbackRuntime = createAccountScopedPluginRuntime({
        activeAccountId: () => (deviceIsCurrent(lifetime) ? accountId : undefined),
        grants: {
          ...input.credentialGrants,
          replaceExact(request) {
            lifetime.grant = Object.freeze({ ...request.grant });
            return input.credentialGrants.replaceExact(request);
          },
        },
        credentialAuthorization: input.credentialAuthorization,
        credentialAdapter: {
          ...credentialAdapter,
          async writeExistingCredential(locator, value) {
            if (!deviceIsCurrent(lifetime)) authorityRevoked();
            await credentialAdapter.writeExistingCredential(locator, value);
            if (!deviceIsCurrent(lifetime)) {
              // saveCredential still holds the exact locator lock here, so
              // this is our write, never a newer attempt's replacement.
              await credentialAdapter.deleteExistingCredential(locator);
              authorityRevoked();
            }
          },
        },
        connections: {
          upsertConnection(connection) {
            if (deviceIsCurrent(lifetime)) input.pluginConnections.upsertConnection(connection);
          },
          removeConnection(owner, pluginId) {
            if (deviceIsCurrent(lifetime))
              input.pluginConnections.removeConnection(owner, pluginId);
          },
        },
        randomUUID: input.randomUUID,
        now: input.now,
      });
      let completed = false;
      try {
        await callbackRuntime.management.saveCredential({
          accountId,
          pluginId: 'github',
          fieldId: 'token',
          value: credential,
        });
        if (!deviceIsCurrent(lifetime)) return;
        await callbackRuntime.management.testConnection({ accountId, pluginId: 'github' });
        completed = true;
      } finally {
        callbackRuntime.canonicalArtifacts.invalidateAll();
        if (!deviceIsCurrent(lifetime)) await cleanRevokedDeviceGrant(lifetime);
        // A current storage failure still belongs to this lifetime: retain it
        // for the provider's bounded onFailed receipt instead of hiding it.
        if (completed || !deviceIsCurrent(lifetime)) retireDevice(lifetime);
      }
    },
    async onFailed({ accountId, error }) {
      const lifetime = deviceLifetimes.get(deviceKey(accountId, 'github'));
      if (!lifetime || !deviceIsCurrent(lifetime)) return;
      input.pluginConnections.upsertConnection({
        accountId,
        pluginId: 'github',
        state: 'error',
        enabled: false,
        enabledProjectIds: [],
        error,
        configuredFields: [],
        updatedAt: input.now(),
      });
      retireDevice(lifetime);
    },
  });
  const deviceAuthorization: PluginAuthorizationAuthority = {
    async begin(request) {
      const key = deviceKey(request.accountId, request.pluginId);
      const previous = deviceLifetimes.get(key);
      const cancellation = previous ? revokeDevice(previous) : undefined;
      const lifetime: DeviceLifetime = {
        accountId: request.accountId,
        pluginId: request.pluginId,
        active: true,
      };
      deviceLifetimes.set(key, lifetime);
      if (cancellation) await cancellation;
      if (!deviceIsCurrent(lifetime))
        return { ok: false, error: 'Plugin authorization was cancelled.' };
      const result = await providerAuthorization.begin(request);
      if (!result.ok) retireDevice(lifetime);
      return result;
    },
    async cancel(request) {
      const lifetime = deviceLifetimes.get(deviceKey(request.accountId, request.pluginId));
      if (lifetime) await revokeDevice(lifetime);
      else await providerAuthorization.cancel(request);
    },
  };
  pluginRuntime = createAccountScopedPluginRuntime({
    activeAccountId: input.activeAccountId,
    grants: input.credentialGrants,
    credentialAuthorization: input.credentialAuthorization,
    credentialAdapter,
    connections: input.pluginConnections,
    authorization: deviceAuthorization,
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
      for (const lifetime of deviceLifetimes.values()) {
        if (lifetime.accountId === accountId) void revokeDevice(lifetime);
      }
      for (const revocation of boundRevocations.get(accountId) ?? []) revocation.abort();
      boundRevocations.delete(accountId);
      secretAuthority.invalidateAccount(accountId);
      pluginRuntime.canonicalArtifacts.invalidateAccount(accountId);
    },
    invalidateAll() {
      if (invalidatedAll) return;
      invalidatedAll = true;
      for (const lifetime of deviceLifetimes.values()) void revokeDevice(lifetime);
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

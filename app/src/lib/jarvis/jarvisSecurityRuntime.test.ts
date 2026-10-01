import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const nativeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nativeFetch', () => ({ nativeFetch: nativeFetchMock }));

import * as runtimeModule from './jarvisSecurityRuntime';
import { createJarvisSecurityRuntime } from './jarvisSecurityRuntime';
import {
  createJarvisActionCatalog,
  type JarvisRegisteredActionDefinition,
} from './actions/catalog';
import {
  jarvisIssuedActionExecutionBrand,
  jarvisIssuedApprovalLifecycleBrand,
  type JarvisIssuedActionExecution,
  type JarvisIssuedApprovalLifecycle,
} from './approvalEngine';
import {
  createJarvisExistingCredentialAuthorization,
  createPluginCredentialAccountGrantRepository,
  type StrictPluginCredentialGrantStorage,
} from '@/features/plugins/credentialAuthorization';
import type { JarvisApprovalV1, JarvisRun } from './contracts';
import type { CanonicalPluginArtifactCapability } from '@/features/plugins/runtime';

function memoryStorage(): StrictPluginCredentialGrantStorage {
  let raw: string | null = null;
  return {
    readRaw: () => raw,
    compareAndSetRaw: ({ expectedRaw, nextRaw }) => {
      if (raw !== expectedRaw) throw new Error('CAS conflict');
      raw = nextRaw;
    },
  };
}

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

function registration(): JarvisRegisteredActionDefinition {
  return {
    id: 'github.fixed-list',
    version: 1,
    title: 'List GitHub tools',
    description: 'Uses one fixed GitHub tool registration.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: true },
    requiredCapabilities: ['plugin.github.fixed-list'],
    requiredEntitlements: [],
    risk: 'credential-sensitive',
    approval: 'always',
    expectedEffect: 'Read the fixed GitHub capability.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'identity' },
    credentialBindings: [{ field: 'token', locator: { pluginId: 'github', fieldId: 'token' } }],
    validateParameters: () => ({}),
    deriveTarget: ({ accountId }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'github',
      toolName: 'identity',
      resourceId: 'github',
    }),
  };
}

function run(): JarvisRun {
  return {
    id: 'jrun_1',
    accountId: 'account-a',
    source: 'typed_chat',
    status: 'running',
    agentId: 'jarvis',
    identityVersion: 1,
    profileRevisionId: 'jprofile_1',
    model: {
      providerId: 'test',
      modelId: 'test-model',
      connectionMode: 'local',
      capabilities: {},
      capturedAt: 1,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('trusted JARVIS security runtime composition', () => {
  it('exports one factory and returns only the closed public authority surface', () => {
    expect(Object.keys(runtimeModule)).toEqual(['createJarvisSecurityRuntime']);
  });

  it('executes only the one canonical read-only plugin registration selected by the gateway', async () => {
    let activeAccountId: string | undefined = 'account-a';
    const grants = createPluginCredentialAccountGrantRepository({ storage: memoryStorage() });
    const authorization = createJarvisExistingCredentialAuthorization({
      grants,
      getActiveAccountId: () => activeAccountId,
    });
    const catalog = createJarvisActionCatalog([
      {
        ...registration(),
        id: 'mock-connector.ping',
        risk: 'read-only',
        approval: 'never',
        executor: { kind: 'plugin_tool', pluginId: 'mock-connector', toolName: 'ping' },
        credentialBindings: [],
        validateParameters: (params) => {
          if (Reflect.ownKeys(params).length > 0) throw new Error('ping parameters are invalid');
          return {};
        },
        deriveTarget: ({ accountId }) => ({
          kind: 'plugin_tool',
          accountId,
          pluginId: 'mock-connector',
          toolName: 'ping',
          resourceId: 'mock-connector',
        }),
      },
      {
        ...registration(),
        id: 'mock-connector.list-tools-write-policy',
        risk: 'read-only',
        approval: 'always',
        executor: {
          kind: 'plugin_tool',
          pluginId: 'mock-connector',
          toolName: 'list_tools',
        },
        credentialBindings: [],
        deriveTarget: ({ accountId }) => ({
          kind: 'plugin_tool',
          accountId,
          pluginId: 'mock-connector',
          toolName: 'list_tools',
          resourceId: 'mock-connector',
        }),
      },
    ]);
    const runtime = createJarvisSecurityRuntime({
      repositories: {
        run: { getById: vi.fn() },
        approval: { getById: vi.fn(), listByRun: vi.fn(async () => []) },
      } as never,
      catalog,
      capabilitySnapshots: { getForAccount: vi.fn() },
      entitlementSnapshots: { getForAccount: vi.fn() },
      credentialGrants: grants,
      credentialAuthorization: authorization,
      pluginConnections: { upsertConnection: vi.fn(), removeConnection: vi.fn() },
      activeAccountId: () => activeAccountId,
      executeRegisteredAction: vi.fn(),
      bootId: 'boot-read-port',
      randomUUID: () => 'fixed',
      now: () => 10_000,
    });
    const context = {
      requestId: 'request-1',
      sessionId: 'session-1',
      messageId: 'message-1',
    };

    await expect(
      runtime.runReadOnlyPlugin({
        pluginId: 'mock-connector',
        operation: 'ping',
        params: {},
        context,
      }),
    ).resolves.toEqual({
      ok: true,
      summary: 'Fixed plugin tool completed.',
      data: { ok: true, message: 'pong' },
    });
    await expect(
      runtime.runReadOnlyPlugin({
        pluginId: 'mock-connector',
        operation: 'list_tools',
        params: {},
        context,
      }),
    ).rejects.toThrow('plugin_operation_unavailable');
    await expect(
      runtime.runReadOnlyPlugin({
        pluginId: 'mock-connector',
        operation: 'ping',
        params: { pluginId: 'github' },
        context,
      }),
    ).rejects.toThrow('ping parameters are invalid');

    activeAccountId = undefined;
    await expect(
      runtime.runReadOnlyPlugin({
        pluginId: 'mock-connector',
        operation: 'ping',
        params: {},
        context,
      }),
    ).rejects.toThrow('authority was revoked');
    runtime.invalidateAll();
  });

  it('shares account authority and binds catalog credentials before lifecycle persistence', async () => {
    let activeAccountId: string | undefined = 'account-a';
    const grants = createPluginCredentialAccountGrantRepository({ storage: memoryStorage() });
    const authorization = createJarvisExistingCredentialAuthorization({
      grants,
      getActiveAccountId: () => activeAccountId,
    });
    const catalog = createJarvisActionCatalog([registration()]);
    const parent = run();
    const ids = ['grant-1', 'handle-1', 'approval-1'];
    const lifecycleRevocation = new AbortController();
    const putPreparedApproval = vi.fn(async (prepared: any) => ({
      kind: 'committed' as const,
      value: {
        id: prepared.approvalId,
        schemaVersion: 1,
        runId: parent.id,
        requestId: 'request-1',
        attemptNumber: 1,
        actionId: prepared.actionId,
        actionVersion: prepared.actionVersion,
        params: prepared.params,
        secretHandleRefs: prepared.secretHandleRefs,
        paramsHash: prepared.paramsHash,
        targetSnapshot: prepared.targetSnapshot,
        risk: prepared.risk,
        status: 'pending',
        capabilityId: prepared.capabilityId,
        capabilitySnapshotHash: prepared.capabilitySnapshotHash,
        expectedEffect: prepared.expectedEffect,
        expiresAt: prepared.expiresAt,
        createdAt: prepared.createdAt,
      } satisfies JarvisApprovalV1,
    }));
    const lifecycle: JarvisIssuedApprovalLifecycle = {
      accountId: 'account-a',
      runId: parent.id,
      requestId: 'request-1',
      attemptNumber: 1,
      revocationSignal: lifecycleRevocation.signal,
      [jarvisIssuedApprovalLifecycleBrand]: true,
      putPreparedApproval,
      decidePreparedApproval: vi.fn(),
      claimApprovedExecution: vi.fn(),
      claimAutoApprovedExecution: vi.fn(),
      dispose: vi.fn(() => lifecycleRevocation.abort()),
    };
    Object.freeze(lifecycle);
    const getRun = vi.fn(async () => structuredClone(parent));
    const runtime = createJarvisSecurityRuntime({
      repositories: {
        run: { getById: getRun },
        approval: { getById: vi.fn(), listByRun: vi.fn(async () => []) },
      } as never,
      catalog,
      capabilitySnapshots: {
        getForAccount: vi.fn(async () => ({
          capturedAt: 10_000,
          tools: [],
          plugins: [
            {
              id: 'plugin.github.fixed-list',
              state: 'available' as const,
              operations: ['execute'],
            },
          ],
          mcps: [],
          terminals: [],
          agents: [],
          entitlements: {
            source: 'server' as const,
            capabilities: [],
            verifiedAt: 9_000,
            expiresAt: 20_000,
          },
        })),
      },
      entitlementSnapshots: {
        getForAccount: vi.fn(async () => ({
          source: 'server' as const,
          capabilities: [],
          verifiedAt: 9_000,
          expiresAt: 20_000,
        })),
      },
      credentialGrants: grants,
      credentialAuthorization: authorization,
      pluginConnections: { upsertConnection: vi.fn(), removeConnection: vi.fn() },
      activeAccountId: () => activeAccountId,
      executeRegisteredAction: vi.fn(async () => ({
        kind: 'executor_returned' as const,
        result: { ok: true as const },
      })),
      bootId: 'boot-1',
      randomUUID: () => ids.shift() ?? 'fallback',
      now: () => 10_000,
    });

    expect(Object.keys(runtime).sort()).toEqual([
      'bindKernelActions',
      'invalidateAccount',
      'invalidateAll',
      'pluginManagement',
      'recoveryVerifier',
      'runReadOnlyPlugin',
    ]);
    expect(runtime).not.toHaveProperty('execute');

    await runtime.pluginManagement.saveCredential({
      accountId: 'account-a',
      pluginId: 'github',
      fieldId: 'token',
      value: 'synthetic-test-value',
    });
    const actions = runtime.bindKernelActions(lifecycle);
    await actions.create({
      parentRun: parent,
      attempt: { kind: 'initial', requestId: 'request-1', runId: parent.id, attemptNumber: 1 },
      actionId: 'github.fixed-list',
      actionVersion: 1,
      params: {},
      expiresAt: 15_000,
    });

    expect(putPreparedApproval).toHaveBeenCalledOnce();
    expect(putPreparedApproval.mock.calls[0]![0].secretHandleRefs).toEqual([
      { field: 'token', handleId: 'jsecret_approval-1' },
    ]);
    expect(JSON.stringify(putPreparedApproval.mock.calls[0]![0])).not.toContain(
      'synthetic-test-value',
    );

    runtime.invalidateAccount('account-a');
    await expect(
      actions.create({
        parentRun: parent,
        attempt: { kind: 'initial', requestId: 'request-1', runId: parent.id, attemptNumber: 1 },
        actionId: 'github.fixed-list',
        actionVersion: 1,
        params: {},
        expiresAt: 15_000,
      }),
    ).rejects.toThrow('authority was revoked');
    expect(putPreparedApproval).toHaveBeenCalledOnce();

    const readsAfterFirstCreate = getRun.mock.calls.length;
    const freshLifecycleRevocation = new AbortController();
    const freshLifecycle = Object.freeze({
      ...lifecycle,
      revocationSignal: freshLifecycleRevocation.signal,
      dispose: vi.fn(() => freshLifecycleRevocation.abort()),
    } satisfies JarvisIssuedApprovalLifecycle);
    const freshActions = runtime.bindKernelActions(freshLifecycle);
    lifecycle.dispose();
    runtime.invalidateAccount('account-a');
    await expect(
      freshActions.create({
        parentRun: parent,
        attempt: { kind: 'initial', requestId: 'request-1', runId: parent.id, attemptNumber: 1 },
        actionId: 'github.fixed-list',
        actionVersion: 1,
        params: {},
        expiresAt: 15_000,
      }),
    ).rejects.toThrow('authority was revoked');
    expect(getRun).toHaveBeenCalledTimes(readsAfterFirstCreate);

    activeAccountId = undefined;
    await expect(
      runtime.pluginManagement.testConnection({ accountId: 'account-a', pluginId: 'github' }),
    ).rejects.toThrow('account_mismatch');
    runtime.invalidateAll();
  });

  it('resolves approval handles after claim and starts the prepared provider inside the effect gate', async () => {
    const sequence: string[] = [];
    const issuedSignal = new AbortController().signal;
    nativeFetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      sequence.push('provider');
      expect(init.signal).toBe(issuedSignal);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-test-value');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            login: 'octocat',
            public_repos: 8,
            total_private_repos: 3,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    });

    const grants = createPluginCredentialAccountGrantRepository({ storage: memoryStorage() });
    const authorization = createJarvisExistingCredentialAuthorization({
      grants,
      getActiveAccountId: () => 'account-a',
    });
    const parent = run();
    const catalog = createJarvisActionCatalog([
      { ...registration(), risk: 'read-only', approval: 'never' },
    ]);
    const ids = ['grant-1', 'handle-1', 'approval-1'];
    const lifecycleRevocation = new AbortController();
    let claimedApproval: JarvisApprovalV1 | undefined;
    let rebindCredentialOnClaim = false;
    let runtime!: ReturnType<typeof createJarvisSecurityRuntime>;
    let pluginArtifacts: CanonicalPluginArtifactCapability | undefined;
    const lifecycle: JarvisIssuedApprovalLifecycle = {
      accountId: 'account-a',
      runId: parent.id,
      requestId: 'request-1',
      attemptNumber: 1,
      revocationSignal: lifecycleRevocation.signal,
      [jarvisIssuedApprovalLifecycleBrand]: true,
      putPreparedApproval: vi.fn(),
      decidePreparedApproval: vi.fn(),
      claimApprovedExecution: vi.fn(),
      claimAutoApprovedExecution: vi.fn(async ({ approval }) => {
        sequence.push('claim');
        if (rebindCredentialOnClaim) {
          await runtime.pluginManagement.saveCredential({
            accountId: 'account-a',
            pluginId: 'github',
            fieldId: 'token',
            value: 'synthetic-rebound-value',
          });
        }
        claimedApproval = {
          id: approval.approvalId,
          schemaVersion: 1,
          runId: parent.id,
          requestId: 'request-1',
          attemptNumber: 1,
          actionId: approval.actionId,
          actionVersion: approval.actionVersion,
          params: approval.params,
          secretHandleRefs: approval.secretHandleRefs,
          paramsHash: approval.paramsHash,
          targetSnapshot: approval.targetSnapshot,
          risk: approval.risk,
          status: 'consumed',
          capabilityId: approval.capabilityId,
          capabilitySnapshotHash: approval.capabilitySnapshotHash,
          expectedEffect: approval.expectedEffect,
          expiresAt: approval.expiresAt,
          createdAt: approval.createdAt,
        };
        const execution: JarvisIssuedActionExecution = {
          approval: claimedApproval,
          producerKind: 'plugin',
          ownerId: `approval:${approval.approvalId}`,
          startEvent: {} as never,
          initialLiveProof: {} as never,
          [jarvisIssuedActionExecutionBrand]: true,
          beginExternalEffect: vi.fn((begin) => {
            sequence.push('gate');
            const started = begin(issuedSignal);
            return { kind: 'committed' as const, value: started };
          }),
          transferTerminalOwnership: vi.fn(),
          recordResult: vi.fn(async () => ({ kind: 'committed' as const, value: {} as never })),
          recordCancellationVerified: vi.fn(),
          requestCancellation: vi.fn(),
          dispose: vi.fn(() => sequence.push('dispose')),
        };
        return { kind: 'committed' as const, value: execution };
      }),
      dispose: vi.fn(() => lifecycleRevocation.abort()),
    };
    runtime = createJarvisSecurityRuntime({
      repositories: {
        run: { getById: vi.fn(async () => structuredClone(parent)) },
        approval: { getById: vi.fn(), listByRun: vi.fn(async () => []) },
      } as never,
      catalog,
      capabilitySnapshots: {
        getForAccount: vi.fn(async () => ({
          capturedAt: 10_000,
          tools: [],
          plugins: [
            {
              id: 'plugin.github.fixed-list',
              state: 'available' as const,
              operations: ['execute'],
            },
          ],
          mcps: [],
          terminals: [],
          agents: [],
          entitlements: {
            source: 'server' as const,
            capabilities: [],
            verifiedAt: 9_000,
            expiresAt: 20_000,
          },
        })),
      },
      entitlementSnapshots: {
        getForAccount: vi.fn(async () => ({
          source: 'server' as const,
          capabilities: [],
          verifiedAt: 9_000,
          expiresAt: 20_000,
        })),
      },
      credentialGrants: grants,
      credentialAuthorization: authorization,
      pluginConnections: { upsertConnection: vi.fn(), removeConnection: vi.fn() },
      bindKernelPluginArtifacts(capability) {
        pluginArtifacts = capability;
      },
      activeAccountId: () => 'account-a',
      executeRegisteredAction: vi.fn(),
      bootId: 'boot-1',
      randomUUID: () => ids.shift() ?? 'fallback',
      now: () => 10_000,
    });

    await runtime.pluginManagement.saveCredential({
      accountId: 'account-a',
      pluginId: 'github',
      fieldId: 'token',
      value: 'synthetic-test-value',
    });
    const result = await runtime
      .bindKernelActions(Object.freeze(lifecycle))
      .executeAutoApprovedSafe({
        parentRun: parent,
        attempt: { kind: 'initial', requestId: 'request-1', runId: parent.id, attemptNumber: 1 },
        actionId: 'github.fixed-list',
        actionVersion: 1,
        params: {},
        expiresAt: 15_000,
        context: { source: 'ai' },
      });

    expect(result).toEqual({
      kind: 'settled',
      result: {
        ok: true,
        summary: 'GitHub account octocat verified.',
        data: {
          login: 'octocat',
          profileUrl: 'https://github.com/octocat',
          publicRepositories: 8,
          privateRepositories: 3,
        },
      },
    });
    const pluginRegistration = catalog.resolve('github.fixed-list')?.executor;
    if (
      result.kind !== 'settled' ||
      !result.result.ok ||
      pluginRegistration?.kind !== 'plugin_tool'
    ) {
      throw new Error('expected successful canonical plugin result');
    }
    const artifactEvidence = Object.freeze({
      producerId: 'plugin_result' as const,
      accountId: 'account-a',
      runId: parent.id,
      requestId: 'request-1',
      attemptNumber: 1,
      resultRef: 'jresult_security-runtime-plugin',
      state: 'succeeded' as const,
      verifiedAt: 10_000,
      pluginId: 'github',
      invocationId: `approval:${claimedApproval?.id}`,
    });
    if (!pluginArtifacts) throw new Error('expected private plugin artifact binding');
    await expect(
      pluginArtifacts.consumeCanonicalResult({
        evidence: artifactEvidence,
        registration: pluginRegistration,
        result: result.result,
      }),
    ).resolves.toMatchObject([
      {
        artifact: { kind: 'link', title: 'GitHub profile octocat' },
        backing: { kind: 'uri', uri: 'https://github.com/octocat' },
      },
    ]);
    await expect(pluginArtifacts.authority.verify(artifactEvidence)).resolves.toBe(
      artifactEvidence,
    );
    expect(claimedApproval?.secretHandleRefs).toHaveLength(1);
    expect(nativeFetchMock).toHaveBeenCalledOnce();
    expect(sequence).toEqual(['claim', 'gate', 'provider', 'dispose']);

    rebindCredentialOnClaim = true;
    sequence.length = 0;
    await expect(
      runtime.bindKernelActions(lifecycle).executeAutoApprovedSafe({
        parentRun: parent,
        attempt: { kind: 'initial', requestId: 'request-1', runId: parent.id, attemptNumber: 1 },
        actionId: 'github.fixed-list',
        actionVersion: 1,
        params: {},
        expiresAt: 15_000,
        context: { source: 'ai' },
      }),
    ).resolves.toEqual({
      kind: 'settled',
      result: { ok: false, error: 'registered_action_failed' },
    });
    expect(nativeFetchMock).toHaveBeenCalledOnce();
    expect(sequence).toEqual(['claim', 'dispose']);
  });

  it('keeps executable constructors and private credential authority out of public barrels', () => {
    const appRoot = join(process.cwd(), 'src');
    const forbiddenConstructorImports = productionFiles(appRoot)
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ path }) => !path.endsWith(join('lib', 'jarvis', 'jarvisSecurityRuntime.ts')))
      .filter(({ source }) => {
        const imports =
          source.match(
            /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]+['"]/g,
          ) ?? [];
        return imports.some((statement) =>
          /createJarvisSecretHandleAuthority|createJarvisApprovalEngine/.test(statement),
        );
      })
      .map(({ path }) => relative(appRoot, path));
    expect(forbiddenConstructorImports).toEqual([]);

    for (const barrel of [
      join(appRoot, 'lib', 'jarvis', 'contracts', 'index.ts'),
      join(appRoot, 'features', 'plugins', 'index.ts'),
    ]) {
      expect(readFileSync(barrel, 'utf8')).not.toMatch(
        /createJarvisSecretHandleAuthority|createJarvisApprovalEngine|RegisteredPluginToolExecutor|JarvisSecretHandlePort/,
      );
    }
  }, 15_000);
});

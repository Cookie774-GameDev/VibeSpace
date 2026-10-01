import type { JarvisIssuedActionExecution } from './approvalEngine';

export type NativeCapabilityKind = 'file' | 'terminal' | 'git' | 'browser' | 'mcp';

export type NativeCapabilityRisk =
  | 'read-only'
  | 'safe-write'
  | 'external-side-effect'
  | 'destructive'
  | 'credential-sensitive';

export type NativeCapabilityApproval = 'never' | 'first-time' | 'always' | 'depends-on-input';

export interface NativeCapabilityRequest {
  capabilityId: string;
  capabilityVersion: number;
  kind: NativeCapabilityKind;
  operation: string;
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  workspaceRoot: string;
  parameterHash: string;
}

export interface NativeCapabilityAdapterResult {
  state: 'completed' | 'degraded';
  resultRef: `jresult_${string}`;
}

export interface NativeCapabilityAdapter {
  id: string;
  version: number;
  kind: NativeCapabilityKind;
  operations: readonly string[];
  risk: NativeCapabilityRisk;
  approval: NativeCapabilityApproval;
  producerKinds: readonly JarvisIssuedActionExecution['producerKind'][];
  execute(input: {
    request: Readonly<NativeCapabilityRequest>;
    signal: AbortSignal;
  }): Promise<NativeCapabilityAdapterResult>;
}

export interface NativeCapabilityInspection {
  capabilityId: string;
  capabilityVersion: number;
  kind: NativeCapabilityKind;
  operation: string;
  risk: NativeCapabilityRisk;
  approval: NativeCapabilityApproval;
}

export interface NativeCapabilityOutcome {
  capabilityId: string;
  capabilityVersion: number;
  kind: NativeCapabilityKind;
  operation: string;
  state: 'completed' | 'degraded';
  resultRef: `jresult_${string}`;
  evidenceRef: `jlive_${string}`;
}

export interface NativeCapabilityBroker {
  register(adapter: NativeCapabilityAdapter): void;
  inspect(request: NativeCapabilityRequest): NativeCapabilityInspection;
  execute(
    request: NativeCapabilityRequest,
    execution: JarvisIssuedActionExecution,
  ): Promise<NativeCapabilityOutcome>;
}

export interface NativeCapabilityBrokerAuthority {
  verifyIssuedRequest(
    request: Readonly<NativeCapabilityRequest>,
    execution: JarvisIssuedActionExecution,
  ): boolean;
}

const KINDS = new Set<NativeCapabilityKind>(['file', 'terminal', 'git', 'browser', 'mcp']);
const RISKS = new Set<NativeCapabilityRisk>([
  'read-only',
  'safe-write',
  'external-side-effect',
  'destructive',
  'credential-sensitive',
]);
const APPROVALS = new Set<NativeCapabilityApproval>([
  'never',
  'first-time',
  'always',
  'depends-on-input',
]);

function assertRequest(request: NativeCapabilityRequest): void {
  if (
    !request.capabilityId ||
    !Number.isSafeInteger(request.capabilityVersion) ||
    request.capabilityVersion < 1 ||
    !KINDS.has(request.kind) ||
    !request.operation ||
    !request.accountId ||
    !request.runId ||
    !request.requestId ||
    !Number.isSafeInteger(request.attemptNumber) ||
    request.attemptNumber < 1 ||
    !request.workspaceRoot ||
    !/^sha256:[a-f0-9]{6,}$/i.test(request.parameterHash)
  ) {
    throw new Error('Invalid native capability request scope.');
  }
}

function matchesIssuedScope(
  request: NativeCapabilityRequest,
  execution: JarvisIssuedActionExecution,
): boolean {
  const { approval, initialLiveProof } = execution;
  return (
    initialLiveProof.accountId === request.accountId &&
    initialLiveProof.runId === request.runId &&
    initialLiveProof.requestId === request.requestId &&
    initialLiveProof.attemptNumber === request.attemptNumber &&
    approval.runId === request.runId &&
    approval.requestId === request.requestId &&
    approval.attemptNumber === request.attemptNumber &&
    approval.capabilityId === request.capabilityId &&
    approval.actionId === request.operation &&
    approval.actionVersion === request.capabilityVersion &&
    approval.paramsHash === request.parameterHash &&
    approval.status === 'consumed'
  );
}

export function createNativeCapabilityBroker(
  authority: NativeCapabilityBrokerAuthority,
): NativeCapabilityBroker {
  const adapters = new Map<string, Readonly<NativeCapabilityAdapter>>();
  const claimedExecutions = new WeakSet<object>();

  const resolve = (request: NativeCapabilityRequest): Readonly<NativeCapabilityAdapter> => {
    assertRequest(request);
    const adapter = adapters.get(request.capabilityId);
    if (!adapter) throw new Error(`Unknown native capability ${request.capabilityId}.`);
    if (adapter.version !== request.capabilityVersion) {
      throw new Error('Native capability version mismatch.');
    }
    if (adapter.kind !== request.kind) throw new Error('Native capability kind mismatch.');
    if (!adapter.operations.includes(request.operation)) {
      throw new Error(`Unsupported native capability operation ${request.operation}.`);
    }
    return adapter;
  };

  return {
    register(adapter) {
      if (adapters.has(adapter.id)) {
        throw new Error(`Native capability ${adapter.id} is already registered.`);
      }
      if (
        !adapter.id ||
        !Number.isSafeInteger(adapter.version) ||
        adapter.version < 1 ||
        !KINDS.has(adapter.kind) ||
        !RISKS.has(adapter.risk) ||
        !APPROVALS.has(adapter.approval) ||
        typeof adapter.execute !== 'function' ||
        adapter.operations.length === 0 ||
        new Set(adapter.operations).size !== adapter.operations.length ||
        adapter.producerKinds.length === 0
      ) {
        throw new Error('Invalid native capability adapter.');
      }
      adapters.set(
        adapter.id,
        Object.freeze({
          ...adapter,
          operations: Object.freeze([...adapter.operations]),
          producerKinds: Object.freeze([...adapter.producerKinds]),
        }),
      );
    },
    inspect(request) {
      const adapter = resolve(request);
      return {
        capabilityId: adapter.id,
        capabilityVersion: adapter.version,
        kind: adapter.kind,
        operation: request.operation,
        risk: adapter.risk,
        approval: adapter.approval,
      };
    },
    async execute(request, execution) {
      const adapter = resolve(request);
      if (
        !authority.verifyIssuedRequest(Object.freeze({ ...request }), execution) ||
        !matchesIssuedScope(request, execution) ||
        !adapter.producerKinds.includes(execution.producerKind)
      ) {
        throw new Error('A matching issued execution authority is required.');
      }
      if (claimedExecutions.has(execution as object)) {
        throw new Error('Issued execution authority has already been claimed.');
      }
      claimedExecutions.add(execution as object);

      let effectSignal: AbortSignal | undefined;
      const started = execution.beginExternalEffect((signal) => {
        effectSignal = signal;
        const completion: Promise<NativeCapabilityAdapterResult> = adapter
          .execute({ request: Object.freeze({ ...request }), signal })
          .catch((error: unknown): NativeCapabilityAdapterResult => {
            if (
              signal.aborted ||
              (error instanceof DOMException && error.name === 'AbortError') ||
              (error instanceof Error && error.name === 'AbortError')
            ) {
              throw new Error('Native capability execution cancelled before settlement.');
            }
            return {
              state: 'degraded',
              resultRef: `jresult_native_capability_adapter_error`,
            };
          });
        return { completion };
      });
      if (started.kind !== 'committed') {
        throw new Error('Issued execution authority was revoked before the effect began.');
      }

      const adapterResult = await started.value.completion;
      if (effectSignal?.aborted) {
        throw new Error('Native capability execution cancelled before settlement.');
      }
      const completedAt = Date.now();
      if (effectSignal?.aborted) {
        throw new Error('Native capability execution cancelled before result recording.');
      }
      const recorded = await execution.recordResult({
        state: adapterResult.state,
        resultRef: adapterResult.resultRef,
        completedAt,
      });
      if (recorded.kind !== 'committed') {
        throw new Error('Issued execution authority was revoked before result verification.');
      }

      return {
        capabilityId: request.capabilityId,
        capabilityVersion: request.capabilityVersion,
        kind: request.kind,
        operation: request.operation,
        state: adapterResult.state,
        resultRef: adapterResult.resultRef,
        evidenceRef: recorded.value.proofRef,
      };
    },
  };
}

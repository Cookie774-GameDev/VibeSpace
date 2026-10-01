import type {
  VibeSpaceGatewayConnection,
  VibeSpaceMcpGateway,
  VibeSpaceMcpInvocationClassification,
  VibeSpaceMcpInvocationReceipt,
} from '@/lib/mcp/vibeSpaceGateway';
import type { UnifiedMcpCapabilitySnapshot } from '@/lib/jarvis/unifiedMcpRegistry';
import type { BrowserChatApprovalBroker } from './approvalBroker';
import type { BrowserChatCapabilityLease } from './permissionRegistry';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const MAX_TOOLS = 64;
const MAX_ARGUMENT_CHARS = 32 * 1024;
const MAX_RESULT_CHARS = 64 * 1024;
const MAX_OBJECT_NODES = 512;
const MAX_TEXT = 4_096;

export type BrowserChatDownstreamMcpErrorCode =
  | 'scope_invalid'
  | 'capability_mismatch'
  | 'request_invalid'
  | 'tool_unavailable'
  | 'operation_cancelled'
  | 'gateway_denied'
  | 'result_invalid';

export class BrowserChatDownstreamMcpError extends Error {
  constructor(readonly code: BrowserChatDownstreamMcpErrorCode) {
    super(`Browser Chat downstream MCP operation rejected: ${code}.`);
    this.name = 'BrowserChatDownstreamMcpError';
  }
}

type AdapterOptions = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  approvalBroker: BrowserChatApprovalBroker;
  gateway: VibeSpaceMcpGateway;
}>;

type LiveTool = Readonly<{
  connectionId: string;
  serverId: string;
  toolName: string;
  title?: string;
  description: string;
  classification: VibeSpaceMcpInvocationClassification;
}>;

function stableText(value: unknown, maximum = MAX_TEXT): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function validateScope(options: AdapterOptions): void {
  if (
    !SAFE_ID.test(options.accountId) ||
    !SAFE_ID.test(options.workspaceId) ||
    !SAFE_ID.test(options.projectId)
  ) {
    throw new BrowserChatDownstreamMcpError('scope_invalid');
  }
}

function begin(
  options: AdapterOptions,
  lease: BrowserChatCapabilityLease,
  capabilityId: 'mcp.list' | 'mcp.read' | 'mcp.invoke',
  now?: number,
) {
  if (lease.capabilityId !== capabilityId) {
    throw new BrowserChatDownstreamMcpError('capability_mismatch');
  }
  if (lease.accountId !== options.accountId || lease.workspaceId !== options.workspaceId) {
    throw new BrowserChatDownstreamMcpError('scope_invalid');
  }
  return options.approvalBroker.begin(lease, now === undefined ? {} : { now });
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateArguments(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) throw new BrowserChatDownstreamMcpError('request_invalid');
  let nodes = 0;
  const inspect = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_OBJECT_NODES || depth > 8) {
      throw new BrowserChatDownstreamMcpError('request_invalid');
    }
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 256) throw new BrowserChatDownstreamMcpError('request_invalid');
      for (const child of candidate) inspect(child, depth + 1);
      return;
    }
    if (!plainRecord(candidate)) throw new BrowserChatDownstreamMcpError('request_invalid');
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > 256 || keys.some((key) => typeof key !== 'string')) {
      throw new BrowserChatDownstreamMcpError('request_invalid');
    }
    for (const key of keys as string[]) {
      if (!stableText(key, 240)) throw new BrowserChatDownstreamMcpError('request_invalid');
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new BrowserChatDownstreamMcpError('request_invalid');
      }
      inspect(descriptor.value, depth + 1);
    }
  };
  inspect(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BrowserChatDownstreamMcpError('request_invalid');
  }
  if (serialized.length > MAX_ARGUMENT_CHARS) {
    throw new BrowserChatDownstreamMcpError('request_invalid');
  }
}

function exactSnapshots(options: AdapterOptions): {
  capabilities: UnifiedMcpCapabilitySnapshot;
  connections: readonly Readonly<VibeSpaceGatewayConnection>[];
} {
  let capabilities: UnifiedMcpCapabilitySnapshot;
  let connections: readonly Readonly<VibeSpaceGatewayConnection>[];
  try {
    capabilities = options.gateway.getCapabilitySnapshot();
    connections = options.gateway.getSnapshot();
  } catch {
    throw new BrowserChatDownstreamMcpError('gateway_denied');
  }
  if (
    capabilities.accountId !== options.accountId ||
    capabilities.projectId !== options.projectId
  ) {
    throw new BrowserChatDownstreamMcpError('scope_invalid');
  }
  return { capabilities, connections };
}

function liveTools(options: AdapterOptions): readonly LiveTool[] {
  const { capabilities, connections } = exactSnapshots(options);
  const tools: LiveTool[] = [];
  for (const capabilityConnection of capabilities.connections) {
    if (
      capabilityConnection.kind !== 'external_mcp' ||
      capabilityConnection.state !== 'connected' ||
      capabilityConnection.serverId !== capabilityConnection.id ||
      !stableText(capabilityConnection.evidenceRef, 240)
    ) {
      continue;
    }
    const connection = connections.find(
      (candidate) =>
        candidate.id === capabilityConnection.id &&
        candidate.state === 'connected' &&
        candidate.trust === 'approved',
    );
    if (!connection) continue;
    for (const capabilityTool of capabilityConnection.tools) {
      const discovered = connection.tools.find(
        (candidate) =>
          candidate.name === capabilityTool.toolName &&
          candidate.exposed === true &&
          connection.exposedTools.includes(candidate.name),
      );
      const classification = discovered?.classification ?? 'write';
      if (
        !discovered ||
        capabilityTool.serverId !== capabilityConnection.serverId ||
        !SAFE_ID.test(capabilityConnection.id) ||
        !SAFE_ID.test(capabilityTool.serverId) ||
        !SAFE_ID.test(discovered.name) ||
        !stableText(discovered.description) ||
        (discovered.title !== undefined && !stableText(discovered.title, 240)) ||
        !['read', 'write', 'mutation'].includes(classification)
      ) {
        continue;
      }
      tools.push(
        Object.freeze({
          connectionId: capabilityConnection.id,
          serverId: capabilityTool.serverId,
          toolName: discovered.name,
          ...(discovered.title === undefined ? {} : { title: discovered.title }),
          description: discovered.description,
          classification,
        }),
      );
    }
  }
  tools.sort(
    (left, right) =>
      left.connectionId.localeCompare(right.connectionId) ||
      left.toolName.localeCompare(right.toolName),
  );
  return Object.freeze(tools);
}

function validateReceipt(
  receipt: Readonly<VibeSpaceMcpInvocationReceipt>,
  expected: Readonly<{
    accountId: string;
    projectId: string;
    taskId: string;
    connectionId: string;
    toolName: string;
    classification: VibeSpaceMcpInvocationClassification;
  }>,
): void {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !SAFE_RECEIPT_ID.test(receipt.receiptId) ||
    receipt.accountId !== expected.accountId ||
    receipt.projectId !== expected.projectId ||
    receipt.taskId !== expected.taskId ||
    receipt.connectionId !== expected.connectionId ||
    receipt.toolName !== expected.toolName ||
    receipt.classification !== expected.classification ||
    !stableText(receipt.schemaDigest, 240) ||
    !Number.isSafeInteger(receipt.startedAt) ||
    !Number.isSafeInteger(receipt.completedAt) ||
    receipt.startedAt < 0 ||
    receipt.completedAt < receipt.startedAt ||
    receipt.status !== 'succeeded'
  ) {
    throw new BrowserChatDownstreamMcpError('result_invalid');
  }
}

function validateResult(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BrowserChatDownstreamMcpError('result_invalid');
  }
  if (serialized === undefined || serialized.length > MAX_RESULT_CHARS) {
    throw new BrowserChatDownstreamMcpError('result_invalid');
  }
}

export function createBrowserChatDownstreamMcpAdapter(options: AdapterOptions) {
  validateScope(options);

  return Object.freeze({
    async listTools(input: { lease: BrowserChatCapabilityLease; now?: number }) {
      const operation = begin(options, input.lease, 'mcp.list', input.now);
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatDownstreamMcpError('operation_cancelled');
        }
        const allTools = liveTools(options);
        const tools = allTools.slice(0, MAX_TOOLS).map((tool) =>
          Object.freeze({
            connectionId: tool.connectionId,
            serverId: tool.serverId,
            toolName: tool.toolName,
            ...(tool.title === undefined ? {} : { title: tool.title }),
            description: tool.description,
            classification: tool.classification,
            metadataTrust: 'external_untrusted' as const,
            healthEvidence: 'live' as const,
          }),
        );
        if (operation.signal.aborted) {
          throw new BrowserChatDownstreamMcpError('operation_cancelled');
        }
        return Object.freeze({
          tools: Object.freeze(tools),
          truncated: allTools.length > MAX_TOOLS,
        });
      } finally {
        operation.finish();
      }
    },

    async invokeTool(input: {
      lease: BrowserChatCapabilityLease;
      taskId: string;
      connectionId: string;
      toolName: string;
      arguments: Readonly<Record<string, unknown>>;
      now?: number;
    }) {
      if (
        !SAFE_ID.test(input.taskId) ||
        !SAFE_ID.test(input.connectionId) ||
        !SAFE_ID.test(input.toolName)
      ) {
        throw new BrowserChatDownstreamMcpError('request_invalid');
      }
      validateArguments(input.arguments);
      if (
        !['mcp.read', 'mcp.invoke'].includes(input.lease.capabilityId) ||
        input.lease.accountId !== options.accountId ||
        input.lease.workspaceId !== options.workspaceId
      ) {
        throw new BrowserChatDownstreamMcpError(
          input.lease.accountId !== options.accountId ||
            input.lease.workspaceId !== options.workspaceId
            ? 'scope_invalid'
            : 'capability_mismatch',
        );
      }
      const tool = liveTools(options).find(
        (candidate) =>
          candidate.connectionId === input.connectionId && candidate.toolName === input.toolName,
      );
      if (!tool) throw new BrowserChatDownstreamMcpError('tool_unavailable');
      const operation = begin(
        options,
        input.lease,
        tool.classification === 'read' ? 'mcp.read' : 'mcp.invoke',
        input.now,
      );
      try {
        if (operation.signal.aborted) {
          throw new BrowserChatDownstreamMcpError('operation_cancelled');
        }
        try {
          const response = await options.gateway.invoke({
            accountId: options.accountId,
            projectId: options.projectId,
            taskId: input.taskId,
            connectionId: tool.connectionId,
            toolName: tool.toolName,
            arguments: input.arguments,
            allowedTools: [`${tool.connectionId}.${tool.toolName}`],
            classification: tool.classification,
            approval: { confirmedByUser: true },
            signal: operation.signal,
          });
          if (operation.signal.aborted) {
            throw new BrowserChatDownstreamMcpError('operation_cancelled');
          }
          validateReceipt(response.receipt, {
            accountId: options.accountId,
            projectId: options.projectId,
            taskId: input.taskId,
            connectionId: tool.connectionId,
            toolName: tool.toolName,
            classification: tool.classification,
          });
          validateResult(response.result);
          return Object.freeze({ result: response.result, receipt: response.receipt });
        } catch (error) {
          if (error instanceof BrowserChatDownstreamMcpError) throw error;
          throw new BrowserChatDownstreamMcpError(
            operation.signal.aborted ? 'operation_cancelled' : 'gateway_denied',
          );
        }
      } finally {
        operation.finish();
      }
    },
  });
}

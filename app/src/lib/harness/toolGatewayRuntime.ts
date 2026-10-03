import {
  boundToolGatewayResponse,
  type ToolGatewayRequest,
  type ToolGatewayResponse,
  type ToolGatewayTool,
  MUTATING_TOOL_GATEWAY_TOOLS,
} from './toolGatewayProtocol';
import {
  redactMcpArgumentsForAuditWithStats,
  redactMcpText,
} from '../mcp/toolResult';

export interface ToolGatewayExecutionContext {
  requestId: string;
  sessionId: string;
  messageId: string;
  directory?: string;
  worktree?: string;
  mutationApproved: boolean;
  signal?: AbortSignal;
  /** Protected native host check; never read from provider arguments. */
  isRequestLive?: () => Promise<boolean>;
}

type SemanticMethod = (
  args: Record<string, unknown>,
  context: ToolGatewayExecutionContext,
) => unknown | Promise<unknown>;

export interface ToolGatewayDependencies {
  authorizeRequest(request: ToolGatewayRequest): boolean | Promise<boolean>;
  readRequestSignal?(request: ToolGatewayRequest): AbortSignal | undefined;
  authorizeMutation(request: ToolGatewayRequest): boolean | Promise<boolean>;
  terminal: {
    list: SemanticMethod;
    open: SemanticMethod;
    focus: SemanticMethod;
    spawn: SemanticMethod;
    write: SemanticMethod;
    read: SemanticMethod;
    schedule: SemanticMethod;
  };
  command: { list: SemanticMethod; run: SemanticMethod };
  profile: { readAllAboutMe: SemanticMethod; updateAllAboutMe: SemanticMethod };
  learning: { read: SemanticMethod; update: SemanticMethod };
  context: {
    list: SemanticMethod;
    read: SemanticMethod;
    attach: SemanticMethod;
    rlm: SemanticMethod;
  };
  skills: { list: SemanticMethod; load: SemanticMethod };
  plugins: {
    list: SemanticMethod;
    run: SemanticMethod;
    /** Trusted registration metadata, never a caller-supplied classification. */
    isReadOnly?: (args: Record<string, unknown>) => boolean;
  };
  mcp: { list: SemanticMethod; run: SemanticMethod };
  tasks: { create: SemanticMethod; update: SemanticMethod };
  schedule: { create: SemanticMethod };
  app: { navigate: SemanticMethod; getState: SemanticMethod };
}

export class ToolGatewaySemanticError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(input: Readonly<{ code: string; message: string; data?: unknown }>) {
    super(input.message);
    this.name = 'ToolGatewaySemanticError';
    this.code = input.code;
    if (input.data !== undefined) this.data = input.data;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

const MAX_MCP_SOURCE_REFS = 16;
const MAX_MCP_ACTIONS = 8;
const MAX_MCP_PROJECTED_BYTES = 112 * 1024;
const MAX_MCP_COMPACTION_STEPS = 512;
const MAX_MCP_URI_CHARS = 2_048;
const MAX_MCP_LABEL_CHARS = 200;
const MAX_MCP_ACTION_CHARS = 300;
const MAX_MCP_OMITTED_COUNT = 1_000_000;
const SAFE_MCP_MIME =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/u;
const SENSITIVE_MCP_KEY_PARTS = Object.freeze([
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'passwd',
  'password',
  'privatekey',
  'secret',
  'session',
  'token',
]);

interface McpProjectionOmitted {
  inlineMedia: number;
  unsafeReferences: number;
  truncatedValues: number;
}

interface McpProjectionState {
  omitted: McpProjectionOmitted;
}

function addOmitted(
  state: McpProjectionState,
  key: keyof McpProjectionOmitted,
  amount = 1,
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  state.omitted[key] = Math.min(
    MAX_MCP_OMITTED_COUNT,
    state.omitted[key] + Math.floor(amount),
  );
}

function seededOmittedCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? Math.min(MAX_MCP_OMITTED_COUNT, value as number)
    : 0;
}

function safeMcpText(
  value: unknown,
  maxChars: number,
  state?: McpProjectionState,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = redactMcpText(value.slice(0, maxChars + 256))
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim();
  if (state && (value.length > maxChars || bounded.length > maxChars)) {
    addOmitted(state, 'truncatedValues');
  }
  return bounded ? bounded.slice(0, maxChars) : undefined;
}

function isSensitiveMcpKey(value: string): boolean {
  const compact = value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
  return SENSITIVE_MCP_KEY_PARTS.some((part) => compact.includes(part));
}

function safeMcpUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MCP_URI_CHARS) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
    if (redactMcpText(decodedPath) !== decodedPath) return undefined;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveMcpKey(key)) {
        parsed.searchParams.delete(key);
        continue;
      }
      const values = parsed.searchParams.getAll(key).map((item) => redactMcpText(item));
      parsed.searchParams.delete(key);
      for (const item of values) parsed.searchParams.append(key, item);
    }
    const normalized = parsed.toString();
    return normalized.length <= MAX_MCP_URI_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function safeMcpMime(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= 100 && SAFE_MCP_MIME.test(value)
    ? value.toLocaleLowerCase('en-US')
    : undefined;
}

function projectedMcpSourceRefs(
  value: unknown,
  state: McpProjectionState,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value)) {
    addOmitted(state, 'truncatedValues');
    return undefined;
  }
  const limit = Math.min(value.length, MAX_MCP_SOURCE_REFS);
  if (value.length > limit) addOmitted(state, 'truncatedValues', value.length - limit);
  const output: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < limit; index += 1) {
    const item = record(value[index]);
    const uri = safeMcpUri(item?.uri);
    const name = safeMcpText(item?.name, MAX_MCP_LABEL_CHARS, state);
    if (!uri || !name) {
      addOmitted(state, 'unsafeReferences');
      continue;
    }
    const title = safeMcpText(item?.title, MAX_MCP_LABEL_CHARS, state);
    const mimeType = safeMcpMime(item?.mimeType);
    output.push(
      Object.freeze({
        uri,
        name,
        ...(title === undefined ? {} : { title }),
        ...(mimeType === undefined ? {} : { mimeType }),
      }),
    );
  }
  return Object.freeze(output);
}

function projectedMcpArtifacts(
  value: unknown,
  state: McpProjectionState,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(value)) {
    addOmitted(state, 'truncatedValues');
    return undefined;
  }
  const limit = Math.min(value.length, MAX_MCP_SOURCE_REFS);
  if (value.length > limit) addOmitted(state, 'truncatedValues', value.length - limit);
  const output: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < limit; index += 1) {
    const item = record(value[index]);
    const uri = safeMcpUri(item?.uri);
    const title = safeMcpText(item?.title, MAX_MCP_LABEL_CHARS, state);
    if (item?.kind !== 'link' || !uri || !title) {
      addOmitted(state, 'unsafeReferences');
      continue;
    }
    const mimeType = safeMcpMime(item?.mimeType);
    output.push(
      Object.freeze({
        kind: 'link',
        uri,
        title,
        ...(mimeType === undefined ? {} : { mimeType }),
      }),
    );
  }
  return Object.freeze(output);
}

function projectedMcpActions(
  value: unknown,
  state: McpProjectionState,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addOmitted(state, 'truncatedValues');
    return undefined;
  }
  const limit = Math.min(value.length, MAX_MCP_ACTIONS);
  if (value.length > limit) addOmitted(state, 'truncatedValues', value.length - limit);
  const output: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const action = safeMcpText(value[index], MAX_MCP_ACTION_CHARS, state);
    if (action === undefined) {
      addOmitted(state, 'truncatedValues');
      continue;
    }
    output.push(action);
  }
  return Object.freeze(output);
}

function stripSensitiveStructuredFields(
  value: unknown,
  state: McpProjectionState,
): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(
      value
        .map((item) => stripSensitiveStructuredFields(item, state))
        .filter((item): item is Exclude<unknown, undefined> => item !== undefined),
    );
  }
  const source = record(value);
  if (!source) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (isSensitiveMcpKey(key)) {
      addOmitted(state, 'truncatedValues');
      continue;
    }
    const projected = stripSensitiveStructuredFields(item, state);
    if (projected !== undefined) output[key] = projected;
  }
  return Object.keys(output).length > 0 ? Object.freeze(output) : undefined;
}

function projectedMcpStructuredData(
  value: unknown,
  state: McpProjectionState,
): Readonly<Record<string, unknown>> | undefined {
  const source = record(value);
  if (!source) {
    addOmitted(state, 'truncatedValues');
    return undefined;
  }
  try {
    const bounded = redactMcpArgumentsForAuditWithStats(source);
    addOmitted(state, 'truncatedValues', bounded.truncatedValues);
    const projected = stripSensitiveStructuredFields(bounded.value, state);
    return record(projected) ? Object.freeze(projected) : undefined;
  } catch {
    addOmitted(state, 'truncatedValues');
    return undefined;
  }
}

function encodedJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function shrinkMcpValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length <= 64) return { value, changed: false };
    const nextLength = Math.max(32, Math.floor(value.length * 0.75));
    return { value: `${value.slice(0, nextLength - 1)}…`, changed: true };
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const child = shrinkMcpValue(value[index]);
      if (child.changed) {
        const output = [...value];
        output[index] = child.value;
        return { value: output, changed: true };
      }
    }
    if (value.length > 1) return { value: value.slice(0, -1), changed: true };
    return { value, changed: false };
  }
  const source = record(value);
  if (!source) return { value, changed: false };
  const keys = Object.keys(source);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    const child = shrinkMcpValue(source[key]);
    if (child.changed) return { value: { ...source, [key]: child.value }, changed: true };
  }
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (key === 'answer' || key === 'nonce') continue;
    const output = { ...source };
    delete output[key];
    return { value: output, changed: true };
  }
  return { value, changed: false };
}

function compactProjectedMcpData(
  result: Record<string, unknown>,
  receipt: Record<string, unknown>,
  state: McpProjectionState,
): Readonly<Record<string, unknown>> {
  const compacted: Record<string, unknown> = { ...result };
  for (const field of ['textExcerpts', 'sourceRefs', 'artifacts', 'suggestedNextActions']) {
    if (Array.isArray(compacted[field])) compacted[field] = [...compacted[field] as unknown[]];
  }

  const data = () => ({
    result: { ...compacted, omitted: { ...state.omitted } },
    ...(Object.keys(receipt).length > 0 ? { receipt } : {}),
  });
  let candidate = data();
  let steps = 0;
  while (encodedJsonBytes(candidate) > MAX_MCP_PROJECTED_BYTES && steps < MAX_MCP_COMPACTION_STEPS) {
    let changed = false;
    if (compacted.structuredData !== undefined) {
      const shrunk = shrinkMcpValue(compacted.structuredData);
      if (shrunk.changed) {
        compacted.structuredData = shrunk.value;
        changed = true;
      }
      if (changed) addOmitted(state, 'truncatedValues');
    }
    if (!changed) {
      const arrayFields = ['sourceRefs', 'artifacts', 'textExcerpts', 'suggestedNextActions'];
      const largest = arrayFields
        .map((field) => ({ field, length: Array.isArray(compacted[field]) ? compacted[field].length : 0 }))
        .sort((left, right) => right.length - left.length)
        .find(({ length }) => length > 1);
      if (largest) {
        const values = compacted[largest.field] as unknown[];
        compacted[largest.field] = values.slice(0, -1);
        addOmitted(state, 'truncatedValues');
        changed = true;
      }
    }
    if (!changed) {
      for (const field of ['safeSummary', 'contentTrust'] as const) {
        const value = compacted[field];
        const shrunk = shrinkMcpValue(value);
        if (shrunk.changed) {
          compacted[field] = shrunk.value;
          addOmitted(state, 'truncatedValues');
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      for (const field of ['sourceRefs', 'artifacts', 'textExcerpts', 'suggestedNextActions']) {
        if (Array.isArray(compacted[field]) && compacted[field].length > 0) {
          delete compacted[field];
          addOmitted(state, 'truncatedValues');
          changed = true;
          break;
        }
      }
    }
    if (!changed && compacted.structuredData !== undefined) {
      delete compacted.structuredData;
      addOmitted(state, 'truncatedValues');
      changed = true;
    }
    if (!changed) break;
    steps += 1;
    candidate = data();
  }

  if (encodedJsonBytes(candidate) > MAX_MCP_PROJECTED_BYTES) {
    addOmitted(state, 'truncatedValues');
    return Object.freeze({
      result: Object.freeze({
        ok: compacted.ok,
        ...(typeof compacted.contentTrust === 'string'
          ? { contentTrust: compacted.contentTrust.slice(0, 80) }
          : {}),
        ...(typeof compacted.safeSummary === 'string'
          ? { safeSummary: compacted.safeSummary.slice(0, 256) }
          : {}),
        omitted: Object.freeze({ ...state.omitted }),
      }),
      ...(Object.keys(receipt).length > 0 ? { receipt: Object.freeze({ ...receipt }) } : {}),
    });
  }

  return Object.freeze({
    result: Object.freeze({
      ...compacted,
      omitted: Object.freeze({ ...state.omitted }),
    }),
    ...(Object.keys(receipt).length > 0 ? { receipt: Object.freeze({ ...receipt }) } : {}),
  });
}

function projectMcpResult(value: unknown): Readonly<{
  failed: boolean;
  data: Readonly<Record<string, unknown>>;
}> {
  const failedProjection = (): Readonly<{
    failed: boolean;
    data: Readonly<Record<string, unknown>>;
  }> => Object.freeze({
    failed: true,
    data: Object.freeze({
      result: Object.freeze({
        ok: false,
        omitted: Object.freeze({ inlineMedia: 0, unsafeReferences: 0, truncatedValues: 1 }),
      }),
    }),
  });
  const envelope = record(value);
  if (!envelope) return failedProjection();
  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    return failedProjection();
  }
  const result = record(envelope.result);
  if (!result) return failedProjection();
  const receipt = record(envelope.receipt);
  if (Object.prototype.hasOwnProperty.call(envelope, 'receipt') && !receipt) return failedProjection();
  const resultOk = result.ok === true || result.ok === false ? result.ok : undefined;
  if (typeof resultOk !== 'boolean') return failedProjection();
  const receiptStatus = receipt?.status === 'failed' || receipt?.status === 'cancelled'
    ? receipt.status
    : receipt?.status === 'succeeded'
      ? receipt.status
      : undefined;
  const inferredOk = resultOk === false || receiptStatus === 'failed' || receiptStatus === 'cancelled'
    ? false
    : resultOk === true || receiptStatus === 'succeeded'
      ? true
      : undefined;
  if (typeof inferredOk !== 'boolean') return failedProjection();

  const omittedRecord = record(result.omitted);
  const state: McpProjectionState = {
    omitted: {
      inlineMedia:
        seededOmittedCount(omittedRecord?.inlineMedia),
      unsafeReferences:
        seededOmittedCount(omittedRecord?.unsafeReferences),
      truncatedValues:
        seededOmittedCount(omittedRecord?.truncatedValues),
    },
  };
  const safeResult: Record<string, unknown> = { ok: inferredOk };
  const contentTrust = safeMcpText(result.contentTrust, 80, state);
  const safeSummary = safeMcpText(result.safeSummary, 1_024, state);
  if (contentTrust !== undefined) safeResult.contentTrust = contentTrust;
  if (safeSummary !== undefined) safeResult.safeSummary = safeSummary;
  if (Object.prototype.hasOwnProperty.call(result, 'textExcerpts')) {
    if (!Array.isArray(result.textExcerpts)) {
      addOmitted(state, 'truncatedValues');
    } else {
      if (result.textExcerpts.length > 8) {
        addOmitted(state, 'truncatedValues', result.textExcerpts.length - 8);
      }
      safeResult.textExcerpts = result.textExcerpts
      .slice(0, 8)
      .map((item) => {
        const projected = safeMcpText(item, 1_000, state);
        if (projected === undefined) addOmitted(state, 'truncatedValues');
        return projected;
      })
      .filter((item): item is string => item !== undefined);
    }
  }

  if (Object.prototype.hasOwnProperty.call(result, 'sourceRefs')) {
    const sourceRefs = projectedMcpSourceRefs(result.sourceRefs, state);
    if (sourceRefs !== undefined) safeResult.sourceRefs = sourceRefs;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'artifacts')) {
    const artifacts = projectedMcpArtifacts(result.artifacts, state);
    if (artifacts !== undefined) safeResult.artifacts = artifacts;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'suggestedNextActions')) {
    const suggestedNextActions = projectedMcpActions(result.suggestedNextActions, state);
    if (suggestedNextActions !== undefined) safeResult.suggestedNextActions = suggestedNextActions;
  }
  if (result.structuredData !== undefined) {
    const structuredData = projectedMcpStructuredData(result.structuredData, state);
    if (structuredData !== undefined) safeResult.structuredData = structuredData;
  }
  const safeReceipt: Record<string, unknown> = {};
  const receiptId = safeMcpText(receipt?.receiptId, 200, state);
  const connectionId = safeMcpText(receipt?.connectionId, 200, state);
  const toolName = safeMcpText(receipt?.toolName, 200, state);
  const status = safeMcpText(receipt?.status, 40, state);
  if (receiptId !== undefined) safeReceipt.receiptId = receiptId;
  if (connectionId !== undefined) safeReceipt.connectionId = connectionId;
  if (toolName !== undefined) safeReceipt.toolName = toolName;
  if (status !== undefined) safeReceipt.status = status;
  for (const key of ['startedAt', 'completedAt'] as const) {
    const timestamp = receipt?.[key];
    if (Number.isSafeInteger(timestamp) && (timestamp as number) >= 0) {
      safeReceipt[key] = timestamp as number;
    }
  }

  const data = compactProjectedMcpData(safeResult, safeReceipt, state);
  return Object.freeze({ failed: inferredOk === false, data });
}

function executionContext(
  request: ToolGatewayRequest,
  mutationApproved: boolean,
  signal?: AbortSignal,
  isRequestLive?: () => Promise<boolean>,
): ToolGatewayExecutionContext {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    messageId: request.messageId,
    ...(request.directory ? { directory: request.directory } : {}),
    ...(request.worktree ? { worktree: request.worktree } : {}),
    mutationApproved,
    ...(signal ? { signal } : {}),
    ...(isRequestLive ? { isRequestLive } : {}),
  };
}

function requiresMutationApproval(request: ToolGatewayRequest, deps: ToolGatewayDependencies): boolean {
  if (!MUTATING_TOOL_GATEWAY_TOOLS.has(request.tool)) return false;
  if (request.tool === 'plugins.run' && deps.plugins.isReadOnly?.(request.args) === true) return false;
  if (request.tool !== 'mcp.run') return true;

  // `mcp.run` can address either a read-only or a mutating external tool.
  // Treat it as read-only only after the request has crossed the parser's
  // plain-data boundary. Production dispatch independently checks that this
  // classification matches the approved tool metadata before invoking it.
  return record(request.args)?.classification !== 'read';
}

export function createToolGatewayRuntime(deps: ToolGatewayDependencies): {
  execute(request: ToolGatewayRequest, transportSignal?: AbortSignal, isRequestLive?: () => Promise<boolean>): Promise<ToolGatewayResponse>;
} {
  const handlers: Partial<Record<ToolGatewayTool, SemanticMethod>> = {
    'terminal.list': deps.terminal.list,
    'terminal.open': deps.terminal.open,
    'terminal.focus': deps.terminal.focus,
    'terminal.spawn': deps.terminal.spawn,
    'terminal.write': deps.terminal.write,
    'terminal.read': deps.terminal.read,
    'terminal.schedule': deps.terminal.schedule,
    'command.list': deps.command.list,
    'profile.allAboutMe.read': deps.profile.readAllAboutMe,
    'profile.allAboutMe.update': deps.profile.updateAllAboutMe,
    'memory.learning.read': deps.learning.read,
    'memory.learning.update': deps.learning.update,
    'context.list': deps.context.list,
    'context.read': deps.context.read,
    'context.attach': deps.context.attach,
    vibespace_context: deps.context.rlm,
    vibespace_context_search: deps.context.rlm,
    vibespace_context_open: deps.context.rlm,
    vibespace_context_expand: deps.context.rlm,
    vibespace_context_address: deps.context.rlm,
    vibespace_context_trace: deps.context.rlm,
    'skills.list': deps.skills.list,
    'skills.load': deps.skills.load,
    'plugins.list': deps.plugins.list,
    'plugins.run': deps.plugins.run,
    'mcp.list': deps.mcp.list,
    'mcp.run': deps.mcp.run,
    'tasks.create': deps.tasks.create,
    'tasks.update': deps.tasks.update,
    'schedule.create': deps.schedule.create,
    'app.navigate': deps.app.navigate,
    'app.getState': deps.app.getState,
  };

  return {
    async execute(request, transportSignal, isRequestLive) {
      const ownerSignal = deps.readRequestSignal?.(request);
      const signals = [ownerSignal, transportSignal].filter((value): value is AbortSignal => !!value);
      const combined = signals.length > 1 ? new AbortController() : undefined;
      const abort = () => combined?.abort();
      for (const signal of signals) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      const signal = combined?.signal ?? signals[0];
      const cancelled = (): ToolGatewayResponse => ({
        requestId: request.requestId, ok: false, code: 'cancelled',
        message: 'The VibeSpace request was cancelled.',
      });
      let abortHandler: (() => void) | undefined;
      try {
        // Capture the owner's reference before async approval can release its session lease.
        if (signal?.aborted) return cancelled();
        if (!(await deps.authorizeRequest(request))) {
          return {
            requestId: request.requestId,
            ok: false,
            code: 'authority_revoked',
            message: 'The VibeSpace account or workspace authority changed.',
          };
        }
        const mutation = requiresMutationApproval(request, deps);
        if (mutation && !(await deps.authorizeMutation(request))) {
          return {
            requestId: request.requestId,
            ok: false,
            code: 'permission_denied',
            message: 'VibeSpace did not approve this semantic mutation.',
          };
        }
        if (signal?.aborted) {
          return cancelled();
        }
        const handler = handlers[request.tool];
        if (!handler) {
          return {
            requestId: request.requestId,
            ok: false,
            code: 'tool_unavailable',
            message: 'The requested semantic tool is unavailable.',
          };
        }
        if (isRequestLive && !(await isRequestLive())) return cancelled();
        if (signal?.aborted) return cancelled();
        const execution = Promise.resolve(handler(
          request.args,
          executionContext(request, mutation, signal, isRequestLive),
        ));
        const data = await (signal ? Promise.race([
          execution,
          new Promise<never>((_resolve, reject) => {
            abortHandler = () => reject(Error('tool_request_cancelled'));
            signal.addEventListener('abort', abortHandler, { once: true });
            if (signal.aborted) abortHandler();
          }),
        ]) : execution);
        if (signal?.aborted || (isRequestLive && !(await isRequestLive()))) return cancelled();
        const mcpResult = request.tool === 'mcp.run' ? projectMcpResult(data) : undefined;
        if (mcpResult) {
          return boundToolGatewayResponse({
            requestId: request.requestId,
            ok: !mcpResult.failed,
            code: mcpResult.failed ? 'mcp_tool_failed' : 'ok',
            message: mcpResult.failed
              ? 'The external MCP tool reported an execution error.'
              : 'The semantic tool completed.',
            data: mcpResult.data,
          });
        }
        return boundToolGatewayResponse({
          requestId: request.requestId,
          ok: true,
          code: 'ok',
          message: 'The semantic tool completed.',
          ...(data === undefined ? {} : { data }),
        });
      } catch (error) {
        if (signal?.aborted) return cancelled();
        if (error instanceof ToolGatewaySemanticError) {
          return boundToolGatewayResponse({
            requestId: request.requestId,
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          });
        }
        return {
          requestId: request.requestId,
          ok: false,
          code: 'tool_failed',
          message: 'The semantic tool could not be completed.',
        };
      } finally {
        if (abortHandler) signal?.removeEventListener('abort', abortHandler);
        for (const signal of signals) signal.removeEventListener('abort', abort);
      }
    },
  };
}

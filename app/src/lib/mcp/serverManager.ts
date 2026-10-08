import { toolRegistry } from './registry';
import { supabaseMcpAdapter } from './supabaseAdapter';
import {
  routeMcpToolsForTask,
  type McpRoutedTool,
  type McpToolRouteCandidate,
} from './toolRouting';
import {
  normalizeExternalMcpToolResult,
  redactMcpArgumentsForAudit,
  redactMcpText,
  type NormalizedExternalMcpToolResult,
} from './toolResult';

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CanonicalMcpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type McpServerKind = 'local_mcp_lite' | 'external_mcp';

export type McpToolExposurePolicy =
  | Readonly<{ mode: 'none' }>
  | Readonly<{ mode: 'allowlist'; toolNames: readonly string[] }>;

export interface McpServerRegistration {
  kind?: McpServerKind;
  domains?: readonly string[];
  exposure?: McpToolExposurePolicy;
}

export interface McpServerClient {
  listTools: (signal?: AbortSignal) => Promise<McpToolDescriptor[]>;
  invoke: (toolName: string, input: unknown, options?: McpClientInvokeOptions) => Promise<unknown>;
  health: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export interface McpProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
  readonly contentTrust: 'app_trusted' | 'external_untrusted';
}

export interface McpClientProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface McpClientInvokeOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: McpClientProgressUpdate) => void;
}

export interface McpInvocationAudit {
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface McpServerAdapter {
  id: string;
  start: (signal?: AbortSignal) => Promise<McpServerClient>;
}

export type McpServerState = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'failed';

export interface McpServerStatus {
  id: string;
  kind: McpServerKind;
  state: McpServerState;
  healthy: boolean;
  exposedTools: readonly string[];
  toolsDiscoveredAt?: number;
  lastUsedAt?: number;
  error?: string;
}

interface ManagedServer {
  adapter: McpServerAdapter;
  kind: McpServerKind;
  domains: readonly string[];
  exposure: McpToolExposurePolicy;
  retiring: boolean;
  state: McpServerState;
  generation: number;
  client?: McpServerClient;
  tools?: readonly Readonly<CanonicalMcpToolDescriptor>[];
  toolsDiscoveredAt?: number;
  discovery?: ManagedDiscovery;
  startPromise?: Promise<McpServerStatus>;
  startController?: AbortController;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsedAt?: number;
  error?: string;
}

interface ManagedDiscovery {
  controller: AbortController;
  promise: Promise<readonly Readonly<CanonicalMcpToolDescriptor>[]>;
  waiters: number;
}

export interface McpServerManagerOptions {
  invocationTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface McpListToolsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpInvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  restartOnFailure?: boolean;
  onProgress?: (update: McpProgressUpdate) => void;
  onInvocationAudit?: (audit: McpInvocationAudit) => void;
}

export interface McpRouteOptions {
  serverIds?: readonly string[];
  includeLocal?: boolean;
  limit?: number;
}

const MAX_DISCOVERED_TOOLS = 64;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_TITLE_CHARS = 160;
const MAX_TOOL_DESCRIPTION_CHARS = 1_000;
const MAX_DOMAINS = 16;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_PROPERTIES = 32;
const MAX_SCHEMA_ENUM_VALUES = 32;
const MAX_SCHEMA_STRING_CHARS = 240;
const MAX_DISCOVERY_SCHEMA_TEXT_CHARS = 64 * 1_024;
const MAX_ARGUMENT_NODES = 512;
const MAX_ARGUMENT_KEYS = 128;
const MAX_ARGUMENT_ARRAY_ITEMS = 256;
const MAX_ARGUMENT_TEXT_CHARS = 256 * 1_024;
const MAX_TOOL_CACHE_AGE_MS = 5 * 60_000;
const MAX_PROGRESS_UPDATES = 32;
const MAX_PROGRESS_MESSAGE_CHARS = 300;
const PROGRESS_REDACTION_GUARD_CHARS = 256;
const UNSAFE_TEXT_CHARACTERS = /[\p{C}\p{Zl}\p{Zp}]/u;
const SAFE_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_SCHEMA_PROPERTY = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u;
const FORBIDDEN_SCHEMA_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype']);
const SAFE_DOMAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

class NoActiveDiscoveryWaitersError extends Error {
  constructor() {
    super('MCP tool discovery has no active callers.');
    this.name = 'NoActiveDiscoveryWaitersError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callerCancellationError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('MCP request cancelled.', 'AbortError');
}

function ownDataValue(source: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function canonicalProgressUpdate(
  value: unknown,
  lastProgress: number,
  contentTrust: McpProgressUpdate['contentTrust'],
): Readonly<McpProgressUpdate> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const progress = ownDataValue(source, 'progress');
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0) {
    return undefined;
  }
  if (progress <= lastProgress) return undefined;
  const total = ownDataValue(source, 'total');
  if (
    total !== undefined &&
    (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || progress > total)
  ) {
    return undefined;
  }
  const rawMessage = ownDataValue(source, 'message');
  if (rawMessage !== undefined && typeof rawMessage !== 'string') return undefined;
  const messageWasTruncated =
    typeof rawMessage === 'string' && rawMessage.length > MAX_PROGRESS_MESSAGE_CHARS;
  const redactedMessage =
    rawMessage === undefined
      ? undefined
      : redactMcpText(
          rawMessage.slice(0, MAX_PROGRESS_MESSAGE_CHARS + PROGRESS_REDACTION_GUARD_CHARS),
        ).trim();
  if (
    redactedMessage !== undefined &&
    (!redactedMessage || UNSAFE_TEXT_CHARACTERS.test(redactedMessage))
  ) {
    return undefined;
  }
  const message =
    redactedMessage === undefined
      ? undefined
      : !messageWasTruncated && redactedMessage.length <= MAX_PROGRESS_MESSAGE_CHARS
        ? redactedMessage
        : `${redactedMessage.slice(0, MAX_PROGRESS_MESSAGE_CHARS - 1)}…`;
  return Object.freeze({
    progress,
    ...(total === undefined ? {} : { total }),
    ...(message === undefined ? {} : { message }),
    contentTrust,
  });
}

function notifyObserver<T>(observer: ((value: T) => void) | undefined, value: T): void {
  if (!observer) return;
  try {
    const pending = (observer as (candidate: T) => unknown)(value);
    if (
      pending &&
      (typeof pending === 'object' || typeof pending === 'function') &&
      typeof (pending as PromiseLike<unknown>).then === 'function'
    ) {
      void Promise.resolve(pending).catch(() => undefined);
    }
  } catch {
    // Diagnostic/activity observers cannot affect execution.
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, field: string, maxChars: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`Invalid MCP tool ${field}.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars || UNSAFE_TEXT_CHARACTERS.test(normalized)) {
    throw new Error(`Invalid MCP tool ${field}.`);
  }
  return normalized;
}

function toolName(value: unknown): string {
  const name = boundedText(value, 'name', MAX_TOOL_NAME_CHARS);
  if (!SAFE_TOOL_NAME.test(name)) throw new Error('Invalid MCP tool name.');
  return name;
}

function canonicalDomain(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid MCP server domain.');
  const domain = value.trim().toLocaleLowerCase('en-US');
  if (!SAFE_DOMAIN.test(domain)) throw new Error('Invalid MCP server domain.');
  return domain;
}

function freezeValue<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

interface SchemaBudget {
  nodes: number;
  textChars: number;
  seen: WeakSet<object>;
}

function consumeSchemaText(budget: SchemaBudget, value: string): void {
  budget.textChars += value.length;
  if (budget.textChars > MAX_DISCOVERY_SCHEMA_TEXT_CHARS) {
    throw new Error('Aggregate MCP schema text budget exceeded.');
  }
}

function canonicalEnum(value: unknown, budget: SchemaBudget): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SCHEMA_ENUM_VALUES) {
    throw new Error('Invalid MCP tool input schema enum.');
  }
  const output = value.map((entry) => {
    if (typeof entry === 'string') {
      if (entry.length > MAX_SCHEMA_STRING_CHARS || UNSAFE_TEXT_CHARACTERS.test(entry)) {
        throw new Error('Invalid MCP tool input schema enum.');
      }
      consumeSchemaText(budget, entry);
      return entry;
    }
    if (
      entry === null ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return entry;
    }
    throw new Error('Invalid MCP tool input schema enum.');
  });
  return Object.freeze(output);
}

function canonicalSchemaNode(
  value: unknown,
  depth: number,
  budget: SchemaBudget,
  root = false,
): Readonly<Record<string, unknown>> {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error('MCP tool input schema is too deep.');
  const source = record(value);
  if (!source) throw new Error('Invalid MCP tool input schema.');
  if (budget.seen.has(source)) throw new Error('Cyclic MCP tool input schema.');
  budget.seen.add(source);
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NODES) throw new Error('MCP tool input schema is too complex.');

  const type = source.type;
  if (typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) {
    throw new Error('Invalid MCP tool input schema type.');
  }
  if (root && type !== 'object') throw new Error('MCP tool input schema root must be an object.');

  const output: Record<string, unknown> = { type };
  const enumValues = canonicalEnum(source.enum, budget);
  if (enumValues !== undefined) output.enum = enumValues;

  if (type === 'object') {
    const properties = source.properties === undefined ? {} : record(source.properties);
    if (!properties) throw new Error('Invalid MCP tool input schema properties.');
    const entries: [string, unknown][] = [];
    for (const key in properties) {
      if (!Object.hasOwn(properties, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(properties, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('Invalid MCP tool input schema property.');
      }
      entries.push([key, descriptor.value]);
      if (entries.length > MAX_SCHEMA_PROPERTIES) {
        throw new Error('MCP tool input schema has too many properties.');
      }
    }
    entries.sort(([left], [right]) => left.localeCompare(right, 'en', { sensitivity: 'variant' }));
    const canonicalProperties: Record<string, unknown> = {};
    for (const [key, propertySchema] of entries) {
      if (!SAFE_SCHEMA_PROPERTY.test(key) || FORBIDDEN_SCHEMA_PROPERTIES.has(key)) {
        throw new Error('Invalid MCP tool input schema property name.');
      }
      consumeSchemaText(budget, key);
      canonicalProperties[key] = canonicalSchemaNode(propertySchema, depth + 1, budget);
    }
    output.properties = canonicalProperties;

    if (source.required !== undefined) {
      if (!Array.isArray(source.required) || source.required.length > MAX_SCHEMA_PROPERTIES) {
        throw new Error('Invalid MCP tool input schema required list.');
      }
      const required = [
        ...new Set(
          source.required.map((entry) => {
            if (typeof entry !== 'string' || !Object.hasOwn(canonicalProperties, entry)) {
              throw new Error('Invalid MCP tool input schema required property.');
            }
            consumeSchemaText(budget, entry);
            return entry;
          }),
        ),
      ].sort((left, right) => left.localeCompare(right, 'en'));
      if (required.length > 0) output.required = required;
    }

    // Model-facing schemas never grant undeclared argument names. Provider
    // descriptions/defaults/examples are intentionally excluded as untrusted
    // prompt-like metadata.
    output.additionalProperties = false;
  } else if (type === 'array') {
    if (source.items === undefined) throw new Error('MCP array schema requires items.');
    output.items = canonicalSchemaNode(source.items, depth + 1, budget);
  }

  budget.seen.delete(source);
  return freezeValue(output);
}

function canonicalInputSchema(
  value: unknown,
  budget: SchemaBudget,
): Readonly<Record<string, unknown>> {
  const source = value ?? { type: 'object', properties: {}, additionalProperties: false };
  return canonicalSchemaNode(source, 0, budget, true);
}

interface ArgumentValidationBudget {
  nodes: number;
  keys: number;
  textChars: number;
  active: WeakSet<object>;
}

function invalidToolArguments(): Error {
  return new Error('MCP tool arguments do not match the current input schema.');
}

function consumeArgumentNode(budget: ArgumentValidationBudget): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_ARGUMENT_NODES) throw invalidToolArguments();
}

function validateArgumentValue(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  depth: number,
  budget: ArgumentValidationBudget,
): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw invalidToolArguments();
  consumeArgumentNode(budget);
  const type = ownDataValue(schema as Record<string, unknown>, 'type');
  const enumValues = ownDataValue(schema as Record<string, unknown>, 'enum');

  if (Array.isArray(enumValues) && !enumValues.some((entry) => Object.is(entry, value))) {
    throw invalidToolArguments();
  }
  if (type === 'null') {
    if (value !== null) throw invalidToolArguments();
    return null;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw invalidToolArguments();
    return value;
  }
  if (type === 'integer') {
    if (!Number.isSafeInteger(value)) throw invalidToolArguments();
    return value;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidToolArguments();
    return value;
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw invalidToolArguments();
    budget.textChars += value.length;
    if (budget.textChars > MAX_ARGUMENT_TEXT_CHARS) throw invalidToolArguments();
    return value;
  }
  if (!value || typeof value !== 'object' || budget.active.has(value)) {
    throw invalidToolArguments();
  }
  budget.active.add(value);
  try {
    if (type === 'array') {
      if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > MAX_ARGUMENT_ARRAY_ITEMS
      ) {
        throw invalidToolArguments();
      }
      const elementKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (
        elementKeys.length !== value.length ||
        elementKeys.some((key) => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key))
      ) {
        throw invalidToolArguments();
      }
      const itemSchema = ownDataValue(schema as Record<string, unknown>, 'items');
      const canonicalItemSchema = record(itemSchema);
      if (!canonicalItemSchema) throw invalidToolArguments();
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw invalidToolArguments();
        }
        output.push(
          validateArgumentValue(canonicalItemSchema, descriptor.value, depth + 1, budget),
        );
      }
      return Object.freeze(output);
    }
    if (type !== 'object' || Array.isArray(value)) throw invalidToolArguments();
    const input = record(value);
    const properties = record(ownDataValue(schema as Record<string, unknown>, 'properties'));
    if (!input || !properties) throw invalidToolArguments();
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.some((key) => typeof key !== 'string')) throw invalidToolArguments();
    const keys = ownKeys as string[];
    budget.keys += keys.length;
    if (keys.length > MAX_ARGUMENT_KEYS || budget.keys > MAX_ARGUMENT_KEYS) {
      throw invalidToolArguments();
    }
    const required = ownDataValue(schema as Record<string, unknown>, 'required');
    if (
      Array.isArray(required) &&
      required.some((key) => typeof key !== 'string' || !Object.hasOwn(input, key))
    ) {
      throw invalidToolArguments();
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (!Object.hasOwn(properties, key)) throw invalidToolArguments();
      const inputDescriptor = Object.getOwnPropertyDescriptor(input, key);
      const schemaDescriptor = Object.getOwnPropertyDescriptor(properties, key);
      if (
        !inputDescriptor ||
        !inputDescriptor.enumerable ||
        !('value' in inputDescriptor) ||
        !schemaDescriptor ||
        !('value' in schemaDescriptor)
      ) {
        throw invalidToolArguments();
      }
      const propertySchema = record(schemaDescriptor.value);
      if (!propertySchema) throw invalidToolArguments();
      budget.textChars += key.length;
      if (budget.textChars > MAX_ARGUMENT_TEXT_CHARS) throw invalidToolArguments();
      output[key] = validateArgumentValue(propertySchema, inputDescriptor.value, depth + 1, budget);
    }
    return Object.freeze(output);
  } finally {
    budget.active.delete(value);
  }
}

function validateExternalToolArguments(
  schema: Readonly<Record<string, unknown>>,
  input: unknown,
): Readonly<Record<string, unknown>> {
  const validated = validateArgumentValue(schema, input, 0, {
    nodes: 0,
    keys: 0,
    textChars: 0,
    active: new WeakSet(),
  });
  const canonical = record(validated);
  if (!canonical) throw invalidToolArguments();
  return canonical;
}

function canonicalTools(value: unknown): readonly Readonly<CanonicalMcpToolDescriptor>[] {
  if (!Array.isArray(value)) throw new Error('Invalid MCP tool discovery response.');
  if (value.length > MAX_DISCOVERED_TOOLS) throw new Error('Too many MCP tools returned.');
  const seen = new Set<string>();
  const schemaBudget: SchemaBudget = {
    nodes: 0,
    textChars: 0,
    seen: new WeakSet(),
  };
  const tools = value.map((entry): Readonly<CanonicalMcpToolDescriptor> => {
    const source = record(entry);
    if (!source) throw new Error('Invalid MCP tool descriptor.');
    const name = toolName(source.name);
    if (seen.has(name)) throw new Error(`Duplicate MCP tool name '${name}'.`);
    seen.add(name);
    const title =
      source.title === undefined
        ? undefined
        : boundedText(source.title, 'title', MAX_TOOL_TITLE_CHARS);
    return freezeValue({
      name,
      ...(title === undefined ? {} : { title }),
      description: boundedText(
        source.description,
        'description',
        MAX_TOOL_DESCRIPTION_CHARS,
        'No description provided.',
      ),
      inputSchema: canonicalInputSchema(source.inputSchema, schemaBudget),
    });
  });
  tools.sort((left, right) =>
    left.name.localeCompare(right.name, 'en', { numeric: true, sensitivity: 'variant' }),
  );
  return Object.freeze(tools);
}

function canonicalExposure(policy: McpToolExposurePolicy | undefined): McpToolExposurePolicy {
  if (!policy || policy.mode === 'none') return Object.freeze({ mode: 'none' });
  if (policy.mode !== 'allowlist' || !Array.isArray(policy.toolNames)) {
    throw new Error('Invalid MCP tool exposure policy.');
  }
  if (policy.toolNames.length > MAX_DISCOVERED_TOOLS) {
    throw new Error('MCP tool exposure allowlist is too large.');
  }
  const names = [...new Set(policy.toolNames.map(toolName))].sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true, sensitivity: 'variant' }),
  );
  return Object.freeze({ mode: 'allowlist', toolNames: Object.freeze(names) });
}

export class McpServerManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly invocationTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: McpServerManagerOptions = {}) {
    this.invocationTimeoutMs = options.invocationTimeoutMs ?? 30_000;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  register(
    adapter: McpServerAdapter,
    registration: McpServerRegistration = {},
  ): () => Promise<void> {
    if (!adapter || typeof adapter.id !== 'string' || !SAFE_SERVER_ID.test(adapter.id)) {
      throw new Error('Invalid MCP server id.');
    }
    if (this.servers.has(adapter.id))
      throw new Error(`MCP server '${adapter.id}' is already registered.`);
    const domains = [...new Set((registration.domains ?? []).map(canonicalDomain))].sort();
    if (domains.length > MAX_DOMAINS) throw new Error('Too many MCP server domains.');
    const server: ManagedServer = {
      adapter,
      kind: registration.kind ?? 'external_mcp',
      domains: Object.freeze(domains),
      exposure: canonicalExposure(registration.exposure),
      retiring: false,
      state: 'stopped',
      generation: 0,
    };
    this.servers.set(adapter.id, server);
    let unregisterPromise: Promise<void> | undefined;
    return () => {
      if (!unregisterPromise) {
        server.retiring = true;
        unregisterPromise = (async () => {
          if (this.servers.get(adapter.id) !== server) return;
          await this.stop(adapter.id);
          if (this.servers.get(adapter.id) === server) {
            this.servers.delete(adapter.id);
          }
        })();
      }
      return unregisterPromise;
    };
  }

  setToolExposure(id: string, exposure: McpToolExposurePolicy): void {
    this.requireServer(id).exposure = canonicalExposure(exposure);
  }

  discover(): McpServerStatus[] {
    return [...this.servers.keys()].sort().map((id) => this.status(id));
  }

  status(id: string): McpServerStatus {
    const server = this.requireServer(id);
    return {
      id,
      kind: server.kind,
      state: server.state,
      healthy: server.state === 'running',
      exposedTools: this.exposedToolNames(server),
      toolsDiscoveredAt: server.toolsDiscoveredAt,
      lastUsedAt: server.lastUsedAt,
      error: server.error,
    };
  }

  async start(id: string): Promise<McpServerStatus> {
    const server = this.requireServer(id);
    if (server.retiring) {
      throw new Error(`MCP server '${id}' is being unregistered.`);
    }
    if (server.state === 'running' && server.client) {
      this.touch(id, server);
      return this.status(id);
    }
    if (server.startPromise) return server.startPromise;

    const generation = server.generation;
    const controller = new AbortController();
    server.startController = controller;
    let startingClient: McpServerClient | undefined;
    let closePromise: Promise<void> | undefined;
    const closeStartingClient = () => {
      if (!startingClient) return Promise.resolve();
      closePromise ??= Promise.resolve().then(() => startingClient!.stop()).catch(() => undefined);
      return closePromise;
    };
    const abortStartup = () => { void closeStartingClient(); };
    controller.signal.addEventListener('abort', abortStartup, { once: true });
    server.state = 'starting';
    server.error = undefined;
    server.startPromise = (async () => {
      try {
        const staleDiscovery = server.discovery?.promise;
        this.invalidateDiscovery(server, new Error('MCP server generation changed.'));
        if (staleDiscovery) await staleDiscovery.catch(() => undefined);
        const staleClient = server.client;
        server.client = undefined;
        if (staleClient) await staleClient.stop().catch(() => undefined);
        controller.signal.throwIfAborted();
        const client = await server.adapter.start(controller.signal);
        startingClient = client;
        if (controller.signal.aborted || server.generation !== generation) {
          await closeStartingClient();
          server.state = 'stopped';
          server.error = undefined;
          return this.status(id);
        }
        if (!(await client.health())) {
          await closeStartingClient();
          throw new Error('health check failed');
        }
        if (server.generation !== generation || controller.signal.aborted) {
          await closeStartingClient();
          server.state = 'stopped';
          server.error = undefined;
          return this.status(id);
        }
        server.client = client;
        server.state = 'running';
        this.touch(id, server);
        return this.status(id);
      } catch (error) {
        await closeStartingClient();
        if (server.generation !== generation) {
          server.client = undefined;
          server.state = 'stopped';
          server.error = undefined;
          return this.status(id);
        }
        server.client = undefined;
        server.state = 'failed';
        server.error = errorMessage(error);
        throw new Error(`MCP server '${id}' failed to start: ${server.error}`);
      } finally {
        controller.signal.removeEventListener('abort', abortStartup);
        if (server.startController === controller) server.startController = undefined;
        server.startPromise = undefined;
      }
    })();
    return server.startPromise;
  }

  async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;
    const pendingStart = server.startPromise;
    const pendingDiscovery = server.discovery?.promise;
    server.generation += 1;
    server.startController?.abort(new DOMException('MCP server stopped during startup.', 'AbortError'));
    if (server.idleTimer) clearTimeout(server.idleTimer);
    server.idleTimer = undefined;
    const client = server.client;
    server.client = undefined;
    this.invalidateDiscovery(server, new Error('MCP server stopped during discovery.'));
    server.state = 'stopped';
    server.error = undefined;
    if (client) await client.stop().catch(() => undefined);
    if (pendingStart) await pendingStart.catch(() => undefined);
    if (pendingDiscovery) await pendingDiscovery.catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
  }

  async health(id: string): Promise<McpServerStatus> {
    const server = this.requireServer(id);
    if (!server.client || server.state !== 'running') return this.status(id);
    const client = server.client;
    const generation = server.generation;
    try {
      const healthy = await client.health();
      if (server.generation !== generation || server.client !== client) {
        return this.status(id);
      }
      if (!healthy) {
        server.state = 'unhealthy';
        server.error = 'Health check failed.';
        this.invalidateDiscovery(server, new Error('MCP server became unhealthy.'));
      }
    } catch (error) {
      if (server.generation !== generation || server.client !== client) {
        return this.status(id);
      }
      server.state = 'unhealthy';
      server.error = errorMessage(error);
      this.invalidateDiscovery(server, new Error('MCP server health check failed.'));
    }
    return this.status(id);
  }

  async listTools(
    id: string,
    options: McpListToolsOptions = {},
  ): Promise<readonly Readonly<CanonicalMcpToolDescriptor>[]> {
    await this.start(id);
    const server = this.requireServer(id);
    if (!server.client || server.state !== 'running') {
      throw new Error(`MCP server '${id}' was stopped during startup.`);
    }
    if (server.discovery) return this.waitForDiscovery(id, server, server.discovery, options);

    const client = server.client;
    const generation = server.generation;
    const controller = new AbortController();
    const transportTimeoutMs = this.normalizedDiscoveryTimeout(this.discoveryTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortRaceListener: (() => void) | undefined;

    const discovery = (async (): Promise<readonly Readonly<CanonicalMcpToolDescriptor>[]> => {
      try {
        this.touch(id, server);
        timer = setTimeout(() => {
          controller.abort(
            new Error(`MCP ${id} tool discovery timed out after ${transportTimeoutMs}ms.`),
          );
        }, transportTimeoutMs);
        const aborted = new Promise<never>((_, reject) => {
          const rejectAbort = () => {
            const reason = controller.signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new DOMException('MCP tool discovery cancelled.', 'AbortError'),
            );
          };
          if (controller.signal.aborted) rejectAbort();
          else {
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            removeAbortRaceListener = () =>
              controller.signal.removeEventListener('abort', rejectAbort);
          }
        });
        const tools = canonicalTools(
          await Promise.race([client.listTools(controller.signal), aborted]),
        );
        if (
          server.generation !== generation ||
          server.client !== client ||
          server.state !== 'running'
        ) {
          throw new Error(`MCP server '${id}' was stopped during discovery.`);
        }
        server.tools = tools;
        server.toolsDiscoveredAt = Date.now();
        return tools;
      } catch (error) {
        const abandoned =
          error instanceof NoActiveDiscoveryWaitersError ||
          controller.signal.reason instanceof NoActiveDiscoveryWaitersError;
        if (
          !abandoned &&
          server.generation === generation &&
          server.client === client &&
          server.state === 'running'
        ) {
          server.tools = undefined;
          server.toolsDiscoveredAt = undefined;
          server.state = 'unhealthy';
          server.error = errorMessage(error);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        removeAbortRaceListener?.();
        if (server.discovery?.controller === controller) server.discovery = undefined;
      }
    })();
    const session: ManagedDiscovery = {
      controller,
      promise: discovery,
      waiters: 0,
    };
    server.discovery = session;
    return this.waitForDiscovery(id, server, session, options);
  }

  routeTools(query: string, options: McpRouteOptions = {}): readonly Readonly<McpRoutedTool>[] {
    const allowedServerIds =
      options.serverIds === undefined ? undefined : new Set(options.serverIds);
    const candidates: McpToolRouteCandidate[] = [];
    for (const [serverId, server] of this.servers) {
      if (
        server.state !== 'running' ||
        !server.tools ||
        (allowedServerIds && !allowedServerIds.has(serverId))
      ) {
        continue;
      }
      const toolNames =
        server.kind === 'local_mcp_lite' && options.includeLocal === true
          ? new Set(server.tools.map(({ name }) => name))
          : new Set(this.exposedToolNames(server));
      for (const tool of server.tools) {
        if (!toolNames.has(tool.name)) continue;
        candidates.push({
          serverId,
          serverKind: server.kind,
          domains: server.domains,
          tool,
        });
      }
    }
    return routeMcpToolsForTask(query, candidates, options.limit);
  }

  async invoke(
    id: string,
    toolName: string,
    input: unknown,
    options: McpInvokeOptions = {},
  ): Promise<unknown | NormalizedExternalMcpToolResult> {
    if (options.signal?.aborted) throw callerCancellationError(options.signal);
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName) throw new Error('MCP tool name is required.');
    await this.start(id);
    let server = this.requireServer(id);
    if (!server.client || server.state !== 'running') {
      throw new Error(`MCP server '${id}' was stopped during startup.`);
    }
    if (!this.hasFreshDiscovery(server)) {
      await this.listTools(id, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      server = this.requireServer(id);
    }
    const discoveredTool = server.tools?.find(({ name }) => name === canonicalToolName);
    const permitted =
      server.kind === 'local_mcp_lite' ||
      (server.exposure.mode === 'allowlist' &&
        server.exposure.toolNames.includes(canonicalToolName));
    if (!discoveredTool || !permitted) {
      throw new Error(`MCP tool '${id}.${canonicalToolName}' is not permitted for JARVIS.`);
    }
    const invocationInput =
      server.kind === 'external_mcp'
        ? validateExternalToolArguments(discoveredTool.inputSchema, input)
        : input;
    const client = server.client;
    if (!client || server.state !== 'running') {
      throw new Error(`MCP server '${id}' was stopped before invocation.`);
    }
    if (options.signal?.aborted) throw callerCancellationError(options.signal);
    const generation = server.generation;
    const argumentAudit =
      server.kind === 'external_mcp' ? redactMcpArgumentsForAudit(invocationInput) : undefined;
    if (argumentAudit && options.onInvocationAudit) {
      const audit = Object.freeze({
        serverId: id,
        toolName: canonicalToolName,
        arguments: argumentAudit,
      });
      notifyObserver(options.onInvocationAudit, audit);
    }
    const timeoutMs = options.timeoutMs ?? this.invocationTimeoutMs;
    const controller = new AbortController();
    let invocationActive = true;
    let progressCount = 0;
    let lastProgress = Number.NEGATIVE_INFINITY;
    const onProgress =
      options.onProgress === undefined
        ? undefined
        : (candidate: McpClientProgressUpdate) => {
            if (!invocationActive || controller.signal.aborted) return;
            if (
              server.generation !== generation ||
              server.client !== client ||
              server.state !== 'running'
            ) {
              return;
            }
            if (progressCount >= MAX_PROGRESS_UPDATES) return;
            const canonical = canonicalProgressUpdate(
              candidate,
              lastProgress,
              server.kind === 'external_mcp' ? 'external_untrusted' : 'app_trusted',
            );
            if (!canonical) return;
            progressCount += 1;
            lastProgress = canonical.progress;
            notifyObserver(options.onProgress, canonical);
          };
    let rejectCallerCancellation: ((error: Error) => void) | undefined;
    const callerCancelled = new Promise<never>((_, reject) => {
      rejectCallerCancellation = reject;
    });
    const abort = () => {
      const error = options.signal
        ? callerCancellationError(options.signal)
        : new DOMException('MCP request cancelled.', 'AbortError');
      controller.abort(error);
      rejectCallerCancellation?.(error);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      this.touch(id, server);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('timeout'));
          reject(new Error(`MCP ${id}.${canonicalToolName} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      });
      const result = await Promise.race([
        client.invoke(canonicalToolName, invocationInput, {
          signal: controller.signal,
          ...(onProgress === undefined ? {} : { onProgress }),
        }),
        timeout,
        callerCancelled,
      ]);
      return server.kind === 'external_mcp' ? normalizeExternalMcpToolResult(result) : result;
    } catch (error) {
      const current = server.generation === generation && server.client === client;
      if (!current || options.signal?.aborted) throw error;
      server.state = 'unhealthy';
      server.error = errorMessage(error);
      this.invalidateDiscovery(server, new Error('MCP invocation failed.'));
      // Retrying after an ambiguous transport failure can duplicate a write
      // that the remote tool already performed. Only an explicitly
      // idempotent/read-only caller may opt into one restart.
      if (options.restartOnFailure !== true || options.signal?.aborted) throw error;
      await this.stop(id);
      await this.start(id);
      return this.invoke(id, canonicalToolName, invocationInput, {
        ...options,
        restartOnFailure: false,
      });
    } finally {
      invocationActive = false;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private requireServer(id: string): ManagedServer {
    const server = this.servers.get(id);
    if (!server) throw new Error(`Unknown MCP server '${id}'.`);
    return server;
  }

  private exposedToolNames(server: ManagedServer): readonly string[] {
    const tools = server.tools;
    if (
      server.kind !== 'external_mcp' ||
      server.state !== 'running' ||
      !tools ||
      !this.hasFreshDiscovery(server) ||
      server.exposure.mode !== 'allowlist'
    ) {
      return Object.freeze([]);
    }
    const allowed = new Set(server.exposure.toolNames);
    return Object.freeze(tools.map(({ name }) => name).filter((name) => allowed.has(name)));
  }

  private invalidateDiscovery(server: ManagedServer, reason: Error): void {
    server.discovery?.controller.abort(reason);
    server.discovery = undefined;
    server.tools = undefined;
    server.toolsDiscoveredAt = undefined;
  }

  private normalizedDiscoveryTimeout(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(120_000, Math.floor(value))
      : this.discoveryTimeoutMs;
  }

  private waitForDiscovery(
    id: string,
    server: ManagedServer,
    session: ManagedDiscovery,
    options: McpListToolsOptions,
  ): Promise<readonly Readonly<CanonicalMcpToolDescriptor>[]> {
    const timeoutMs = this.normalizedDiscoveryTimeout(options.timeoutMs);
    session.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = (cancelled: boolean) => {
        session.waiters = Math.max(0, session.waiters - 1);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (cancelled && session.waiters === 0 && server.discovery === session) {
          session.controller.abort(new NoActiveDiscoveryWaitersError());
        }
      };
      const finish = <T>(callback: (value: T) => void, value: T, cancelled: boolean) => {
        if (settled) return;
        settled = true;
        release(cancelled);
        callback(value);
      };
      const abort = () => {
        const reason = options.signal?.reason;
        const reasonRecord = record(reason);
        finish(
          reject,
          reason instanceof Error
            ? reason
            : new DOMException(
                typeof reasonRecord?.message === 'string'
                  ? reasonRecord.message
                  : 'MCP tool discovery cancelled.',
                'AbortError',
              ),
          true,
        );
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        finish(reject, new Error(`MCP ${id} tool discovery timed out after ${timeoutMs}ms.`), true);
      }, timeoutMs);
      session.promise.then(
        (tools) => finish(resolve, tools, false),
        (error) => finish(reject, error, false),
      );
    });
  }

  private hasFreshDiscovery(server: ManagedServer): boolean {
    if (!server.tools || !Number.isSafeInteger(server.toolsDiscoveredAt)) return false;
    const age = Date.now() - (server.toolsDiscoveredAt as number);
    return age >= 0 && age <= MAX_TOOL_CACHE_AGE_MS;
  }

  private touch(id: string, server: ManagedServer): void {
    server.lastUsedAt = Date.now();
    if (server.idleTimer) clearTimeout(server.idleTimer);
    server.idleTimer = setTimeout(() => {
      void this.stop(id);
    }, this.idleTimeoutMs);
  }
}

/** The in-process MCP tool registry exposed through the same lifecycle contract. */
export const jarvisMcpServerManager = new McpServerManager();
jarvisMcpServerManager.register(
  {
    id: 'vibespace-local',
    start: async () => ({
      listTools: async () =>
        toolRegistry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      invoke: async (name, input) => toolRegistry.invoke(name, input),
      health: async () => true,
      stop: async () => undefined,
    }),
  },
  {
    kind: 'local_mcp_lite',
    domains: ['files', 'local', 'shell', 'vibespace'],
  },
);
jarvisMcpServerManager.register(supabaseMcpAdapter, {
  kind: 'external_mcp',
  domains: ['database', 'supabase'],
});

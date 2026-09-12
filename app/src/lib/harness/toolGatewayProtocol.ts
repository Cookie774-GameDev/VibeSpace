export const TOOL_GATEWAY_CATALOG = [
  'terminal.list',
  'terminal.open',
  'terminal.focus',
  'terminal.spawn',
  'terminal.write',
  'terminal.read',
  'terminal.schedule',
  'command.list',
  'command.run',
  'profile.allAboutMe.read',
  'profile.allAboutMe.update',
  'memory.learning.read',
  'memory.learning.update',
  'context.list',
  'context.read',
  'context.attach',
  'vibespace_context',
  'skills.list',
  'skills.load',
  'plugins.list',
  'plugins.run',
  'tasks.create',
  'tasks.update',
  'schedule.create',
  'app.navigate',
  'app.getState',
] as const;

export type ToolGatewayTool = (typeof TOOL_GATEWAY_CATALOG)[number];

export const MUTATING_TOOL_GATEWAY_TOOLS: ReadonlySet<ToolGatewayTool> = new Set([
  'terminal.open',
  'terminal.focus',
  'terminal.spawn',
  'terminal.write',
  'terminal.schedule',
  'command.run',
  'profile.allAboutMe.update',
  'memory.learning.update',
  'context.attach',
  'skills.load',
  'plugins.run',
  'tasks.create',
  'tasks.update',
  'schedule.create',
  'app.navigate',
]);

export interface ToolGatewayRequest {
  protocolVersion: 1;
  requestId: string;
  sessionId: string;
  messageId: string;
  tool: ToolGatewayTool;
  args: Record<string, unknown>;
  directory?: string;
  worktree?: string;
}

export interface ToolGatewayResponse {
  requestId: string;
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const SAFE_CORPUS_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$/u;
const CANONICAL_LOGICAL_POSITION = /^(?:0|[1-9][0-9]*)$/u;
const MAX_LOGICAL_POSITION = 10_000_000_000_000_000n;
const SECRET_KEY_FRAGMENTS = [
  'secret',
  'token',
  'password',
  'authorization',
  'authentication',
  'authheader',
  'cookie',
  'credential',
  'apikey',
  'api_key',
  'api-key',
  'api.key',
] as const;
const MAX_SEMANTIC_TOKEN_DECIMAL = '10000000000000000';
const SEMANTIC_TOKEN_COUNT_KEYS = new Set(['contextTokens', 'estimatedTokens']);
const SEMANTIC_TOKEN_DECIMAL_KEYS = new Set([
  'totalTokens',
  'indexedTokens',
  'tokenStart',
  'tokenEnd',
]);
const catalog = new Set<string>(TOOL_GATEWAY_CATALOG);

function invalid(message: string): never {
  throw new Error(`Invalid tool gateway request: ${message}`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!plainObject(value)) invalid('arguments must be a plain object.');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key) || key === '__proto__' || key === 'constructor')
  ) {
    invalid('arguments contain missing or unknown fields.');
  }
  return value;
}

function stringField(
  value: unknown,
  name: string,
  max: number,
  options: { id?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) {
    invalid(`${name} is invalid.`);
  }
  if (options.id && !SAFE_ID.test(value)) invalid(`${name} is invalid.`);
  return value;
}

function optionalString(value: unknown, name: string, max: number): void {
  if (value !== undefined) stringField(value, name, max);
}

function integer(value: unknown, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    invalid(`${name} is invalid.`);
  }
}

function optionalInteger(value: unknown, name: string, max: number): void {
  if (value !== undefined) integer(value, name, max);
}

function normalizedSemanticInteger(value: unknown, name: string, max: number): number {
  const normalized =
    typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  integer(normalized, name, max);
  return normalized as number;
}

function normalizeSemanticPlaceholders(value: unknown): unknown {
  if (!plainObject(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    if (
      key === 'pointer' &&
      plainObject(item) &&
      Object.values(item).every((pointerValue) => pointerValue === null)
    ) {
      continue;
    }
    normalized[key] = item;
  }
  return normalized;
}

function selectSemanticFields(
  envelope: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(envelope, field))
      .map((field) => [field, envelope[field]]),
  );
}

function terminal(value: unknown): void {
  if (typeof value === 'number') integer(value, 'terminal', 1_000_000);
  else stringField(value, 'terminal', 200, { id: true });
}

function safeSemanticTokenField(key: string, value: unknown): boolean {
  if (SEMANTIC_TOKEN_COUNT_KEYS.has(key)) {
    return Number.isSafeInteger(value) && (value as number) >= 0;
  }
  if (
    !SEMANTIC_TOKEN_DECIMAL_KEYS.has(key) ||
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    value.length > MAX_SEMANTIC_TOKEN_DECIMAL.length
  ) {
    return false;
  }
  return value.length < MAX_SEMANTIC_TOKEN_DECIMAL.length || value <= MAX_SEMANTIC_TOKEN_DECIMAL;
}

function secretBearingJsonKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase('en-US');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 100 && value.every((item) => safeJson(item, depth + 1));
  if (!plainObject(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length <= 200 &&
      key !== '__proto__' &&
      key !== 'prototype' &&
      key !== 'constructor' &&
      !secretBearingJsonKey(key) &&
      safeJson(item, depth + 1),
  );
}

function safeResponseJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => safeResponseJson(item, depth + 1));
  }
  if (!plainObject(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key.length <= 200 &&
      key !== '__proto__' &&
      key !== 'prototype' &&
      key !== 'constructor' &&
      (secretBearingJsonKey(key)
        ? safeSemanticTokenField(key, item)
        : safeResponseJson(item, depth + 1)),
  );
}

function validateArgs(tool: ToolGatewayTool, input: unknown): Record<string, unknown> {
  let args: Record<string, unknown>;
  switch (tool) {
    case 'terminal.list':
    case 'command.list':
    case 'memory.learning.read':
    case 'skills.list':
    case 'plugins.list':
      args = exactKeys(input, [], ['limit']);
      optionalInteger(args.limit, 'limit', 100);
      return args;
    case 'context.list':
      args = exactKeys(input, [], ['limit', 'cursor']);
      optionalInteger(args.limit, 'limit', 100);
      optionalString(args.cursor, 'cursor', 512);
      return args;
    case 'terminal.open':
    case 'terminal.focus':
      args = exactKeys(input, ['terminal']);
      terminal(args.terminal);
      return args;
    case 'terminal.spawn':
      args = exactKeys(input, [], ['directory', 'name']);
      optionalString(args.directory, 'directory', 4096);
      optionalString(args.name, 'name', 128);
      if (typeof args.directory === 'string' && !absoluteDirectory(args.directory)) {
        invalid('terminal directory is not absolute.');
      }
      return args;
    case 'terminal.write':
      args = exactKeys(input, ['terminal', 'command']);
      terminal(args.terminal);
      stringField(args.command, 'command', 32_768);
      return args;
    case 'terminal.read':
      args = exactKeys(input, ['terminal'], ['maxChars']);
      terminal(args.terminal);
      optionalInteger(args.maxChars, 'maxChars', 50_000);
      return args;
    case 'terminal.schedule':
      args = exactKeys(input, ['terminal', 'command', 'runAt']);
      terminal(args.terminal);
      stringField(args.command, 'command', 32_768);
      stringField(args.runAt, 'runAt', 128);
      return args;
    case 'command.run':
      args = exactKeys(input, ['command'], ['input']);
      stringField(args.command, 'command', 128, { id: true });
      optionalString(args.input, 'input', 32_768);
      return args;
    case 'profile.allAboutMe.read':
    case 'app.getState':
      return exactKeys(input, []);
    case 'profile.allAboutMe.update':
      args = exactKeys(input, ['content']);
      stringField(args.content, 'content', 100_000);
      return args;
    case 'memory.learning.update':
      args = exactKeys(input, ['content', 'source', 'confidence']);
      stringField(args.content, 'content', 10_000);
      stringField(args.source, 'source', 256);
      if (
        typeof args.confidence !== 'number' ||
        !Number.isFinite(args.confidence) ||
        args.confidence < 0 ||
        args.confidence > 1
      ) {
        invalid('confidence is invalid.');
      }
      return args;
    case 'context.read':
    case 'context.attach':
      args = exactKeys(input, ['contextId']);
      stringField(args.contextId, 'contextId', 200, { id: true });
      return args;
    case 'vibespace_context': {
      const semanticInput = normalizeSemanticPlaceholders(input);
      const envelope = exactKeys(
        semanticInput,
        ['operation'],
        [
          'query',
          'limit',
          'continuation',
          'pointer',
          'maxBytes',
          'beforeBytes',
          'afterBytes',
          'recordId',
          'corpusId',
          'position',
          'required',
        ],
      );
      const operation = stringField(envelope.operation, 'operation', 32);
      switch (operation) {
        case 'describe':
        case 'checkpoint':
          return { operation };
        case 'query':
        case 'search':
          args = exactKeys(
            selectSemanticFields(envelope, ['operation', 'query', 'limit', 'continuation']),
            ['operation', 'query'],
            ['limit', 'continuation'],
          );
          stringField(args.query, 'query', 4096);
          if (args.limit !== undefined) {
            args.limit = normalizedSemanticInteger(args.limit, 'limit', 100);
          }
          optionalString(args.continuation, 'continuation', 512);
          return args;
        case 'open':
          args = exactKeys(
            selectSemanticFields(envelope, ['operation', 'pointer', 'maxBytes', 'continuation']),
            ['operation', 'pointer'],
            ['maxBytes', 'continuation'],
          );
          args.pointer = validateContextPointer(args.pointer);
          if (args.maxBytes !== undefined) {
            args.maxBytes = normalizedSemanticInteger(args.maxBytes, 'maxBytes', 131_072);
          }
          optionalString(args.continuation, 'continuation', 512);
          return args;
        case 'expand':
          args = exactKeys(
            selectSemanticFields(envelope, ['operation', 'pointer', 'beforeBytes', 'afterBytes']),
            ['operation', 'pointer'],
            ['beforeBytes', 'afterBytes'],
          );
          args.pointer = validateContextPointer(args.pointer);
          if (args.beforeBytes !== undefined) {
            args.beforeBytes = normalizedSemanticInteger(args.beforeBytes, 'beforeBytes', 131_072);
          }
          if (args.afterBytes !== undefined) {
            args.afterBytes = normalizedSemanticInteger(args.afterBytes, 'afterBytes', 131_072);
          }
          return args;
        case 'address':
          args = exactKeys(selectSemanticFields(envelope, ['operation', 'corpusId', 'position']), [
            'operation',
            'corpusId',
            'position',
          ]);
          stringField(args.corpusId, 'corpusId', 200, { id: true });
          if (
            !SAFE_CORPUS_ID.test(args.corpusId as string) ||
            typeof args.position !== 'string' ||
            !CANONICAL_LOGICAL_POSITION.test(args.position) ||
            BigInt(args.position) > MAX_LOGICAL_POSITION
          ) {
            invalid('position is invalid.');
          }
          return args;
        case 'related':
          args = exactKeys(
            selectSemanticFields(envelope, ['operation', 'recordId', 'limit']),
            ['operation', 'recordId'],
            ['limit'],
          );
          stringField(args.recordId, 'recordId', 512);
          if (args.limit !== undefined) {
            args.limit = normalizedSemanticInteger(args.limit, 'limit', 100);
          }
          return args;
        case 'timeline':
        case 'sources':
          args = exactKeys(
            selectSemanticFields(envelope, ['operation', 'limit']),
            ['operation'],
            ['limit'],
          );
          if (args.limit !== undefined) {
            args.limit = normalizedSemanticInteger(args.limit, 'limit', 100);
          }
          return args;
        case 'investigate':
          args = exactKeys(selectSemanticFields(envelope, ['operation', 'query']), [
            'operation',
            'query',
          ]);
          stringField(args.query, 'query', 4096);
          return args;
        default:
          invalid('context operation is unavailable.');
      }
    }
    case 'skills.load':
      args = exactKeys(input, ['skillId']);
      stringField(args.skillId, 'skillId', 200, { id: true });
      return args;
    case 'plugins.run':
      args = exactKeys(input, ['pluginId', 'operation'], ['input']);
      stringField(args.pluginId, 'pluginId', 200, { id: true });
      stringField(args.operation, 'operation', 128, { id: true });
      if (args.input !== undefined && (!plainObject(args.input) || !safeJson(args.input))) {
        invalid('plugin input is invalid.');
      }
      return args;
    case 'tasks.create':
      args = exactKeys(input, ['title'], ['notes', 'dueAt']);
      stringField(args.title, 'title', 512);
      optionalString(args.notes, 'notes', 10_000);
      optionalString(args.dueAt, 'dueAt', 128);
      return args;
    case 'tasks.update':
      args = exactKeys(input, ['taskId'], ['title', 'status']);
      stringField(args.taskId, 'taskId', 200, { id: true });
      optionalString(args.title, 'title', 512);
      optionalString(args.status, 'status', 64);
      return args;
    case 'schedule.create':
      args = exactKeys(input, ['title', 'schedule', 'action']);
      stringField(args.title, 'title', 512);
      stringField(args.schedule, 'schedule', 512);
      stringField(args.action, 'action', 32_768);
      return args;
    case 'app.navigate':
      args = exactKeys(input, ['route']);
      stringField(args.route, 'route', 256);
      return args;
  }
}

function validateContextPointer(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (value.length < 2 || value.length > 8_192 || value.includes('\0')) {
      invalid('pointer is invalid.');
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      invalid('pointer is invalid.');
    }
  }
  if (plainObject(value)) {
    value = Object.fromEntries(
      Object.entries(value).filter(([, pointerValue]) => pointerValue !== null),
    );
  }
  const pointer = exactKeys(
    value,
    ['id', 'recordId', 'sourceVersion', 'contentHash'],
    ['lineStart', 'lineEnd', 'byteStart', 'byteEnd', 'messageId', 'eventId', 'toolCallId'],
  );
  stringField(pointer.id, 'pointer.id', 512);
  stringField(pointer.recordId, 'pointer.recordId', 512);
  stringField(pointer.sourceVersion, 'pointer.sourceVersion', 512);
  if (typeof pointer.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(pointer.contentHash)) {
    invalid('pointer.contentHash is invalid.');
  }
  const hasBytes = pointer.byteStart !== undefined || pointer.byteEnd !== undefined;
  const hasLines = pointer.lineStart !== undefined || pointer.lineEnd !== undefined;
  if (hasBytes === hasLines) invalid('pointer span is invalid.');
  if (hasBytes) {
    integer(pointer.byteStart, 'pointer.byteStart', Number.MAX_SAFE_INTEGER);
    integer(pointer.byteEnd, 'pointer.byteEnd', Number.MAX_SAFE_INTEGER);
    if ((pointer.byteEnd as number) <= (pointer.byteStart as number)) {
      invalid('pointer byte span is invalid.');
    }
  } else {
    integer(pointer.lineStart, 'pointer.lineStart', Number.MAX_SAFE_INTEGER);
    integer(pointer.lineEnd, 'pointer.lineEnd', Number.MAX_SAFE_INTEGER);
    if (
      (pointer.lineStart as number) < 1 ||
      (pointer.lineEnd as number) <= (pointer.lineStart as number)
    ) {
      invalid('pointer line span is invalid.');
    }
  }
  optionalString(pointer.messageId, 'pointer.messageId', 512);
  optionalString(pointer.eventId, 'pointer.eventId', 512);
  optionalString(pointer.toolCallId, 'pointer.toolCallId', 512);
  return pointer;
}

function absoluteDirectory(value: string): boolean {
  return (
    value.length <= 4096 &&
    !value.includes('\0') &&
    (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value))
  );
}

export function parseToolGatewayRequest(value: unknown): ToolGatewayRequest {
  const envelope = exactKeys(
    value,
    ['protocolVersion', 'requestId', 'sessionId', 'messageId', 'tool', 'args'],
    ['directory', 'worktree'],
  );
  if (envelope.protocolVersion !== 1) invalid('protocol version is unsupported.');
  const requestId = stringField(envelope.requestId, 'requestId', 200, { id: true });
  const sessionId = stringField(envelope.sessionId, 'sessionId', 200, { id: true });
  const messageId = stringField(envelope.messageId, 'messageId', 200, { id: true });
  if (typeof envelope.tool !== 'string' || !catalog.has(envelope.tool)) {
    invalid('semantic tool is unavailable.');
  }
  const directory = optionalAbsoluteDirectory(envelope.directory);
  const worktree = optionalAbsoluteDirectory(envelope.worktree);
  const tool = envelope.tool as ToolGatewayTool;
  return {
    protocolVersion: 1,
    requestId,
    sessionId,
    messageId,
    tool,
    args: validateArgs(tool, envelope.args),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
  };
}

function optionalAbsoluteDirectory(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !absoluteDirectory(value)) {
    invalid('directory scope is invalid.');
  }
  return value;
}

function fallbackResponse(requestId: string): ToolGatewayResponse {
  return {
    requestId: SAFE_ID.test(requestId) ? requestId : 'invalid-request',
    ok: false,
    code: 'response_too_large',
    message: 'The semantic tool result exceeded the safe size limit.',
  };
}

export function boundToolGatewayResponse(response: ToolGatewayResponse): ToolGatewayResponse {
  if (
    !SAFE_ID.test(response.requestId) ||
    typeof response.ok !== 'boolean' ||
    !SAFE_ID.test(response.code) ||
    typeof response.message !== 'string' ||
    response.message.length > 4096 ||
    (response.data !== undefined && !safeResponseJson(response.data))
  ) {
    return fallbackResponse(response.requestId);
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(response)).length > MAX_RESPONSE_BYTES) {
      return fallbackResponse(response.requestId);
    }
  } catch {
    return fallbackResponse(response.requestId);
  }
  return response;
}

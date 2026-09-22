export type TerminalPromptEvidence = Readonly<{
  promptProtocol: 'osc133' | 'none';
  atPrompt: boolean;
  alternateScreen: boolean;
  interactiveProgram: boolean;
  localShell: boolean;
  passwordPrompt: boolean;
  sshSession: boolean;
}>;

export type VibespaceSlashCaptureResult = Readonly<{
  forwardData: string;
  openPalette: boolean;
  heldText: string;
}>;

export type TerminalContextSession = Readonly<{
  version: 1;
  terminalSessionId: string;
  paneId: string | null;
  projectId: string | null;
  activeMapIds: readonly string[];
  pinnedEntityIds: readonly string[];
  activeSkillIds: readonly string[];
  agentSlug: string | null;
  mode: 'persistent' | 'one_turn';
  updatedAt: number;
  contextRevision: number;
}>;

export const TERMINAL_LOCAL_IPC_METHODS = Object.freeze([
  'cao.identity.publish',
  'context.list',
  'context.current',
  'context.use',
  'context.clear',
  'context.search',
  'context.ask',
  'context.open',
  'context.attach',
  'context.refresh',
  'context.sources',
  'context.status',
  'context.create',
  'skills.list',
  'skills.active',
  'skills.use',
  'skills.add',
  'skills.remove',
  'skills.clear',
  'skills.inspect',
  'agent.list',
  'agent.current',
  'agent.use',
  'agent.clear',
  'agent.status',
  'note.new',
  'note.open',
  'note.link',
  'daily.open',
  'daily.add',
  'project.current',
  'project.switch',
  'status',
  'help',
] as const);

export type TerminalLocalIpcMethod = (typeof TERMINAL_LOCAL_IPC_METHODS)[number];

export type TerminalLocalIpcRequest = Readonly<{
  protocolVersion: 1;
  requestId: string;
  nonce: string;
  runIdentity?: string;
  method: TerminalLocalIpcMethod;
  params: Readonly<Record<string, unknown>>;
}>;

export type TerminalCliResponse = Readonly<{
  requestId: string;
  ok: boolean;
  code:
    | 'ok'
    | 'app_not_running'
    | 'authentication_failed'
    | 'invalid_request'
    | 'unsupported_version'
    | 'permission_denied'
    | 'not_found'
    | 'conflict'
    | 'context_unavailable'
    | 'internal_error';
  message: string;
}>;

const SLASH_COMMAND = '/vibespace';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SAFE_NONCE = /^[a-f0-9]{64}$/u;
const MAX_MAPS = 50;
const MAX_PINS = 100;
const MAX_SKILLS = 32;
const MAX_PARAM_DEPTH = 4;
const MAX_PARAM_KEYS = 32;
const MAX_PARAM_ARRAY = 32;
const MAX_PARAM_STRING = 1_024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CLI_RESPONSE_CODES = new Set<TerminalCliResponse['code']>([
  'ok',
  'app_not_running',
  'authentication_failed',
  'invalid_request',
  'unsupported_version',
  'permission_denied',
  'not_found',
  'conflict',
  'context_unavailable',
  'internal_error',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) {
      return null;
    }
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/** Optional pane labels are not authority. Ignore malformed historical labels
 * rather than passing them into the strict context session validator. */
export function normalizeTerminalContextAgentSlug(value: unknown): string | null {
  return safeId(value) ? value : null;
}

function safeOptionalId(value: unknown): value is string | null {
  return value === null || safeId(value);
}

function readIdentifierList(value: unknown, maximum: number): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every((entry) => safeId(entry)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safePromptEvidence(evidence: TerminalPromptEvidence): boolean {
  const record = readClosedRecord(evidence, [
    'promptProtocol',
    'atPrompt',
    'alternateScreen',
    'interactiveProgram',
    'localShell',
    'passwordPrompt',
    'sshSession',
  ]);
  return (
    record?.promptProtocol === 'osc133' &&
    record.atPrompt === true &&
    record.alternateScreen === false &&
    record.interactiveProgram === false &&
    record.localShell === true &&
    record.passwordPrompt === false &&
    record.sshSession === false
  );
}

export function createVibespaceSlashCapture(): Readonly<{
  push(data: string, evidence: TerminalPromptEvidence): VibespaceSlashCaptureResult;
}> {
  let heldText = '';

  const result = (forwardData: string, openPalette = false): VibespaceSlashCaptureResult =>
    Object.freeze({ forwardData, openPalette, heldText });

  return Object.freeze({
    push(data: string, evidence: TerminalPromptEvidence): VibespaceSlashCaptureResult {
      if (typeof data !== 'string' || data.length === 0) {
        throw new Error('Invalid terminal input chunk');
      }

      if (heldText && !safePromptEvidence(evidence)) {
        const forwardData = heldText + data;
        heldText = '';
        return result(forwardData);
      }

      if (!heldText) {
        if (data === '/' && safePromptEvidence(evidence)) {
          heldText = '/';
          return result('');
        }
        return result(data);
      }

      if (data.length !== 1) {
        const forwardData = heldText + data;
        heldText = '';
        return result(forwardData);
      }

      if (data === '\u007f' || data === '\b') {
        heldText = heldText.slice(0, -1);
        return result('');
      }

      if (data === '\r' || data === '\n') {
        if (heldText === SLASH_COMMAND) {
          heldText = '';
          return result('', true);
        }
        const forwardData = heldText + data;
        heldText = '';
        return result(forwardData);
      }

      const candidate = heldText + data;
      if (SLASH_COMMAND.startsWith(candidate)) {
        heldText = candidate;
        return result('');
      }

      const forwardData = candidate;
      heldText = '';
      return result(forwardData);
    },
  });
}

export function createTerminalContextSession(input: unknown): TerminalContextSession {
  const record = readClosedRecord(input, [
    'version',
    'terminalSessionId',
    'paneId',
    'projectId',
    'activeMapIds',
    'pinnedEntityIds',
    'activeSkillIds',
    'agentSlug',
    'mode',
    'updatedAt',
    'contextRevision',
  ]);
  const activeMapIds = readIdentifierList(record?.activeMapIds, MAX_MAPS);
  const pinnedEntityIds = readIdentifierList(record?.pinnedEntityIds, MAX_PINS);
  const activeSkillIds = readIdentifierList(record?.activeSkillIds, MAX_SKILLS);
  if (
    !record ||
    record.version !== 1 ||
    !safeId(record.terminalSessionId) ||
    !safeOptionalId(record.paneId) ||
    !safeOptionalId(record.projectId) ||
    !activeMapIds ||
    !pinnedEntityIds ||
    !activeSkillIds ||
    !safeOptionalId(record.agentSlug) ||
    (record.mode !== 'persistent' && record.mode !== 'one_turn') ||
    !isSafeInteger(record.updatedAt) ||
    !isSafeInteger(record.contextRevision)
  ) {
    throw new Error('Invalid terminal context session');
  }

  return Object.freeze({
    version: 1,
    terminalSessionId: record.terminalSessionId,
    paneId: record.paneId,
    projectId: record.projectId,
    activeMapIds,
    pinnedEntityIds,
    activeSkillIds,
    agentSlug: record.agentSlug,
    mode: record.mode,
    updatedAt: record.updatedAt,
    contextRevision: record.contextRevision,
  });
}

export function consumeOneTurnTerminalContext(
  session: TerminalContextSession,
  updatedAt: number,
): Readonly<{ entityIds: readonly string[]; next: TerminalContextSession }> {
  const validated = createTerminalContextSession(session);
  if (!isSafeInteger(updatedAt) || updatedAt < validated.updatedAt) {
    throw new Error('Invalid terminal context consumption time');
  }
  if (validated.mode !== 'one_turn') {
    return Object.freeze({
      entityIds: Object.freeze([]),
      next: validated,
    });
  }
  return Object.freeze({
    entityIds: Object.freeze([...validated.pinnedEntityIds]),
    next: createTerminalContextSession({
      ...validated,
      pinnedEntityIds: [],
      mode: 'persistent',
      updatedAt,
      contextRevision: validated.contextRevision + 1,
    }),
  });
}

function cloneJsonValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid local IPC params');
    return value;
  }
  if (typeof value === 'string') {
    if (
      value.length > MAX_PARAM_STRING ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ) {
      throw new Error('Invalid local IPC params');
    }
    return value;
  }
  if (depth >= MAX_PARAM_DEPTH) throw new Error('Invalid local IPC params');
  if (Array.isArray(value)) {
    if (value.length > MAX_PARAM_ARRAY) throw new Error('Invalid local IPC params');
    return Object.freeze(value.map((entry) => cloneJsonValue(entry, depth + 1)));
  }
  if (!isPlainRecord(value)) throw new Error('Invalid local IPC params');
  const keys = Object.keys(value);
  if (keys.length > MAX_PARAM_KEYS || keys.some((key) => FORBIDDEN_KEYS.has(key) || !safeId(key))) {
    throw new Error('Invalid local IPC params');
  }
  const clone: Record<string, unknown> = Object.create(null);
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('Invalid local IPC params');
    }
    clone[key] = cloneJsonValue(descriptor.value, depth + 1);
  }
  return Object.freeze(clone);
}

export function parseTerminalLocalIpcRequest(input: unknown): TerminalLocalIpcRequest {
  const record =
    readClosedRecord(input, [
      'protocolVersion',
      'requestId',
      'nonce',
      'runIdentity',
      'method',
      'params',
    ]) ?? readClosedRecord(input, ['protocolVersion', 'requestId', 'nonce', 'method', 'params']);
  if (
    !record ||
    record.protocolVersion !== 1 ||
    !safeId(record.requestId) ||
    typeof record.nonce !== 'string' ||
    !SAFE_NONCE.test(record.nonce) ||
    (record.runIdentity !== undefined && !safeId(record.runIdentity)) ||
    typeof record.method !== 'string' ||
    !TERMINAL_LOCAL_IPC_METHODS.includes(record.method as TerminalLocalIpcMethod)
  ) {
    throw new Error('Invalid terminal local IPC request');
  }
  let params: Readonly<Record<string, unknown>>;
  try {
    const cloned = cloneJsonValue(record.params, 0);
    if (!isPlainRecord(cloned)) throw new Error('Invalid local IPC params');
    params = cloned;
  } catch {
    throw new Error('Invalid terminal local IPC request');
  }
  return Object.freeze({
    protocolVersion: 1,
    requestId: record.requestId,
    nonce: record.nonce,
    ...(typeof record.runIdentity === 'string' ? { runIdentity: record.runIdentity } : {}),
    method: record.method as TerminalLocalIpcMethod,
    params,
  });
}

export function formatTerminalCliResponse(
  input: TerminalCliResponse,
  options: Readonly<{ json: boolean; color: boolean }>,
): string {
  const record = readClosedRecord(input, ['requestId', 'ok', 'code', 'message']);
  const outputOptions = readClosedRecord(options, ['json', 'color']);
  if (
    !record ||
    !safeId(record.requestId) ||
    typeof record.ok !== 'boolean' ||
    typeof record.code !== 'string' ||
    !CLI_RESPONSE_CODES.has(record.code as TerminalCliResponse['code']) ||
    record.ok !== (record.code === 'ok') ||
    typeof record.message !== 'string' ||
    record.message.length < 1 ||
    record.message.length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(record.message) ||
    !outputOptions ||
    typeof outputOptions.json !== 'boolean' ||
    typeof outputOptions.color !== 'boolean'
  ) {
    throw new Error('Invalid terminal CLI response');
  }
  const response: TerminalCliResponse = Object.freeze({
    requestId: record.requestId,
    ok: record.ok,
    code: record.code as TerminalCliResponse['code'],
    message: record.message,
  });
  return outputOptions.json ? JSON.stringify(response) : response.message;
}

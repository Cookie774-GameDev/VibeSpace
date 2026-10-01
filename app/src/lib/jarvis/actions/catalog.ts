import type { ActionDef, ActionParam, ActionRunContext, ActionResult } from '@/lib/actions/types';
import type { ExistingPluginCredentialLocator } from '@/features/plugins/credentialAuthorization';

export type JarvisActionRisk =
  | 'read-only'
  | 'safe-write'
  | 'external-side-effect'
  | 'destructive'
  | 'credential-sensitive';

export type JarvisActionApproval = 'never' | 'first-time' | 'always' | 'depends-on-input';

export type JarvisPlatform = 'windows' | 'macos' | 'linux';

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema & { enum?: string[]; default?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: JsonSchema[];
}

export type JarvisCanonicalActionTarget =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'app_resource'; namespace: string; resourceId: string }>
  | Readonly<{ kind: 'external_resource'; service: string; resourceId: string }>
  | Readonly<{
      kind: 'plugin_tool';
      accountId: string;
      pluginId: string;
      toolName: string;
      resourceId: string;
    }>;

export type JarvisActionCredentialBinding = Readonly<{
  field: string;
  locator: ExistingPluginCredentialLocator;
}>;

export type JarvisRegisteredActionExecutor =
  | Readonly<{ kind: 'builtin'; registryActionId: string }>
  | Readonly<{ kind: 'plugin_tool'; pluginId: string; toolName: string }>;

export interface JarvisRegisteredActionDefinition {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<JsonSchema>;
  readonly outputSchema: Readonly<JsonSchema>;
  readonly requiredCapabilities: readonly [string];
  readonly requiredEntitlements: readonly string[];
  readonly risk: JarvisActionRisk;
  readonly approval: JarvisActionApproval;
  readonly expectedEffect: string;
  readonly exposeToAI: boolean;
  readonly executor: JarvisRegisteredActionExecutor;
  readonly credentialBindings: readonly JarvisActionCredentialBinding[];
  validateParameters(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  deriveTarget(input: {
    accountId: string;
    params: Readonly<Record<string, unknown>>;
  }): JarvisCanonicalActionTarget;
}

export interface JarvisActionCatalog {
  resolve(actionId: string): Readonly<JarvisRegisteredActionDefinition> | undefined;
  listExposed(): readonly Readonly<JarvisRegisteredActionDefinition>[];
}

export interface JarvisActionDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  category: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredCapabilities: string[];
  requiredPermissions: string[];
  supportedPlatforms: JarvisPlatform[];
  risk: JarvisActionRisk;
  approval: JarvisActionApproval;
  supportsProgress: boolean;
  supportsCancellation: boolean;
  supportsRollback: boolean;
  preconditions: string[];
  possibleNextActions: string[];
  exposeToAI: boolean;
  handler: (params: Record<string, unknown>, context: ActionRunContext) => Promise<ActionResult>;
}

const ALL_PLATFORMS: JarvisPlatform[] = ['windows', 'macos', 'linux'];
const SECRET_FIELD_RE =
  /^(?:api[-_ ]?key|password|access[-_ ]?token|refresh[-_ ]?token|token|secret|credentials?|private[-_ ]?key|signing[-_ ]?key)$/i;
const GENERIC_PLUGIN_ACTION_IDS = new Set(['plugin.call', 'plugin.invoke']);
const canonicalPluginExecutors = new WeakSet<object>();

function catalogError(message: string): never {
  throw new TypeError(`Invalid JARVIS action registration: ${message}`);
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) catalogError(`${label} must be nonblank`);
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return catalogError(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return catalogError(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedSet.has(key))
      catalogError(`${label} has unknown fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      catalogError(`${label} has mutable/unknown fields`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function cloneSchema(value: Readonly<JsonSchema>, label: string): JsonSchema {
  const record = plainRecord(value, label);
  assertExactKeys(
    record,
    ['type', 'description', 'properties', 'required', 'additionalProperties', 'oneOf'],
    label,
  );
  if (!['object', 'string', 'number', 'boolean', 'array'].includes(String(record.type))) {
    catalogError(`${label}.type is invalid`);
  }
  const clone: JsonSchema = { type: record.type as JsonSchema['type'] };
  if (record.description !== undefined)
    clone.description = nonblank(record.description, `${label}.description`);
  if (record.additionalProperties !== undefined) {
    if (typeof record.additionalProperties !== 'boolean')
      catalogError(`${label}.additionalProperties is invalid`);
    clone.additionalProperties = record.additionalProperties;
  }
  if (record.required !== undefined) {
    if (
      !Array.isArray(record.required) ||
      record.required.some((item) => typeof item !== 'string')
    ) {
      catalogError(`${label}.required is invalid`);
    }
    clone.required = [...record.required] as string[];
  }
  if (record.oneOf !== undefined) {
    if (!Array.isArray(record.oneOf) || record.oneOf.length < 1 || record.oneOf.length > 8) {
      catalogError(`${label}.oneOf is invalid`);
    }
    clone.oneOf = record.oneOf.map((schema, index) =>
      cloneSchema(schema as JsonSchema, `${label}.oneOf.${index}`),
    );
  }
  if (record.properties !== undefined) {
    const properties = plainRecord(record.properties, `${label}.properties`);
    clone.properties = {};
    for (const [key, property] of Object.entries(properties)) {
      const propertyRecord = plainRecord(property, `${label}.properties.${key}`);
      assertExactKeys(
        propertyRecord,
        [
          'type',
          'description',
          'properties',
          'required',
          'additionalProperties',
          'oneOf',
          'enum',
          'default',
        ],
        `${label}.properties.${key}`,
      );
      const { enum: enumValue, default: defaultValue, ...schemaValue } = propertyRecord;
      const cloned = cloneSchema(
        schemaValue as unknown as JsonSchema,
        `${label}.properties.${key}`,
      ) as JsonSchema & { enum?: string[]; default?: unknown };
      if (enumValue !== undefined) {
        if (!Array.isArray(enumValue) || enumValue.some((item) => typeof item !== 'string')) {
          catalogError(`${label}.properties.${key}.enum is invalid`);
        }
        cloned.enum = [...enumValue] as string[];
      }
      if (defaultValue !== undefined) cloned.default = structuredClone(defaultValue);
      clone.properties[key] = cloned;
    }
  }
  return clone;
}

function schemaHasForbiddenField(
  schema: Readonly<JsonSchema>,
  forbidden: ReadonlySet<string>,
): string | undefined {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (SECRET_FIELD_RE.test(key) || forbidden.has(key)) return key;
    const nested = schemaHasForbiddenField(child, forbidden);
    if (nested) return nested;
  }
  for (const child of schema.oneOf ?? []) {
    const nested = schemaHasForbiddenField(child, forbidden);
    if (nested) return nested;
  }
  return undefined;
}

function cloneExecutor(value: JarvisRegisteredActionExecutor): JarvisRegisteredActionExecutor {
  const record = plainRecord(value, 'executor');
  if (record.kind === 'builtin') {
    assertExactKeys(record, ['kind', 'registryActionId'], 'executor');
    return {
      kind: 'builtin',
      registryActionId: nonblank(record.registryActionId, 'registryActionId'),
    };
  }
  if (record.kind === 'plugin_tool') {
    assertExactKeys(record, ['kind', 'pluginId', 'toolName'], 'executor');
    return {
      kind: 'plugin_tool',
      pluginId: nonblank(record.pluginId, 'pluginId'),
      toolName: nonblank(record.toolName, 'toolName'),
    };
  }
  return catalogError('executor kind is invalid');
}

function validateTarget(
  value: JarvisCanonicalActionTarget,
  executor: JarvisRegisteredActionExecutor,
  expectedAccountId: string,
): JarvisCanonicalActionTarget {
  const record = plainRecord(value, 'target');
  if (record.kind === 'none') assertExactKeys(record, ['kind'], 'target');
  else if (record.kind === 'app_resource') {
    assertExactKeys(record, ['kind', 'namespace', 'resourceId'], 'target');
    nonblank(record.namespace, 'target namespace');
    nonblank(record.resourceId, 'target resourceId');
  } else if (record.kind === 'external_resource') {
    assertExactKeys(record, ['kind', 'service', 'resourceId'], 'target');
    nonblank(record.service, 'target service');
    nonblank(record.resourceId, 'target resourceId');
  } else if (record.kind === 'plugin_tool') {
    assertExactKeys(record, ['kind', 'accountId', 'pluginId', 'toolName', 'resourceId'], 'target');
    nonblank(record.accountId, 'target accountId');
    nonblank(record.pluginId, 'target pluginId');
    nonblank(record.toolName, 'target toolName');
    nonblank(record.resourceId, 'target resourceId');
  } else catalogError('target kind is invalid');

  if (executor.kind === 'plugin_tool') {
    if (
      record.kind !== 'plugin_tool' ||
      record.accountId !== expectedAccountId ||
      record.pluginId !== executor.pluginId ||
      record.toolName !== executor.toolName
    ) {
      catalogError('target does not match plugin executor');
    }
  } else if (record.kind === 'plugin_tool') catalogError('target does not match builtin executor');
  return deepFreeze(structuredClone(value));
}

export function isRegisteredPluginToolExecutor(
  value: unknown,
): value is Extract<JarvisRegisteredActionExecutor, { kind: 'plugin_tool' }> {
  return typeof value === 'object' && value !== null && canonicalPluginExecutors.has(value);
}

export function isJarvisAutoApprovableRegistration(
  registration: Pick<JarvisRegisteredActionDefinition, 'risk' | 'approval'>,
): boolean {
  return registration.risk === 'read-only' && registration.approval === 'never';
}

export function createJarvisActionCatalog(
  registrations: readonly JarvisRegisteredActionDefinition[],
): JarvisActionCatalog {
  if (!Array.isArray(registrations)) catalogError('registrations must be an array');
  const byId = new Map<string, Readonly<JarvisRegisteredActionDefinition>>();
  for (const source of registrations) {
    const sourceRecord = plainRecord(source, 'registration');
    assertExactKeys(
      sourceRecord,
      [
        'id',
        'version',
        'title',
        'description',
        'inputSchema',
        'outputSchema',
        'requiredCapabilities',
        'requiredEntitlements',
        'risk',
        'approval',
        'expectedEffect',
        'exposeToAI',
        'executor',
        'credentialBindings',
        'validateParameters',
        'deriveTarget',
      ],
      'registration',
    );
    const id = nonblank(source.id, 'action id');
    if (!/^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(id)) catalogError('action id is invalid');
    if (GENERIC_PLUGIN_ACTION_IDS.has(id)) catalogError('generic plugin action ids are forbidden');
    if (byId.has(id)) catalogError(`duplicate action id ${id}`);
    if (!Number.isSafeInteger(source.version) || source.version < 1)
      catalogError('version is invalid');
    if (!Array.isArray(source.requiredCapabilities) || source.requiredCapabilities.length !== 1) {
      catalogError('exactly one primary capability is required');
    }
    const requiredCapability = nonblank(source.requiredCapabilities[0], 'capability');
    if (!Array.isArray(source.requiredEntitlements)) catalogError('entitlements must be an array');
    const requiredEntitlements = source.requiredEntitlements.map((entry: string) =>
      nonblank(entry, 'entitlement'),
    );
    if (new Set(requiredEntitlements).size !== requiredEntitlements.length)
      catalogError('duplicate entitlement');
    if (
      ![
        'read-only',
        'safe-write',
        'external-side-effect',
        'destructive',
        'credential-sensitive',
      ].includes(source.risk)
    ) {
      catalogError('risk is invalid');
    }
    if (!['never', 'first-time', 'always', 'depends-on-input'].includes(source.approval)) {
      catalogError('approval is invalid');
    }
    if (typeof source.exposeToAI !== 'boolean') catalogError('exposeToAI must be boolean');
    if (
      typeof source.validateParameters !== 'function' ||
      typeof source.deriveTarget !== 'function'
    ) {
      catalogError('parameter and target functions are required');
    }
    const inputSchema = cloneSchema(source.inputSchema, 'inputSchema');
    const outputSchema = cloneSchema(source.outputSchema, 'outputSchema');
    const executor = deepFreeze(cloneExecutor(source.executor));
    if (!Array.isArray(source.credentialBindings))
      catalogError('credentialBindings must be an array');
    const fields = new Set<string>();
    const locators = new Set<string>();
    const credentialBindings = source.credentialBindings.map(
      (binding: JarvisActionCredentialBinding) => {
        const record = plainRecord(binding, 'credential binding');
        assertExactKeys(record, ['field', 'locator'], 'credential binding');
        const field = nonblank(binding.field, 'credential field');
        const locatorRecord = plainRecord(binding.locator, 'credential locator');
        assertExactKeys(locatorRecord, ['pluginId', 'fieldId'], 'credential locator');
        const locator = {
          pluginId: nonblank(binding.locator.pluginId, 'credential locator pluginId'),
          fieldId: nonblank(binding.locator.fieldId, 'credential locator fieldId'),
        };
        const locatorKey = `${locator.pluginId}\u0000${locator.fieldId}`;
        if (fields.has(field) || locators.has(locatorKey))
          catalogError('duplicate credential binding');
        fields.add(field);
        locators.add(locatorKey);
        if (executor.kind !== 'plugin_tool' || locator.pluginId !== executor.pluginId) {
          catalogError('credential locator does not match plugin executor');
        }
        return deepFreeze({ field, locator: deepFreeze(locator) });
      },
    );
    const forbidden = new Set(['pluginId', ...fields]);
    const permitsFixedMcpToolName =
      id === 'mcp.invoke' &&
      executor.kind === 'builtin' &&
      executor.registryActionId === 'mcp.invoke';
    if (!permitsFixedMcpToolName) {
      forbidden.add('toolName');
    }
    const forbiddenField = schemaHasForbiddenField(inputSchema, forbidden);
    if (forbiddenField) catalogError(`model-visible field ${forbiddenField} is forbidden`);
    if (executor.kind === 'builtin' && credentialBindings.length) {
      catalogError('builtin executors cannot bind plugin credentials');
    }
    const validateParameters = (input: Readonly<Record<string, unknown>>) => {
      const validated = source.validateParameters(input);
      return deepFreeze(structuredClone(plainRecord(validated, 'validated parameters')));
    };
    const deriveTarget = (input: {
      accountId: string;
      params: Readonly<Record<string, unknown>>;
    }) => {
      const accountId = nonblank(input.accountId, 'accountId');
      return validateTarget(
        source.deriveTarget({ accountId, params: input.params }),
        executor,
        accountId,
      );
    };
    for (const key of inputSchema.required ?? []) {
      if (!inputSchema.properties?.[key]) {
        catalogError(`required input ${key} has no schema`);
      }
    }
    if ((inputSchema.required?.length ?? 0) === 0 && !inputSchema.oneOf?.length) {
      deriveTarget({
        accountId: 'catalog-validation-account',
        params: validateParameters({}),
      });
    }
    const canonical = deepFreeze({
      id,
      version: source.version,
      title: nonblank(source.title, 'title'),
      description: nonblank(source.description, 'description'),
      inputSchema: deepFreeze(inputSchema),
      outputSchema: deepFreeze(outputSchema),
      requiredCapabilities: deepFreeze([requiredCapability] as [string]),
      requiredEntitlements: deepFreeze(requiredEntitlements),
      risk: source.risk,
      approval: source.approval,
      expectedEffect: nonblank(source.expectedEffect, 'expectedEffect'),
      exposeToAI: source.exposeToAI,
      executor,
      credentialBindings: deepFreeze(credentialBindings),
      validateParameters,
      deriveTarget,
    } satisfies JarvisRegisteredActionDefinition);
    if (canonical.executor.kind === 'plugin_tool') canonicalPluginExecutors.add(canonical.executor);
    byId.set(id, canonical);
  }
  const exposed = deepFreeze([...byId.values()].filter((entry) => entry.exposeToAI));
  return Object.freeze({
    resolve: (actionId: string) => byId.get(actionId),
    listExposed: () => exposed,
  });
}

const NO_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

const BROWSER_APPROVAL_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'number' },
    reviewId: { type: 'string' },
    origin: { type: 'string' },
    tabId: { type: 'string' },
    frameId: { type: 'string' },
    target: { type: 'object', additionalProperties: true },
    parameters: { type: 'object', additionalProperties: true },
    parametersHash: { type: 'string' },
    reviewedHash: { type: 'string' },
    expectedEffect: { type: 'string' },
    reviewedRisk: { type: 'string', enum: ['safe', 'confirm', 'dangerous'] },
    capability: {
      type: 'object',
      properties: {
        id: { type: 'string', enum: ['browser.operator'] },
        operation: { type: 'string' },
      },
      required: ['id', 'operation'],
      additionalProperties: false,
    },
  },
  required: [
    'schemaVersion',
    'reviewId',
    'origin',
    'tabId',
    'target',
    'parameters',
    'parametersHash',
    'reviewedHash',
    'expectedEffect',
    'reviewedRisk',
    'capability',
  ],
  additionalProperties: false,
};

function validateCanonicalBrowserParameters(
  input: Readonly<Record<string, unknown>>,
  operation: 'browser.readPage' | 'browser.navigate' | 'browser.click' | 'browser.type',
): Record<string, unknown> {
  const record = plainRecord(input, `${operation} parameters`);
  assertExactKeys(
    record,
    [
      'schemaVersion',
      'reviewId',
      'origin',
      'tabId',
      'frameId',
      'target',
      'parameters',
      'parametersHash',
      'reviewedHash',
      'expectedEffect',
      'reviewedRisk',
      'capability',
    ],
    `${operation} parameters`,
  );
  if (
    record.schemaVersion !== 1 ||
    !nonblank(record.reviewId, 'browser reviewId') ||
    !nonblank(record.origin, 'browser origin') ||
    !nonblank(record.tabId, 'browser tabId') ||
    (record.frameId !== null &&
      record.frameId !== undefined &&
      !nonblank(record.frameId, 'browser frameId')) ||
    !nonblank(record.parametersHash, 'browser parametersHash') ||
    !nonblank(record.reviewedHash, 'browser reviewedHash') ||
    !nonblank(record.expectedEffect, 'browser expectedEffect')
  ) {
    catalogError('browser approval binding is invalid');
  }
  const expectedRisk = operation === 'browser.readPage' ? 'safe' : 'confirm';
  if (record.reviewedRisk !== expectedRisk) catalogError('browser reviewed risk is invalid');
  const target = plainRecord(record.target, 'browser target');
  const parameters = plainRecord(record.parameters, 'browser operation parameters');
  const capability = plainRecord(record.capability, 'browser capability');
  assertExactKeys(capability, ['id', 'operation'], 'browser capability');
  if (capability.id !== 'browser.operator' || capability.operation !== operation) {
    catalogError('browser capability binding is invalid');
  }
  const allowedParameterKeys =
    operation === 'browser.readPage'
      ? []
      : operation === 'browser.navigate'
        ? ['url']
        : operation === 'browser.click'
          ? ['x', 'y']
          : ['text'];
  assertExactKeys(parameters, allowedParameterKeys, 'browser operation parameters');
  if (operation === 'browser.navigate') nonblank(parameters.url, 'browser URL');
  if (operation === 'browser.click') {
    if (
      typeof parameters.x !== 'number' ||
      !Number.isFinite(parameters.x) ||
      typeof parameters.y !== 'number' ||
      !Number.isFinite(parameters.y)
    ) {
      catalogError('browser coordinates are invalid');
    }
  }
  if (operation === 'browser.type') nonblank(parameters.text, 'browser text');
  return structuredClone({ ...record, target, parameters, capability });
}

function browserRegistration(
  operation: 'browser.readPage' | 'browser.navigate' | 'browser.click' | 'browser.type',
): JarvisRegisteredActionDefinition {
  const readOnly = operation === 'browser.readPage';
  return {
    id: operation,
    version: 1,
    title: readOnly ? 'Read browser page' : `Browser ${operation.slice('browser.'.length)}`,
    description: readOnly
      ? 'Read a bounded observation from the active scoped Vibe Browser tab.'
      : `Perform one reviewed ${operation.slice('browser.'.length)} operation in the active scoped Vibe Browser tab.`,
    inputSchema: BROWSER_APPROVAL_INPUT_SCHEMA,
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['browser.operator'],
    requiredEntitlements: [],
    risk: readOnly ? 'read-only' : 'external-side-effect',
    approval: readOnly ? 'never' : 'always',
    expectedEffect: readOnly
      ? 'Reads one bounded untrusted page observation without changing browser state.'
      : 'Performs exactly one reviewed browser operation and records a post-action observation.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: operation },
    credentialBindings: [],
    validateParameters: (input) => validateCanonicalBrowserParameters(input, operation),
    deriveTarget: ({ params }) => ({
      kind: 'external_resource',
      service: 'vibe-browser',
      resourceId: `${String(params.origin)}|${String(params.tabId)}`,
    }),
  };
}

const GITHUB_OWNER = /^(?=.{1,39}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const GMAIL_RESOURCE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const GMAIL_DRAFT_FINGERPRINT = /^[0-9a-f]{64}$/;
const GMAIL_EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const GMAIL_QUERY_MAX = 500;
const GMAIL_SUBJECT_MAX = 200;
const GMAIL_BODY_MAX = 50_000;
const GMAIL_RECIPIENT_MAX = 20;
const GOOGLE_DRIVE_FILE_ID = /^[A-Za-z0-9_-]{3,256}$/;
const GOOGLE_DRIVE_SEARCH_TERM_MAX = 256;
const GOOGLE_DRIVE_TITLE_MAX = 150;
const GOOGLE_DRIVE_CONTENT_MAX = 50_000;
const CANVA_DESIGN_ID = /^[A-Za-z0-9._~-]{3,512}$/;
const CANVA_QUERY_MAX = 255;
const CANVA_TITLE_MAX = 255;
const CANVA_PRESETS = new Set(['doc', 'email', 'presentation', 'whiteboard']);
const CANVA_AUTOFILL_JSON_MAX = 50_000;
const CANVA_AUTOFILL_FIELD_MAX = 50;
const CANVA_AUTOFILL_TEXT_MAX = 10_000;
const ZAPIER_ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ZAPIER_SCHEMA_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const ZAPIER_QUERY_MAX = 240;
const ZAPIER_DISCOVERY_MAX = 50;
const ZAPIER_INPUT_JSON_MAX = 64 * 1_024;
const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_MCP_INPUT_JSON_CHARS = 256 * 1024;

function validateNoParameters(
  input: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, label);
  assertExactKeys(record, [], label);
  return {};
}

function githubOwner(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!GITHUB_OWNER.test(normalized)) catalogError('GitHub owner is invalid');
  return normalized;
}

function githubRepository(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!GITHUB_REPOSITORY.test(normalized) || normalized === '.' || normalized === '..') {
    catalogError('GitHub repository is invalid');
  }
  return normalized;
}

function validateGithubRepositoryParameters(
  input: Readonly<Record<string, unknown>>,
  label = 'github.repository.read parameters',
): Readonly<{ owner: string; repository: string }> {
  const record = plainRecord(input, label);
  assertExactKeys(record, ['owner', 'repository'], label);
  return {
    owner: githubOwner(record.owner),
    repository: githubRepository(record.repository),
  };
}

function validateGithubNumberedParameters(
  input: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<{ owner: string; repository: string; number: number }> {
  const record = plainRecord(input, label);
  assertExactKeys(record, ['owner', 'repository', 'number'], label);
  if (!Number.isSafeInteger(record.number) || (record.number as number) <= 0) {
    catalogError(`${label} number is invalid`);
  }
  return {
    owner: githubOwner(record.owner),
    repository: githubRepository(record.repository),
    number: record.number as number,
  };
}

function gmailResourceId(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!GMAIL_RESOURCE_ID.test(normalized)) catalogError(`${label} is invalid`);
  return normalized;
}

function gmailQuery(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized ||
    Array.from(normalized).length > GMAIL_QUERY_MAX ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    catalogError('Gmail query is invalid');
  }
  return normalized;
}

function gmailMaxResults(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    catalogError('Gmail maxResults is invalid');
  }
  return value as number;
}

function gmailRecipients(value: unknown): string {
  if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) {
    catalogError('Gmail recipient list is invalid');
  }
  const recipients = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    recipients.length === 0 ||
    recipients.length > GMAIL_RECIPIENT_MAX ||
    recipients.some(
      (recipient) =>
        Array.from(recipient).length > 254 ||
        !GMAIL_EMAIL.test(recipient) ||
        recipient !== recipient.normalize('NFC'),
    )
  ) {
    catalogError('Gmail recipient list is invalid');
  }
  return recipients.join(', ');
}

function gmailSubject(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (
    !normalized ||
    Array.from(normalized).length > GMAIL_SUBJECT_MAX ||
    /[\r\n\u0000-\u001f\u007f]/.test(normalized)
  ) {
    catalogError('Gmail subject is invalid');
  }
  return normalized;
}

function gmailBody(value: unknown): string {
  if (typeof value !== 'string') catalogError('Gmail body is invalid');
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (
    !normalized.trim() ||
    Array.from(normalized).length > GMAIL_BODY_MAX ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    catalogError('Gmail body is invalid');
  }
  return normalized;
}

function validateGmailSearchParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ query: string; maxResults: number }> {
  const record = plainRecord(input, 'gmail.messages.search parameters');
  assertExactKeys(record, ['query', 'maxResults'], 'gmail.messages.search parameters');
  return {
    query: gmailQuery(record.query),
    maxResults: gmailMaxResults(record.maxResults),
  };
}

function validateGmailResourceParameters(
  input: Readonly<Record<string, unknown>>,
  field: 'messageId' | 'threadId' | 'draftId',
  label: string,
): Readonly<Record<string, string>> {
  const record = plainRecord(input, label);
  assertExactKeys(record, [field], label);
  return { [field]: gmailResourceId(record[field], `Gmail ${field}`) };
}

function validateGmailDraftParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const record = plainRecord(input, 'gmail.draft.create parameters');
  assertExactKeys(record, ['to', 'cc', 'bcc', 'subject', 'body'], 'gmail.draft.create parameters');
  const result: Record<string, string> = {
    to: gmailRecipients(record.to),
    subject: gmailSubject(record.subject),
    body: gmailBody(record.body),
  };
  if (record.cc !== undefined) result.cc = gmailRecipients(record.cc);
  if (record.bcc !== undefined) result.bcc = gmailRecipients(record.bcc);
  return result;
}

function validateGmailReplyDraftParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ messageId: string; body: string }> {
  const record = plainRecord(input, 'gmail.reply_draft.create parameters');
  assertExactKeys(record, ['messageId', 'body'], 'gmail.reply_draft.create parameters');
  return {
    messageId: gmailResourceId(record.messageId, 'Gmail messageId'),
    body: gmailBody(record.body),
  };
}

function validateGmailDraftSendParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ draftId: string; draftFingerprint: string }> {
  const record = plainRecord(input, 'gmail.draft.send parameters');
  assertExactKeys(record, ['draftId', 'draftFingerprint'], 'gmail.draft.send parameters');
  if (
    typeof record.draftFingerprint !== 'string' ||
    !GMAIL_DRAFT_FINGERPRINT.test(record.draftFingerprint)
  ) {
    catalogError('Gmail draft fingerprint is invalid');
  }
  return {
    draftId: gmailResourceId(record.draftId, 'Gmail draftId'),
    draftFingerprint: record.draftFingerprint,
  };
}

const GMAIL_CREDENTIAL_BINDINGS: readonly JarvisActionCredentialBinding[] = [
  {
    field: 'gmailClientIdGrant',
    locator: { pluginId: 'gmail', fieldId: 'client_id' },
  },
  {
    field: 'gmailRefreshGrant',
    locator: { pluginId: 'gmail', fieldId: 'refresh_token' },
  },
];

function gmailAction(input: {
  id: string;
  title: string;
  description: string;
  toolName: string;
  capability: string;
  inputSchema: JsonSchema;
  write: boolean;
  expectedEffect: string;
  validateParameters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  resourceId(params: Readonly<Record<string, unknown>>): string;
}): JarvisRegisteredActionDefinition {
  return {
    id: input.id,
    version: 1,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: [input.capability],
    requiredEntitlements: [],
    risk: input.write ? 'external-side-effect' : 'read-only',
    approval: input.write ? 'always' : 'never',
    expectedEffect: input.expectedEffect,
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'gmail', toolName: input.toolName },
    credentialBindings: GMAIL_CREDENTIAL_BINDINGS,
    validateParameters: input.validateParameters,
    deriveTarget: ({ accountId, params }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'gmail',
      toolName: input.toolName,
      resourceId: input.resourceId(input.validateParameters(params)),
    }),
  };
}

const GMAIL_ACTION_REGISTRATIONS: readonly JarvisRegisteredActionDefinition[] = [
  gmailAction({
    id: 'gmail.messages.search',
    title: 'Search Gmail messages',
    description: 'Search bounded Gmail metadata using one exact Gmail query.',
    toolName: 'message_search',
    capability: 'plugin.gmail.message_search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect:
      'Reads bounded message metadata and thread counts from Gmail without retrieving bodies.',
    validateParameters: validateGmailSearchParameters,
    resourceId: () => 'search',
  }),
  gmailAction({
    id: 'gmail.message.read',
    title: 'Read Gmail message',
    description: 'Read one exact Gmail message as bounded external untrusted context.',
    toolName: 'message_read',
    capability: 'plugin.gmail.message_read',
    inputSchema: {
      type: 'object',
      properties: { messageId: { type: 'string' } },
      required: ['messageId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect:
      'Reads one selected Gmail message without downloading attachments or loading remote content.',
    validateParameters: (value) =>
      validateGmailResourceParameters(value, 'messageId', 'gmail.message.read parameters'),
    resourceId: (params) => String(params.messageId),
  }),
  gmailAction({
    id: 'gmail.thread.read',
    title: 'Read Gmail thread',
    description: 'Read one exact Gmail thread as bounded external untrusted context.',
    toolName: 'thread_read',
    capability: 'plugin.gmail.thread_read',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect:
      'Reads one bounded Gmail thread without downloading attachments or loading remote content.',
    validateParameters: (value) =>
      validateGmailResourceParameters(value, 'threadId', 'gmail.thread.read parameters'),
    resourceId: (params) => String(params.threadId),
  }),
  gmailAction({
    id: 'gmail.draft.create',
    title: 'Create Gmail draft',
    description: 'Create one plain-text Gmail draft after explicit approval.',
    toolName: 'draft_create',
    capability: 'plugin.gmail.draft_create',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect: 'Creates one reviewable Gmail draft without sending it.',
    validateParameters: validateGmailDraftParameters,
    resourceId: () => 'new-draft',
  }),
  gmailAction({
    id: 'gmail.reply_draft.create',
    title: 'Create Gmail reply draft',
    description: 'Create one plain-text reply draft for an exact Gmail message after approval.',
    toolName: 'reply_draft_create',
    capability: 'plugin.gmail.reply_draft_create',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['messageId', 'body'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect:
      'Reads reply headers from one selected message and creates a reviewable draft in its thread.',
    validateParameters: validateGmailReplyDraftParameters,
    resourceId: (params) => String(params.messageId),
  }),
  gmailAction({
    id: 'gmail.draft.send',
    title: 'Send Gmail draft',
    description: 'Send one exact existing Gmail draft after explicit approval.',
    toolName: 'draft_send',
    capability: 'plugin.gmail.draft_send',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string' },
        draftFingerprint: {
          type: 'string',
          description: 'Exact SHA-256 fingerprint returned by the approved draft creation result.',
        },
      },
      required: ['draftId', 'draftFingerprint'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect:
      'Revalidates and sends one unchanged approved Gmail draft; Gmail atomically removes the sent draft.',
    validateParameters: validateGmailDraftSendParameters,
    resourceId: (params) => `${params.draftId}@${params.draftFingerprint}`,
  }),
];

function googleDriveFileId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!GOOGLE_DRIVE_FILE_ID.test(normalized)) catalogError('Google Drive fileId is invalid');
  return normalized;
}

function googleDriveSearchParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ term: string; maxResults: number }> {
  const record = plainRecord(input, 'google-drive.files.search parameters');
  assertExactKeys(record, ['term', 'maxResults'], 'google-drive.files.search parameters');
  const term = typeof record.term === 'string' ? record.term.trim().normalize('NFC') : '';
  if (
    !term ||
    Array.from(term).length > GOOGLE_DRIVE_SEARCH_TERM_MAX ||
    /[\u0000-\u001f\u007f]/.test(term)
  ) {
    catalogError('Google Drive search term is invalid');
  }
  const maxResults = record.maxResults === undefined ? 10 : record.maxResults;
  if (
    !Number.isSafeInteger(maxResults) ||
    (maxResults as number) < 1 ||
    (maxResults as number) > 20
  ) {
    catalogError('Google Drive maxResults is invalid');
  }
  return { term, maxResults: maxResults as number };
}

function googleDriveReadParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ fileId: string }> {
  const record = plainRecord(input, 'google-drive.document.read parameters');
  assertExactKeys(record, ['fileId'], 'google-drive.document.read parameters');
  return { fileId: googleDriveFileId(record.fileId) };
}

function googleDriveCreateParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ title: string; content: string }> {
  const record = plainRecord(input, 'google-drive.document.create parameters');
  assertExactKeys(record, ['title', 'content'], 'google-drive.document.create parameters');
  const title = typeof record.title === 'string' ? record.title.trim().normalize('NFC') : '';
  if (
    !title ||
    Array.from(title).length > GOOGLE_DRIVE_TITLE_MAX ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    catalogError('Google Drive title is invalid');
  }
  if (typeof record.content !== 'string') catalogError('Google Drive content is invalid');
  const content = record.content.normalize('NFC').replace(/\r\n?/g, '\n');
  if (
    !content.trim() ||
    Array.from(content).length > GOOGLE_DRIVE_CONTENT_MAX ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
  ) {
    catalogError('Google Drive content is invalid');
  }
  return { title, content };
}

const GOOGLE_DRIVE_CREDENTIAL_BINDINGS: readonly JarvisActionCredentialBinding[] = [
  {
    field: 'googleDriveClientIdGrant',
    locator: { pluginId: 'google-drive', fieldId: 'client_id' },
  },
  {
    field: 'googleDriveRefreshGrant',
    locator: { pluginId: 'google-drive', fieldId: 'refresh_token' },
  },
];

function googleDriveAction(input: {
  id: string;
  title: string;
  description: string;
  toolName: string;
  capability: string;
  inputSchema: JsonSchema;
  write: boolean;
  expectedEffect: string;
  validateParameters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  resourceId(params: Readonly<Record<string, unknown>>): string;
}): JarvisRegisteredActionDefinition {
  return {
    id: input.id,
    version: 1,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: [input.capability],
    requiredEntitlements: [],
    risk: input.write ? 'external-side-effect' : 'read-only',
    approval: input.write ? 'always' : 'never',
    expectedEffect: input.expectedEffect,
    exposeToAI: true,
    executor: {
      kind: 'plugin_tool',
      pluginId: 'google-drive',
      toolName: input.toolName,
    },
    credentialBindings: GOOGLE_DRIVE_CREDENTIAL_BINDINGS,
    validateParameters: input.validateParameters,
    deriveTarget: ({ accountId, params }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'google-drive',
      toolName: input.toolName,
      resourceId: input.resourceId(input.validateParameters(params)),
    }),
  };
}

const GOOGLE_DRIVE_ACTION_REGISTRATIONS: readonly JarvisRegisteredActionDefinition[] = [
  googleDriveAction({
    id: 'google-drive.files.search',
    title: 'Search Google Drive files',
    description:
      'Search bounded Google Drive metadata using one locally escaped name/content term.',
    toolName: 'files_search',
    capability: 'plugin.google-drive.files_search',
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string' },
        maxResults: { type: 'number', default: 10 },
      },
      required: ['term'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect: 'Reads bounded Google Drive file metadata without retrieving file contents.',
    validateParameters: googleDriveSearchParameters,
    resourceId: () => 'search',
  }),
  googleDriveAction({
    id: 'google-drive.document.read',
    title: 'Read Google Drive document',
    description:
      'Read one exact selected supported Google Drive document as bounded external untrusted context.',
    toolName: 'document_read',
    capability: 'plugin.google-drive.document_read',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string' } },
      required: ['fileId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect:
      'Reads one exact selected Google Doc or supported text file after verifying download permission.',
    validateParameters: googleDriveReadParameters,
    resourceId: (params) => String(params.fileId),
  }),
  googleDriveAction({
    id: 'google-drive.document.create',
    title: 'Create Google Drive document',
    description: 'Create one bounded Google document after explicit approval.',
    toolName: 'document_create',
    capability: 'plugin.google-drive.document_create',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect: 'Creates one Google document from the exact approved title and text content.',
    validateParameters: googleDriveCreateParameters,
    resourceId: () => 'new-document',
  }),
];

function canvaSearchParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ query: string; maxResults: number }> {
  const record = plainRecord(input, 'Canva search parameters');
  assertExactKeys(record, ['query', 'maxResults'], 'Canva search parameters');
  const query = typeof record.query === 'string' ? record.query.normalize('NFC').trim() : '';
  if (!query || Array.from(query).length > CANVA_QUERY_MAX || /[\u0000-\u001f\u007f]/.test(query)) {
    catalogError('Canva query is invalid');
  }
  const maxResults = record.maxResults ?? 10;
  if (
    !Number.isSafeInteger(maxResults) ||
    (maxResults as number) < 1 ||
    (maxResults as number) > 20
  ) {
    catalogError('Canva maxResults is invalid');
  }
  return { query, maxResults: maxResults as number };
}

function canvaReadParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ designId: string }> {
  const record = plainRecord(input, 'canva.design.read parameters');
  assertExactKeys(record, ['designId'], 'canva.design.read parameters');
  const designId = typeof record.designId === 'string' ? record.designId.trim() : '';
  if (!CANVA_DESIGN_ID.test(designId)) catalogError('Canva designId is invalid');
  return { designId };
}

function canvaCreateParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ title: string; preset: string }> {
  const record = plainRecord(input, 'canva.design.create parameters');
  assertExactKeys(record, ['title', 'preset'], 'canva.design.create parameters');
  const title = typeof record.title === 'string' ? record.title.normalize('NFC').trim() : '';
  if (!title || Array.from(title).length > CANVA_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) {
    catalogError('Canva title is invalid');
  }
  if (typeof record.preset !== 'string' || !CANVA_PRESETS.has(record.preset)) {
    catalogError('Canva preset is invalid');
  }
  return { title, preset: record.preset };
}

function canvaBrandTemplateParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ brandTemplateId: string }> {
  const record = plainRecord(input, 'canva.brand_template.dataset.read parameters');
  assertExactKeys(record, ['brandTemplateId'], 'canva.brand_template.dataset.read parameters');
  const brandTemplateId =
    typeof record.brandTemplateId === 'string' ? record.brandTemplateId.trim() : '';
  if (!CANVA_DESIGN_ID.test(brandTemplateId)) {
    catalogError('Canva brandTemplateId is invalid');
  }
  return { brandTemplateId };
}

function canvaAutofillJobParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ jobId: string }> {
  const record = plainRecord(input, 'canva.autofill_job.read parameters');
  assertExactKeys(record, ['jobId'], 'canva.autofill_job.read parameters');
  const jobId = typeof record.jobId === 'string' ? record.jobId.trim() : '';
  if (!CANVA_DESIGN_ID.test(jobId)) catalogError('Canva jobId is invalid');
  return { jobId };
}

function canvaAutofillParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ brandTemplateId: string; title: string; textDataJson: string }> {
  const record = plainRecord(input, 'canva.design.autofill parameters');
  assertExactKeys(
    record,
    ['brandTemplateId', 'title', 'textDataJson'],
    'canva.design.autofill parameters',
  );
  const brandTemplateId =
    typeof record.brandTemplateId === 'string' ? record.brandTemplateId.trim() : '';
  if (!CANVA_DESIGN_ID.test(brandTemplateId)) {
    catalogError('Canva autofill brandTemplateId is invalid');
  }
  const title = typeof record.title === 'string' ? record.title.normalize('NFC').trim() : '';
  if (!title || Array.from(title).length > CANVA_TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) {
    catalogError('Canva autofill title is invalid');
  }
  if (
    typeof record.textDataJson !== 'string' ||
    !record.textDataJson ||
    record.textDataJson.length > CANVA_AUTOFILL_JSON_MAX
  ) {
    catalogError('Canva autofill data is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.textDataJson);
  } catch {
    catalogError('Canva autofill data is invalid');
  }
  const data = plainRecord(parsed, 'Canva autofill data');
  const entries = Object.entries(data);
  if (entries.length < 1 || entries.length > CANVA_AUTOFILL_FIELD_MAX) {
    catalogError('Canva autofill data is invalid');
  }
  const canonicalEntries = entries.map(([rawName, rawText]) => {
    const name = rawName.normalize('NFC');
    if (
      !name ||
      name !== rawName ||
      Array.from(name).length > 255 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      SECRET_FIELD_RE.test(name)
    ) {
      catalogError('Canva autofill field is invalid');
    }
    if (typeof rawText !== 'string') catalogError('Canva autofill text is invalid');
    const text = rawText.normalize('NFC').replace(/\r\n?/g, '\n');
    if (
      Array.from(text).length > CANVA_AUTOFILL_TEXT_MAX ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    ) {
      catalogError('Canva autofill text is invalid');
    }
    return [name, text] as const;
  });
  canonicalEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    brandTemplateId,
    title,
    textDataJson: JSON.stringify(Object.fromEntries(canonicalEntries)),
  };
}

const CANVA_CREDENTIAL_BINDINGS: readonly JarvisActionCredentialBinding[] = [
  {
    field: 'canvaClientIdGrant',
    locator: { pluginId: 'canva', fieldId: 'client_id' },
  },
  {
    field: 'canvaClientSecretGrant',
    locator: { pluginId: 'canva', fieldId: 'client_secret' },
  },
  {
    field: 'canvaRefreshGrant',
    locator: { pluginId: 'canva', fieldId: 'refresh_token' },
  },
];

function canvaAction(input: {
  id: string;
  title: string;
  description: string;
  toolName: string;
  capability: string;
  inputSchema: JsonSchema;
  write: boolean;
  expectedEffect: string;
  validateParameters(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  resourceId(params: Readonly<Record<string, unknown>>): string;
}): JarvisRegisteredActionDefinition {
  return {
    id: input.id,
    version: 1,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: [input.capability],
    requiredEntitlements: [],
    risk: input.write ? 'external-side-effect' : 'read-only',
    approval: input.write ? 'always' : 'never',
    expectedEffect: input.expectedEffect,
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'canva', toolName: input.toolName },
    credentialBindings: CANVA_CREDENTIAL_BINDINGS,
    validateParameters: input.validateParameters,
    deriveTarget: ({ accountId, params }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'canva',
      toolName: input.toolName,
      resourceId: input.resourceId(input.validateParameters(params)),
    }),
  };
}

const CANVA_SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    maxResults: { type: 'number', default: 10 },
  },
  required: ['query'],
  additionalProperties: false,
};

const CANVA_ACTION_REGISTRATIONS: readonly JarvisRegisteredActionDefinition[] = [
  canvaAction({
    id: 'canva.designs.search',
    title: 'Search Canva designs',
    description: 'Search bounded metadata for Canva designs using one fixed text query.',
    toolName: 'designs_search',
    capability: 'plugin.canva.designs_search',
    inputSchema: CANVA_SEARCH_SCHEMA,
    write: false,
    expectedEffect: 'Reads bounded Canva design metadata and validated temporary links.',
    validateParameters: canvaSearchParameters,
    resourceId: () => 'search',
  }),
  canvaAction({
    id: 'canva.design.read',
    title: 'Read Canva design',
    description: 'Read one exact Canva design and its validated temporary edit and view links.',
    toolName: 'design_read',
    capability: 'plugin.canva.design_read',
    inputSchema: {
      type: 'object',
      properties: { designId: { type: 'string' } },
      required: ['designId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect: 'Reads one exact Canva design without modifying it.',
    validateParameters: canvaReadParameters,
    resourceId: (params) => String(params.designId),
  }),
  canvaAction({
    id: 'canva.brand_templates.search',
    title: 'Search Canva brand templates',
    description: 'Search bounded metadata for Canva brand templates when the account permits it.',
    toolName: 'brand_templates_search',
    capability: 'plugin.canva.brand_templates_search',
    inputSchema: CANVA_SEARCH_SCHEMA,
    write: false,
    expectedEffect: 'Reads bounded Canva brand-template metadata without creating a design.',
    validateParameters: canvaSearchParameters,
    resourceId: () => 'search',
  }),
  canvaAction({
    id: 'canva.brand_template.dataset.read',
    title: 'Read Canva brand template dataset',
    description:
      'Read one exact Canva brand-template dataset and identify stable text fields available for Autofill.',
    toolName: 'brand_template_dataset_read',
    capability: 'plugin.canva.brand_template_dataset_read',
    inputSchema: {
      type: 'object',
      properties: { brandTemplateId: { type: 'string' } },
      required: ['brandTemplateId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect: 'Reads bounded field names and types for one exact Canva brand template.',
    validateParameters: canvaBrandTemplateParameters,
    resourceId: (params) => String(params.brandTemplateId),
  }),
  canvaAction({
    id: 'canva.autofill_job.read',
    title: 'Read Canva Autofill job',
    description: 'Read one exact Canva structured-design job and its result when complete.',
    toolName: 'autofill_job_read',
    capability: 'plugin.canva.autofill_job_read',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    write: false,
    expectedEffect: 'Reads one exact Canva Autofill job without creating another design.',
    validateParameters: canvaAutofillJobParameters,
    resourceId: (params) => String(params.jobId),
  }),
  canvaAction({
    id: 'canva.design.create',
    title: 'Create Canva design',
    description: 'Create one stable preset Canva design after explicit approval.',
    toolName: 'design_create',
    capability: 'plugin.canva.design_create',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        preset: {
          type: 'string',
          enum: ['doc', 'email', 'presentation', 'whiteboard'],
        },
      },
      required: ['title', 'preset'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect: 'Creates one Canva design with the exact approved title and stable preset.',
    validateParameters: canvaCreateParameters,
    resourceId: () => 'new-design',
  }),
  canvaAction({
    id: 'canva.design.autofill',
    title: 'Create structured Canva design',
    description:
      'Create one structured text design from an eligible Canva brand template after explicit approval.',
    toolName: 'design_autofill',
    capability: 'plugin.canva.design_autofill',
    inputSchema: {
      type: 'object',
      properties: {
        brandTemplateId: { type: 'string' },
        title: { type: 'string' },
        textDataJson: {
          type: 'string',
          description:
            'A bounded JSON object mapping exact dataset text-field names to text values.',
        },
      },
      required: ['brandTemplateId', 'title', 'textDataJson'],
      additionalProperties: false,
    },
    write: true,
    expectedEffect:
      'Starts one Canva design Autofill job using the exact approved brand template, title, and text field values.',
    validateParameters: canvaAutofillParameters,
    resourceId: (params) => String(params.brandTemplateId),
  }),
];

function zapierIdentityText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    catalogError(`${label} is invalid`);
  }
  return value;
}

function zapierDiscoverParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ query?: string; maxResults?: number }> {
  const record = plainRecord(input, 'zapier.actions.discover parameters');
  assertExactKeys(record, ['query', 'maxResults'], 'zapier.actions.discover parameters');
  const validated: { query?: string; maxResults?: number } = {};
  if (record.query !== undefined) {
    if (
      typeof record.query !== 'string' ||
      record.query.length > ZAPIER_QUERY_MAX ||
      /[\u0000-\u001f\u007f]/.test(record.query)
    ) {
      catalogError('Zapier discovery query is invalid');
    }
    const query = record.query.normalize('NFC').trim();
    if (query) validated.query = query;
  }
  if (record.maxResults !== undefined) {
    if (
      !Number.isSafeInteger(record.maxResults) ||
      (record.maxResults as number) < 1 ||
      (record.maxResults as number) > ZAPIER_DISCOVERY_MAX
    ) {
      catalogError('Zapier discovery maxResults is invalid');
    }
    validated.maxResults = record.maxResults as number;
  }
  return validated;
}

function zapierInvokeParameters(input: Readonly<Record<string, unknown>>): Readonly<{
  actionId: string;
  actionTitle: string;
  downstreamApp: string;
  schemaFingerprint: string;
  inputJson: string;
}> {
  const record = plainRecord(input, 'zapier.action.invoke parameters');
  assertExactKeys(
    record,
    ['actionId', 'actionTitle', 'downstreamApp', 'schemaFingerprint', 'inputJson'],
    'zapier.action.invoke parameters',
  );
  const actionId = zapierIdentityText(record.actionId, 128, 'Zapier actionId');
  if (!ZAPIER_ACTION_ID.test(actionId)) catalogError('Zapier actionId is invalid');
  const actionTitle = zapierIdentityText(record.actionTitle, 160, 'Zapier actionTitle');
  const downstreamApp = zapierIdentityText(record.downstreamApp, 80, 'Zapier downstreamApp');
  const schemaFingerprint = zapierIdentityText(
    record.schemaFingerprint,
    71,
    'Zapier schemaFingerprint',
  );
  if (!ZAPIER_SCHEMA_FINGERPRINT.test(schemaFingerprint)) {
    catalogError('Zapier schemaFingerprint is invalid');
  }
  if (
    typeof record.inputJson !== 'string' ||
    !record.inputJson.trim() ||
    record.inputJson.length > ZAPIER_INPUT_JSON_MAX
  ) {
    catalogError('Zapier inputJson is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.inputJson);
  } catch {
    catalogError('Zapier inputJson is invalid');
  }
  plainRecord(parsed, 'Zapier inputJson');
  return {
    actionId,
    actionTitle,
    downstreamApp,
    schemaFingerprint,
    inputJson: JSON.stringify(parsed),
  };
}

const ZAPIER_CREDENTIAL_BINDINGS: readonly JarvisActionCredentialBinding[] = [
  {
    field: 'zapierConnectionGrant',
    locator: { pluginId: 'zapier', fieldId: 'connection_token' },
  },
];

const ZAPIER_ACTION_REGISTRATIONS: readonly JarvisRegisteredActionDefinition[] = [
  {
    id: 'zapier.actions.discover',
    version: 1,
    title: 'Discover configured Zapier actions',
    description:
      'Discover bounded schemas and exact identities for actions currently exposed by the configured Zapier MCP connection.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', default: 20 },
      },
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['plugin.zapier.actions_discover'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect:
      'Reads bounded metadata for only the actions currently exposed by the configured Zapier MCP connection.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'zapier', toolName: 'actions_discover' },
    credentialBindings: ZAPIER_CREDENTIAL_BINDINGS,
    validateParameters: zapierDiscoverParameters,
    deriveTarget: ({ accountId }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'zapier',
      toolName: 'actions_discover',
      resourceId: 'currently-exposed-actions',
    }),
  },
  {
    id: 'zapier.action.invoke',
    version: 1,
    title: 'Run selected Zapier action',
    description:
      'Run one exact configured Zapier action only after its title, downstream app, and schema fingerprint are approved.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string' },
        actionTitle: { type: 'string' },
        downstreamApp: { type: 'string' },
        schemaFingerprint: { type: 'string' },
        inputJson: {
          type: 'string',
          description: 'A bounded JSON object containing only the selected action arguments.',
        },
      },
      required: ['actionId', 'actionTitle', 'downstreamApp', 'schemaFingerprint', 'inputJson'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['plugin.zapier.action_invoke'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect:
      'Re-discovers and runs one exact unchanged approved Zapier action through the displayed downstream application.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'zapier', toolName: 'action_invoke' },
    credentialBindings: ZAPIER_CREDENTIAL_BINDINGS,
    validateParameters: zapierInvokeParameters,
    deriveTarget: ({ accountId, params }) => {
      const validated = zapierInvokeParameters(params);
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'zapier',
        toolName: 'action_invoke',
        resourceId: validated.actionId,
      };
    },
  },
];

function validateModelSwitchParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, 'chat.model.switch parameters');
  assertExactKeys(record, ['request', 'needsImages', 'needsTools'], 'chat.model.switch parameters');
  const request = nonblank(record.request, 'chat.model.switch request').trim();
  if (request.length > 300) catalogError('chat.model.switch request is too long');
  const validated: Record<string, unknown> = { request };
  for (const key of ['needsImages', 'needsTools'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') catalogError(`chat.model.switch ${key} must be boolean`);
    validated[key] = value;
  }
  return validated;
}

function mcpIdentifier(value: unknown, pattern: RegExp, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(normalized)) catalogError(`${label} is invalid`);
  return normalized;
}

function validateMcpInvokeParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, 'mcp.invoke parameters');
  assertExactKeys(
    record,
    ['serverId', 'toolName', 'inputJson', 'timeoutMs'],
    'mcp.invoke parameters',
  );
  const validated: Record<string, unknown> = {
    serverId: mcpIdentifier(record.serverId, MCP_SERVER_ID, 'MCP server id'),
    toolName: mcpIdentifier(record.toolName, MCP_TOOL_NAME, 'MCP tool name'),
  };
  if (record.inputJson !== undefined) {
    if (
      typeof record.inputJson !== 'string' ||
      record.inputJson.length > MAX_MCP_INPUT_JSON_CHARS
    ) {
      catalogError('MCP inputJson must be a bounded JSON object');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.inputJson);
    } catch {
      catalogError('MCP inputJson must be a JSON object');
    }
    plainRecord(parsed, 'MCP inputJson JSON object');
    validated.inputJson = JSON.stringify(parsed);
  }
  if (record.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(record.timeoutMs) ||
      (record.timeoutMs as number) < 250 ||
      (record.timeoutMs as number) > 120_000
    ) {
      catalogError('MCP timeoutMs is invalid');
    }
    validated.timeoutMs = record.timeoutMs;
  }
  return validated;
}

function validateProjectFileParameters(
  input: Readonly<Record<string, unknown>>,
  operation: 'read' | 'create' | 'edit',
): Readonly<Record<string, unknown>> {
  const label = `files.${operation} parameters`;
  const record = plainRecord(input, label);
  const allowed =
    operation === 'create'
      ? ['path', 'content', 'root', 'attachToChat']
      : operation === 'edit'
        ? ['path', 'content', 'root']
        : ['path', 'root'];
  assertExactKeys(record, allowed, label);
  const path = nonblank(record.path, `${label}.path`);
  if (path.length > 32_768) catalogError(`${label}.path is too long`);
  const validated: Record<string, unknown> = { path };
  if (record.root !== undefined) {
    const root = nonblank(record.root, `${label}.root`);
    if (root.length > 32_768) catalogError(`${label}.root is too long`);
    validated.root = root;
  }
  if (operation !== 'read') {
    if (typeof record.content !== 'string') catalogError(`${label}.content must be a string`);
    if (record.content.length > 1_048_576) catalogError(`${label}.content is too large`);
    validated.content = record.content;
  }
  if (operation === 'create' && record.attachToChat !== undefined) {
    if (typeof record.attachToChat !== 'boolean') {
      catalogError(`${label}.attachToChat must be boolean`);
    }
    validated.attachToChat = record.attachToChat;
  }
  return validated;
}

const TERMINAL_UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const TERMINAL_SELECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;

function safeTrimmedTerminalText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    return catalogError(`${label} must be nonblank`);
  }
  if (TERMINAL_UNSAFE_TEXT.test(value)) {
    return catalogError(`${label} contains unsafe control characters`);
  }
  if (value.length > maximum) catalogError(`${label} is too long`);
  return value.trim();
}

function safeTerminalSelectorId(value: unknown, label: string): string {
  const identifier = safeTrimmedTerminalText(value, label, 240);
  if (!TERMINAL_SELECTOR_ID.test(identifier)) {
    return catalogError(`${label} is not a stable terminal identifier`);
  }
  return identifier;
}

function parseExactTerminalRefJson(value: unknown): Readonly<{
  refsJson: string;
  field: 'sessionId' | 'paneId';
  identifier: string;
}> {
  if (typeof value !== 'string' || value.length > 512 || TERMINAL_UNSAFE_TEXT.test(value)) {
    return catalogError('terminal.send_input parameters.refsJson is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return catalogError('terminal.send_input parameters.refsJson is invalid');
  }
  const record = plainRecord(parsed, 'terminal.send_input parameters.refsJson');
  assertExactKeys(record, ['sessionId', 'paneId'], 'terminal.send_input parameters.refsJson');
  const fields = (['sessionId', 'paneId'] as const).filter((field) => record[field] !== undefined);
  if (fields.length !== 1) {
    return catalogError('terminal.send_input parameters.refsJson requires exactly one selector');
  }
  const field = fields[0];
  const identifier = safeTerminalSelectorId(
    record[field],
    `terminal.send_input parameters.refsJson.${field}`,
  );
  return {
    refsJson: JSON.stringify({ [field]: identifier }),
    field,
    identifier,
  };
}

function validateExactTerminalSelector(
  record: Readonly<Record<string, unknown>>,
  label: string,
): Readonly<{ field: 'sessionId' | 'paneId'; identifier: string }> {
  const fields = (['sessionId', 'paneId'] as const).filter((field) => record[field] !== undefined);
  if (fields.length !== 1) return catalogError(`${label} requires exactly one selector`);
  const field = fields[0];
  return {
    field,
    identifier: safeTerminalSelectorId(record[field], `${label}.${field}`),
  };
}

function validateTerminalStartCliParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const label = 'terminal.start_cli parameters';
  const record = plainRecord(input, label);
  assertExactKeys(record, ['cli', 'cwd', 'label', 'timeoutMs'], label);
  const cli = safeTrimmedTerminalText(record.cli, `${label}.cli`, 32_768);
  const validated: Record<string, unknown> = { cli };
  if (record.cwd !== undefined) {
    validated.cwd = safeTrimmedTerminalText(record.cwd, `${label}.cwd`, 32_768);
  }
  if (record.label !== undefined) {
    validated.label = safeTrimmedTerminalText(record.label, `${label}.label`, 240);
  }
  if (record.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(record.timeoutMs) ||
      (record.timeoutMs as number) < 1_000 ||
      (record.timeoutMs as number) > 1_800_000
    ) {
      catalogError(`${label}.timeoutMs is invalid`);
    }
    validated.timeoutMs = record.timeoutMs;
  }
  return validated;
}

function validateTerminalSendInputParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const label = 'terminal.send_input parameters';
  const record = plainRecord(input, label);
  assertExactKeys(record, ['command', 'refsJson'], label);
  const command = safeTrimmedTerminalText(record.command, `${label}.command`, 10_000);
  const ref = parseExactTerminalRefJson(record.refsJson);
  return { command, refsJson: ref.refsJson };
}

function validateTerminalWaitForOutputParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const label = 'terminal.wait_for_output parameters';
  const record = plainRecord(input, label);
  assertExactKeys(record, ['sessionId', 'paneId', 'contains', 'afterBytes', 'timeoutMs'], label);
  const selector = validateExactTerminalSelector(record, label);
  const validated: Record<string, unknown> = { [selector.field]: selector.identifier };
  if (record.contains !== undefined) {
    validated.contains = safeTrimmedTerminalText(record.contains, `${label}.contains`, 2_000);
  }
  if (
    record.afterBytes !== undefined &&
    (!Number.isSafeInteger(record.afterBytes) || (record.afterBytes as number) < 0)
  ) {
    catalogError(`${label}.afterBytes is invalid`);
  }
  if (record.afterBytes !== undefined) validated.afterBytes = record.afterBytes;
  if (
    record.timeoutMs !== undefined &&
    (!Number.isSafeInteger(record.timeoutMs) ||
      (record.timeoutMs as number) < 250 ||
      (record.timeoutMs as number) > 60_000)
  ) {
    catalogError(`${label}.timeoutMs is invalid`);
  }
  if (record.timeoutMs !== undefined) validated.timeoutMs = record.timeoutMs;
  return validated;
}

function validateTerminalCollectOutputParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const label = 'terminal.collect_output parameters';
  const record = plainRecord(input, label);
  assertExactKeys(record, ['sessionId', 'paneId', 'maxChars'], label);
  const selector = validateExactTerminalSelector(record, label);
  const validated: Record<string, unknown> = { [selector.field]: selector.identifier };
  if (
    record.maxChars !== undefined &&
    (!Number.isSafeInteger(record.maxChars) ||
      (record.maxChars as number) < 200 ||
      (record.maxChars as number) > 16_000)
  ) {
    catalogError(`${label}.maxChars is invalid`);
  }
  if (record.maxChars !== undefined) validated.maxChars = record.maxChars;
  return validated;
}

function terminalSelectorTarget(
  params: Readonly<Record<string, unknown>>,
  validator: (input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): JarvisCanonicalActionTarget {
  const validated = validator(params);
  const field = validated.sessionId !== undefined ? 'sessionId' : 'paneId';
  return {
    kind: 'external_resource',
    service: 'terminal',
    resourceId: `${field === 'sessionId' ? 'session' : 'pane'}:${String(validated[field])}`,
  };
}

function validateScheduleCreateParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, 'schedule.create parameters');
  assertExactKeys(
    record,
    ['title', 'prompt', 'startAtMs', 'recurrence', 'agentId'],
    'schedule.create parameters',
  );
  const title = nonblank(record.title, 'schedule.create parameters.title');
  const prompt = nonblank(record.prompt, 'schedule.create parameters.prompt');
  if (title.length > 240) catalogError('schedule.create parameters.title is too long');
  if (prompt.length > 50_000) catalogError('schedule.create parameters.prompt is too long');
  if (!Number.isSafeInteger(record.startAtMs) || (record.startAtMs as number) <= 0) {
    catalogError('schedule.create parameters.startAtMs is invalid');
  }
  const recurrence = record.recurrence ?? 'once';
  if (!['once', 'daily', 'weekly', 'monthly', 'weekdays'].includes(String(recurrence))) {
    catalogError('schedule.create parameters.recurrence is invalid');
  }
  const validated: Record<string, unknown> = {
    title,
    prompt,
    startAtMs: record.startAtMs,
    recurrence,
  };
  if (record.agentId !== undefined) {
    validated.agentId = nonblank(record.agentId, 'schedule.create parameters.agentId');
  }
  return validated;
}

function validateAgentRunParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const record = plainRecord(input, 'agent.run parameters');
  assertExactKeys(record, ['task', 'agentId'], 'agent.run parameters');
  const task = nonblank(record.task, 'agent.run parameters.task');
  if (task.length > 50_000) catalogError('agent.run parameters.task is too long');
  const validated: Record<string, unknown> = { task };
  if (record.agentId !== undefined) {
    const agentId = nonblank(record.agentId, 'agent.run parameters.agentId');
    if (agentId.length > 256) catalogError('agent.run parameters.agentId is too long');
    validated.agentId = agentId;
  }
  return validated;
}

export const DEFAULT_JARVIS_ACTION_REGISTRATIONS = deepFreeze<
  readonly JarvisRegisteredActionDefinition[]
>([
  {
    id: 'file.search',
    version: 1,
    title: 'Search files',
    description: 'Search the canonical app file index.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['files.read'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads matching file metadata without modifying files.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'file.search' },
    credentialBindings: [],
    validateParameters: (input: Readonly<Record<string, unknown>>) => ({ ...input }),
    deriveTarget: () => ({ kind: 'app_resource', namespace: 'files', resourceId: 'search-index' }),
  },
  {
    id: 'files.read',
    version: 1,
    title: 'Read project file',
    description: 'Read one bounded text-file sample inside an allowed project root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, root: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['files.read'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'always',
    expectedEffect: 'Reads one user-approved bounded text-file sample.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'files.read' },
    credentialBindings: [],
    validateParameters: (input) => validateProjectFileParameters(input, 'read'),
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'files',
      resourceId: String(params.path),
    }),
  },
  {
    id: 'files.create',
    version: 1,
    title: 'Create project file',
    description: 'Create one text file without overwriting inside an allowed project root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        root: { type: 'string' },
        attachToChat: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['files.write'],
    requiredEntitlements: [],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Creates one user-approved text file without overwriting.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'files.create' },
    credentialBindings: [],
    validateParameters: (input) => validateProjectFileParameters(input, 'create'),
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'files',
      resourceId: String(params.path),
    }),
  },
  {
    id: 'files.edit',
    version: 1,
    title: 'Replace project file',
    description: 'Replace one existing text file inside an allowed project root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        root: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['files.write'],
    requiredEntitlements: [],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Replaces one existing user-approved text file.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'files.edit' },
    credentialBindings: [],
    validateParameters: (input) => validateProjectFileParameters(input, 'edit'),
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'files',
      resourceId: String(params.path),
    }),
  },
  {
    id: 'github.identity',
    version: 1,
    title: 'Read GitHub identity',
    description: 'Read normalized metadata for the connected GitHub account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        login: { type: 'string' },
        profileUrl: { type: 'string' },
        publicRepositories: { type: 'number' },
        privateRepositories: { type: 'number' },
      },
      required: ['login', 'profileUrl', 'publicRepositories'],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.identity'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads bounded authenticated-account metadata from GitHub.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'identity' },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input: Readonly<Record<string, unknown>>) =>
      validateNoParameters(input, 'github.identity parameters'),
    deriveTarget: ({ accountId }) => ({
      kind: 'plugin_tool',
      accountId,
      pluginId: 'github',
      toolName: 'identity',
      resourceId: 'authenticated-account',
    }),
  },
  {
    id: 'github.repository.read',
    version: 1,
    title: 'Read GitHub repository',
    description: 'Read normalized metadata for one exact GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
      },
      required: ['owner', 'repository'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        fullName: { type: 'string' },
        repositoryUrl: { type: 'string' },
        visibility: { type: 'string' },
        defaultBranch: { type: 'string' },
        stars: { type: 'number' },
        forks: { type: 'number' },
        openIssuesAndPullRequests: { type: 'number' },
        archived: { type: 'boolean' },
        updatedAt: { type: 'string' },
      },
      required: [
        'fullName',
        'repositoryUrl',
        'visibility',
        'defaultBranch',
        'stars',
        'forks',
        'openIssuesAndPullRequests',
        'archived',
        'updatedAt',
      ],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.repository_context'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads bounded repository metadata from GitHub without changing it.',
    exposeToAI: true,
    executor: {
      kind: 'plugin_tool',
      pluginId: 'github',
      toolName: 'repository_context',
    },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: validateGithubRepositoryParameters,
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository } = validateGithubRepositoryParameters(params);
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'repository_context',
        resourceId: `${owner}/${repository}`,
      };
    },
  },
  {
    id: 'github.issue.read',
    version: 1,
    title: 'Read GitHub issue',
    description: 'Read bounded untrusted context for one exact GitHub issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
        number: { type: 'number' },
      },
      required: ['owner', 'repository', 'number'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contentTrust: { type: 'string' },
        fullName: { type: 'string' },
        number: { type: 'number' },
        issueUrl: { type: 'string' },
        state: { type: 'string' },
        untrustedTitle: { type: 'string' },
        untrustedBodyExcerpt: { type: 'string' },
        bodyTruncated: { type: 'boolean' },
        author: { type: 'string' },
        untrustedLabels: { type: 'array' },
        comments: { type: 'number' },
        locked: { type: 'boolean' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        closedAt: { type: 'string' },
      },
      required: [
        'contentTrust',
        'fullName',
        'number',
        'issueUrl',
        'state',
        'untrustedTitle',
        'bodyTruncated',
        'author',
        'untrustedLabels',
        'comments',
        'locked',
        'createdAt',
        'updatedAt',
      ],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.issue_context'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads one issue as bounded external untrusted data without changing it.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'issue_context' },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input) =>
      validateGithubNumberedParameters(input, 'github.issue.read parameters'),
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository, number } = validateGithubNumberedParameters(
        params,
        'github.issue.read parameters',
      );
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'issue_context',
        resourceId: `${owner}/${repository}#${number}`,
      };
    },
  },
  {
    id: 'github.pull_request.read',
    version: 1,
    title: 'Read GitHub pull request',
    description: 'Read bounded untrusted context for one exact GitHub pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
        number: { type: 'number' },
      },
      required: ['owner', 'repository', 'number'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contentTrust: { type: 'string' },
        fullName: { type: 'string' },
        number: { type: 'number' },
        pullRequestUrl: { type: 'string' },
        state: { type: 'string' },
        draft: { type: 'boolean' },
        merged: { type: 'boolean' },
        untrustedTitle: { type: 'string' },
        untrustedBodyExcerpt: { type: 'string' },
        bodyTruncated: { type: 'boolean' },
        author: { type: 'string' },
        baseBranch: { type: 'string' },
        headBranch: { type: 'string' },
        changedFiles: { type: 'number' },
        additions: { type: 'number' },
        deletions: { type: 'number' },
        comments: { type: 'number' },
        reviewComments: { type: 'number' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        closedAt: { type: 'string' },
        mergedAt: { type: 'string' },
      },
      required: [
        'contentTrust',
        'fullName',
        'number',
        'pullRequestUrl',
        'state',
        'draft',
        'merged',
        'untrustedTitle',
        'bodyTruncated',
        'author',
        'baseBranch',
        'headBranch',
        'changedFiles',
        'additions',
        'deletions',
        'comments',
        'reviewComments',
        'createdAt',
        'updatedAt',
      ],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.pull_request_context'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect:
      'Reads one pull request as bounded external untrusted data without changing it.',
    exposeToAI: true,
    executor: {
      kind: 'plugin_tool',
      pluginId: 'github',
      toolName: 'pull_request_context',
    },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input) =>
      validateGithubNumberedParameters(input, 'github.pull_request.read parameters'),
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository, number } = validateGithubNumberedParameters(
        params,
        'github.pull_request.read parameters',
      );
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'pull_request_context',
        resourceId: `${owner}/${repository}#${number}`,
      };
    },
  },
  {
    id: 'github.commits.recent',
    version: 1,
    title: 'Read recent GitHub commits',
    description: 'Read up to five bounded untrusted recent commits for one exact repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
      },
      required: ['owner', 'repository'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contentTrust: { type: 'string' },
        fullName: { type: 'string' },
        commits: { type: 'array' },
      },
      required: ['contentTrust', 'fullName', 'commits'],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.recent_commits'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect:
      'Reads at most five recent commit summaries as external untrusted data without changing the repository.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'recent_commits' },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input) =>
      validateGithubRepositoryParameters(input, 'github.commits.recent parameters'),
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository } = validateGithubRepositoryParameters(
        params,
        'github.commits.recent parameters',
      );
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'recent_commits',
        resourceId: `${owner}/${repository}`,
      };
    },
  },
  {
    id: 'github.release.latest',
    version: 1,
    title: 'Read latest GitHub release',
    description: 'Read bounded untrusted metadata for the latest published repository release.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
      },
      required: ['owner', 'repository'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contentTrust: { type: 'string' },
        fullName: { type: 'string' },
        releaseUrl: { type: 'string' },
        tagName: { type: 'string' },
        untrustedName: { type: 'string' },
        untrustedBodyExcerpt: { type: 'string' },
        bodyTruncated: { type: 'boolean' },
        author: { type: 'string' },
        prerelease: { type: 'boolean' },
        createdAt: { type: 'string' },
        publishedAt: { type: 'string' },
      },
      required: [
        'contentTrust',
        'fullName',
        'releaseUrl',
        'tagName',
        'bodyTruncated',
        'author',
        'prerelease',
        'createdAt',
        'publishedAt',
      ],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.latest_release'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect:
      'Reads the latest published release as bounded external untrusted data without changing it.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'latest_release' },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input) =>
      validateGithubRepositoryParameters(input, 'github.release.latest parameters'),
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository } = validateGithubRepositoryParameters(
        params,
        'github.release.latest parameters',
      );
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'latest_release',
        resourceId: `${owner}/${repository}`,
      };
    },
  },
  {
    id: 'github.workflows.list',
    version: 1,
    title: 'List GitHub workflows',
    description:
      'Read up to ten bounded workflow metadata records without retrieving runs, jobs, or logs.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repository: { type: 'string' },
      },
      required: ['owner', 'repository'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        contentTrust: { type: 'string' },
        fullName: { type: 'string' },
        totalCount: { type: 'number' },
        actionsLogsRetrieved: { type: 'boolean' },
        workflows: { type: 'array' },
      },
      required: ['contentTrust', 'fullName', 'totalCount', 'actionsLogsRetrieved', 'workflows'],
      additionalProperties: false,
    },
    requiredCapabilities: ['plugin.github.workflows'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect:
      'Reads at most ten workflow metadata records without retrieving workflow runs, jobs, or Actions logs.',
    exposeToAI: true,
    executor: { kind: 'plugin_tool', pluginId: 'github', toolName: 'workflows' },
    credentialBindings: [
      {
        field: 'githubCredential',
        locator: { pluginId: 'github', fieldId: 'token' },
      },
    ],
    validateParameters: (input) =>
      validateGithubRepositoryParameters(input, 'github.workflows.list parameters'),
    deriveTarget: ({ accountId, params }) => {
      const { owner, repository } = validateGithubRepositoryParameters(
        params,
        'github.workflows.list parameters',
      );
      return {
        kind: 'plugin_tool',
        accountId,
        pluginId: 'github',
        toolName: 'workflows',
        resourceId: `${owner}/${repository}`,
      };
    },
  },
  ...GMAIL_ACTION_REGISTRATIONS,
  ...GOOGLE_DRIVE_ACTION_REGISTRATIONS,
  ...CANVA_ACTION_REGISTRATIONS,
  ...ZAPIER_ACTION_REGISTRATIONS,
  browserRegistration('browser.readPage'),
  browserRegistration('browser.navigate'),
  browserRegistration('browser.click'),
  browserRegistration('browser.type'),
  {
    id: 'chat.model.switch',
    version: 1,
    title: 'Switch chat model',
    description:
      'Switch the active chat model after connection, capability, privacy, cost, and approval checks.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'An exact supported model-switch request.',
        },
        needsImages: {
          type: 'boolean',
          description: 'Whether the next request requires image input.',
        },
        needsTools: {
          type: 'boolean',
          description: 'Whether the next request requires tool use.',
        },
      },
      required: ['request'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['chat.actions'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect:
      'Changes the active chat model while preserving JARVIS identity and workspace context.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'chat.model.switch' },
    credentialBindings: [],
    validateParameters: validateModelSwitchParameters,
    deriveTarget: () => ({
      kind: 'app_resource',
      namespace: 'chat-model',
      resourceId: 'active',
    }),
  },
  {
    id: 'mcp.invoke',
    version: 1,
    title: 'Invoke external MCP tool',
    description:
      'Invoke one exact task-routed external MCP tool through its current explicit server permission.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: {
          type: 'string',
          description: 'Exact serverId from the task-relevant MCP schema context.',
        },
        toolName: {
          type: 'string',
          description: 'Exact toolName from the task-relevant MCP schema context.',
        },
        inputJson: {
          type: 'string',
          description:
            'A JSON object matching that routed tool inputSchema; omit for an empty object.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout from 250 through 120000 milliseconds.',
        },
      },
      required: ['serverId', 'toolName'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['mcp.external.invoke'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect:
      'Invokes exactly one explicitly exposed external MCP tool and records its normalized result.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'mcp.invoke' },
    credentialBindings: [],
    validateParameters: validateMcpInvokeParameters,
    deriveTarget: ({ params }) => {
      const validated = validateMcpInvokeParameters(params);
      return {
        kind: 'external_resource',
        service: 'mcp',
        resourceId: `${validated.serverId}.${validated.toolName}`,
      };
    },
  },
  {
    id: 'creator.start',
    version: 1,
    title: 'Open Make with Jarvis',
    description: 'Open the bounded agent or skill creator; saving remains an explicit user action.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['agent', 'skill'] } },
      required: ['kind'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['creator.open'],
    requiredEntitlements: [],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Opens the selected creator without saving or running generated content.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'creator.start' },
    credentialBindings: [],
    validateParameters: (input) => {
      const record = plainRecord(input, 'creator.start parameters');
      assertExactKeys(record, ['kind'], 'creator.start parameters');
      if (record.kind !== 'agent' && record.kind !== 'skill') {
        catalogError('creator.start parameters.kind is invalid');
      }
      return { kind: record.kind };
    },
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'creator',
      resourceId: String(params.kind),
    }),
  },
  {
    id: 'schedule.create',
    version: 1,
    title: 'Create Jarvis schedule',
    description: 'Create one local Jarvis scheduled task with explicit owner approval.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        startAtMs: { type: 'number' },
        recurrence: {
          type: 'string',
          enum: ['once', 'daily', 'weekly', 'monthly', 'weekdays'],
        },
        agentId: { type: 'string' },
      },
      required: ['title', 'prompt', 'startAtMs'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['schedule.write'],
    requiredEntitlements: [],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Creates one user-approved local Jarvis schedule.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'schedule.create' },
    credentialBindings: [],
    validateParameters: validateScheduleCreateParameters,
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'schedule',
      resourceId: String(params.title),
    }),
  },
  {
    id: 'agent.run',
    version: 1,
    title: 'Run one child agent',
    description:
      'Launch one persistent VibeSpace child-chat agent with a bounded task and optional exact saved agent.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['agent.execute'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect: 'Launches one user-approved persistent child chat.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'agent.run' },
    credentialBindings: [],
    validateParameters: validateAgentRunParameters,
    deriveTarget: ({ params }) => ({
      kind: 'app_resource',
      namespace: 'agent',
      resourceId: String(params.agentId ?? 'default'),
    }),
  },
  {
    id: 'terminal.create',
    version: 1,
    title: 'Create terminal',
    description: 'Create one terminal through the registered host action.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.execute'],
    requiredEntitlements: [],
    risk: 'safe-write',
    approval: 'always',
    expectedEffect: 'Creates one terminal process owned by the active account.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'terminal.create' },
    credentialBindings: [],
    validateParameters: (input: Readonly<Record<string, unknown>>) => ({ ...input }),
    deriveTarget: () => ({ kind: 'external_resource', service: 'terminal', resourceId: 'new' }),
  },
  {
    id: 'terminal.run',
    version: 1,
    title: 'Run terminal command',
    description: 'Run one approved shell command in a new terminal pane.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        label: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.execute'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect: 'Runs one approved shell command in a new terminal pane.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'terminal.run' },
    credentialBindings: [],
    validateParameters: (input: Readonly<Record<string, unknown>>) => ({ ...input }),
    deriveTarget: () => ({
      kind: 'external_resource',
      service: 'terminal',
      resourceId: 'new-command',
    }),
  },
  {
    id: 'terminal.start_cli',
    version: 1,
    title: 'Start terminal CLI',
    description: 'Start one named CLI command in a new terminal pane.',
    inputSchema: {
      type: 'object',
      properties: {
        cli: { type: 'string' },
        cwd: { type: 'string' },
        label: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['cli'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.experimental.disabled'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect: 'Starts one approved CLI command in one new terminal pane.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: 'terminal.start_cli' },
    credentialBindings: [],
    validateParameters: validateTerminalStartCliParameters,
    deriveTarget: ({ params }) => {
      const validated = validateTerminalStartCliParameters(params);
      const cli = String(validated.cli);
      const paneLabel = String(validated.label ?? cli.trim().split(/\s+/, 1)[0]);
      return {
        kind: 'external_resource',
        service: 'terminal',
        resourceId: `new-cli:${paneLabel}`,
      };
    },
  },
  {
    id: 'terminal.send_input',
    version: 1,
    title: 'Send terminal input',
    description: 'Send one approved command to exactly one referenced live terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        refsJson: { type: 'string' },
      },
      required: ['command', 'refsJson'],
      additionalProperties: false,
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.experimental.disabled'],
    requiredEntitlements: [],
    risk: 'external-side-effect',
    approval: 'always',
    expectedEffect: 'Sends one approved command to exactly one selected terminal.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: 'terminal.send_input' },
    credentialBindings: [],
    validateParameters: validateTerminalSendInputParameters,
    deriveTarget: ({ params }) => {
      const validated = validateTerminalSendInputParameters(params);
      const ref = parseExactTerminalRefJson(validated.refsJson);
      return {
        kind: 'external_resource',
        service: 'terminal',
        resourceId: `${ref.field === 'sessionId' ? 'session' : 'pane'}:${ref.identifier}`,
      };
    },
  },
  {
    id: 'terminal.wait_for_output',
    version: 1,
    title: 'Wait for terminal output',
    description: 'Wait for bounded output from exactly one selected live terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        paneId: { type: 'string' },
        contains: { type: 'string' },
        afterBytes: { type: 'number' },
        timeoutMs: { type: 'number' },
      },
      required: [],
      additionalProperties: false,
      oneOf: [
        { type: 'object', required: ['sessionId'] },
        { type: 'object', required: ['paneId'] },
      ],
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.experimental.disabled'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Waits for bounded output from exactly one selected terminal.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: 'terminal.wait_for_output' },
    credentialBindings: [],
    validateParameters: validateTerminalWaitForOutputParameters,
    deriveTarget: ({ params }) =>
      terminalSelectorTarget(params, validateTerminalWaitForOutputParameters),
  },
  {
    id: 'terminal.collect_output',
    version: 1,
    title: 'Collect terminal output',
    description: 'Collect a bounded transcript tail from exactly one selected terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        paneId: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: [],
      additionalProperties: false,
      oneOf: [
        { type: 'object', required: ['sessionId'] },
        { type: 'object', required: ['paneId'] },
      ],
    },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['terminal.experimental.disabled'],
    requiredEntitlements: [],
    risk: 'read-only',
    approval: 'never',
    expectedEffect: 'Reads a bounded transcript tail from exactly one selected terminal.',
    exposeToAI: false,
    executor: { kind: 'builtin', registryActionId: 'terminal.collect_output' },
    credentialBindings: [],
    validateParameters: validateTerminalCollectOutputParameters,
    deriveTarget: ({ params }) =>
      terminalSelectorTarget(params, validateTerminalCollectOutputParameters),
  },
  {
    id: 'task.cancel',
    version: 1,
    title: 'Cancel task',
    description: 'Request cancellation of the current registered task.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: NO_OUTPUT_SCHEMA,
    requiredCapabilities: ['tasks.cancel'],
    requiredEntitlements: [],
    risk: 'destructive',
    approval: 'always',
    expectedEffect: 'Requests cancellation of the selected task.',
    exposeToAI: true,
    executor: { kind: 'builtin', registryActionId: 'task.cancel' },
    credentialBindings: [],
    validateParameters: (input: Readonly<Record<string, unknown>>) => ({ ...input }),
    deriveTarget: () => ({ kind: 'app_resource', namespace: 'tasks', resourceId: 'selected' }),
  },
]);

function schemaForParam(param: ActionParam): JsonSchema & { enum?: string[]; default?: unknown } {
  const type = param.type === 'number' ? 'number' : param.type === 'boolean' ? 'boolean' : 'string';
  return {
    type,
    description: param.help || param.label,
    ...(param.options?.length ? { enum: param.options.map((option) => option.value) } : {}),
    ...(param.default !== undefined ? { default: param.default } : {}),
  };
}

function inputSchema(action: ActionDef): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      action.params.map((param) => [param.key, schemaForParam(param)]),
    ),
    required: action.params.filter((param) => param.required).map((param) => param.key),
    additionalProperties: false,
  };
}

function inferRisk(action: ActionDef): JarvisActionRisk {
  if (
    /^(?:terminal\.(?!bulkClose)|shell\.|plugin\.(?:call|invoke|connect)|mcp\.(?:start|invoke)|notification\.send)/.test(
      action.id,
    )
  ) {
    return 'external-side-effect';
  }
  if (action.destructive) return 'destructive';
  if (
    /^(?:files?\.read|terminal\.(?:inspect|collect_output|wait_for_output)|schedule\.(?:list|history)|agent\.(?:wait|list)|plugin\.status|mcp\.(?:status|list)|context\.|report\.)/.test(
      action.id,
    )
  ) {
    return 'read-only';
  }
  if (
    /^(?:nav\.|settings\.|theme\.|chat\.(?:fullscreen|open)|inspector\.|tools\.open|actions\.openPalette|host\.open(?:Assistant|CommandPalette|Launcher))/.test(
      action.id,
    )
  ) {
    return 'safe-write';
  }
  if (
    /^(?:files?\.(?:create|edit|write)|chat\.(?:create|rename|send)|agent\.(?:create|run)|tool\.(?:create|run)|schedule\.|jarvis_action\.|preferences\.|voice\.)/.test(
      action.id,
    )
  ) {
    return 'safe-write';
  }
  return 'safe-write';
}

function inferApproval(action: ActionDef, risk: JarvisActionRisk): JarvisActionApproval {
  if (action.autoApprove || risk === 'read-only') return 'never';
  if (
    /^(?:nav\.|settings\.|theme\.|chat\.fullscreen|inspector\.|tools\.open|actions\.openPalette|host\.open(?:Assistant|CommandPalette|Launcher))/.test(
      action.id,
    )
  ) {
    return 'never';
  }
  if (
    risk === 'destructive' ||
    risk === 'external-side-effect' ||
    risk === 'credential-sensitive'
  ) {
    return 'always';
  }
  if (/^(?:files?\.|schedule\.delete|settings\.update)/.test(action.id)) return 'depends-on-input';
  return 'first-time';
}

function capabilityFor(action: ActionDef): string[] {
  const category = action.category === 'custom' ? 'tool' : action.category;
  return [`${category}.actions`];
}

function permissionsFor(risk: JarvisActionRisk): string[] {
  switch (risk) {
    case 'read-only':
      return ['app.read'];
    case 'safe-write':
      return ['app.write'];
    case 'external-side-effect':
      return ['external.execute'];
    case 'destructive':
      return ['app.destructive'];
    case 'credential-sensitive':
      return ['credentials.use-without-disclosure'];
  }
}

export function buildJarvisActionCatalog(actions: readonly ActionDef[]): JarvisActionDefinition[] {
  return actions.map((action) => {
    const risk = inferRisk(action);
    return {
      id: action.id,
      version: 1,
      title: action.label,
      description: action.description,
      category: action.category,
      inputSchema: inputSchema(action),
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      requiredCapabilities: capabilityFor(action),
      requiredPermissions: permissionsFor(risk),
      supportedPlatforms: [...ALL_PLATFORMS],
      risk,
      approval: inferApproval(action, risk),
      supportsProgress: /^(?:terminal\.|workflow\.|agent\.run|mcp\.)/.test(action.id),
      supportsCancellation: /^(?:terminal\.|workflow\.|agent\.run|mcp\.)/.test(action.id),
      supportsRollback: /^(?:files?\.(?:create|edit)|chat\.rename|settings\.|theme\.)/.test(
        action.id,
      ),
      preconditions: ['handler-registered'],
      possibleNextActions: [],
      exposeToAI: action.exposeToAI !== false,
      handler: action.run,
    };
  });
}

export function validateJarvisActionCatalog(catalog: readonly JarvisActionDefinition[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const action of catalog) {
    if (!/^[a-z][a-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(action.id)) {
      errors.push(`${action.id || '<missing-id>'}: invalid stable action id`);
    }
    if (ids.has(action.id)) errors.push(`${action.id}: duplicate action id`);
    ids.add(action.id);
    if (action.version < 1 || !Number.isInteger(action.version)) {
      errors.push(`${action.id}: invalid version`);
    }
    if (!action.title.trim() || !action.description.trim()) {
      errors.push(`${action.id}: missing title or description`);
    }
    if (typeof action.handler !== 'function') errors.push(`${action.id}: missing handler`);
    for (const key of Object.keys(action.inputSchema.properties ?? {})) {
      if (SECRET_FIELD_RE.test(key))
        errors.push(`${action.id}: credential field "${key}" is model-visible`);
    }
  }
  return errors;
}

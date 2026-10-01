import type {
  JarvisActionJsonSchema,
  JarvisActionSchemaSnapshot,
  JarvisCapabilityRef,
  JarvisCapabilitySnapshot,
  JarvisEntitlementSnapshot,
} from '@/lib/jarvis/contracts';
import { validateJarvisCapabilitySnapshot } from '@/lib/jarvis/contracts';
import { deepFreezeJarvisCopy } from '@/lib/jarvis/requestEnvelope';
import type { JarvisRegisteredActionDefinition, JsonSchema } from '@/lib/jarvis/actions/catalog';
import { isJarvisModelVisibleSchemaSafe } from '@/lib/jarvis/sourcePolicy';

type ModelVisibleActionSchemaSource = Pick<
  JarvisRegisteredActionDefinition,
  | 'id'
  | 'version'
  | 'title'
  | 'description'
  | 'inputSchema'
  | 'outputSchema'
  | 'requiredCapabilities'
  | 'requiredEntitlements'
  | 'risk'
  | 'approval'
  | 'expectedEffect'
>;

export interface CapabilitySnapshotInput {
  capturedAt: number;
  tools: readonly JarvisCapabilityRef[];
  plugins: readonly JarvisCapabilityRef[];
  mcps: readonly JarvisCapabilityRef[];
  terminals: readonly JarvisCapabilityRef[];
  agents: readonly JarvisCapabilityRef[];
  entitlements: JarvisEntitlementSnapshot;
  actionSchemas?: readonly ModelVisibleActionSchemaSource[];
}

export interface JarvisCapabilitySnapshotProvider {
  getForAccount(accountId: string): Promise<Readonly<JarvisCapabilitySnapshot>>;
}

export class CapabilityAccountUnavailableError extends Error {
  readonly code = 'capability_account_unavailable' as const;

  constructor() {
    super('Capability state is unavailable for the active account.');
    this.name = 'CapabilityAccountUnavailableError';
  }
}

export class JarvisCapabilitySnapshotError extends Error {
  readonly code = 'invalid_capability_snapshot' as const;

  constructor() {
    super('Invalid JARVIS capability snapshot.');
    this.name = 'JarvisCapabilitySnapshotError';
  }
}

function hasLiveEvidence(ref: JarvisCapabilityRef): boolean {
  return (
    typeof ref.evidenceRef === 'string' &&
    ref.evidenceRef.trim().length > 0 &&
    typeof ref.lastVerifiedAt === 'number' &&
    Number.isFinite(ref.lastVerifiedAt)
  );
}

function copyCapability(ref: JarvisCapabilityRef): JarvisCapabilityRef {
  const requiresEvidence = ref.state === 'connected' || ref.state === 'authenticated';
  const state = requiresEvidence && !hasLiveEvidence(ref) ? 'available' : ref.state;
  return {
    id: ref.id,
    state,
    operations: [...ref.operations],
    ...(ref.evidenceRef === undefined ? {} : { evidenceRef: ref.evidenceRef }),
    ...(ref.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: ref.lastVerifiedAt }),
  };
}

function copyCapabilityList(refs: readonly JarvisCapabilityRef[]): JarvisCapabilityRef[] {
  return refs
    .map(copyCapability)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function copyEntitlements(entitlements: JarvisEntitlementSnapshot): JarvisEntitlementSnapshot {
  return {
    source: entitlements.source,
    ...(entitlements.planId === undefined ? {} : { planId: entitlements.planId }),
    capabilities: [...entitlements.capabilities],
    ...(entitlements.verifiedAt === undefined ? {} : { verifiedAt: entitlements.verifiedAt }),
    ...(entitlements.expiresAt === undefined ? {} : { expiresAt: entitlements.expiresAt }),
  };
}

function copyActionJsonSchema(schema: Readonly<JsonSchema>, depth = 0): JarvisActionJsonSchema {
  if (depth > 16 || (schema.oneOf && (schema.oneOf.length < 1 || schema.oneOf.length > 8))) {
    throw new JarvisCapabilitySnapshotError();
  }
  const enumValues = (schema as Readonly<JsonSchema> & { enum?: readonly string[] }).enum;
  return {
    type: schema.type,
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, property]) => [
              key,
              copyActionJsonSchema(property, depth + 1),
            ]),
          ),
        }),
    ...(schema.required === undefined ? {} : { required: [...schema.required] }),
    ...(schema.additionalProperties === undefined
      ? {}
      : { additionalProperties: schema.additionalProperties }),
    ...(Array.isArray(enumValues) ? { enum: [...enumValues] } : {}),
    ...(schema.oneOf === undefined
      ? {}
      : { oneOf: schema.oneOf.map((branch) => copyActionJsonSchema(branch, depth + 1)) }),
  };
}

function copyActionSchema(
  source: Readonly<ModelVisibleActionSchemaSource>,
): JarvisActionSchemaSnapshot {
  return {
    id: source.id,
    version: source.version,
    title: source.title,
    description: source.description,
    inputSchema: copyActionJsonSchema(source.inputSchema),
    outputSchema: copyActionJsonSchema(source.outputSchema),
    requiredCapabilities: [...source.requiredCapabilities],
    requiredEntitlements: [...source.requiredEntitlements],
    risk: source.risk,
    approval: source.approval,
    expectedEffect: source.expectedEffect,
  };
}

function actionSchemaIsSafe(schema: JarvisActionSchemaSnapshot): boolean {
  return isJarvisModelVisibleSchemaSafe(schema);
}

export function createJarvisCapabilitySnapshot(
  input: CapabilitySnapshotInput,
): Readonly<JarvisCapabilitySnapshot> {
  const actionSchemas = input.actionSchemas
    ?.map(copyActionSchema)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (actionSchemas && new Set(actionSchemas.map(({ id }) => id)).size !== actionSchemas.length) {
    throw new JarvisCapabilitySnapshotError();
  }
  if (actionSchemas?.some((schema) => !actionSchemaIsSafe(schema))) {
    throw new JarvisCapabilitySnapshotError();
  }
  const snapshot: JarvisCapabilitySnapshot = {
    capturedAt: input.capturedAt,
    tools: copyCapabilityList(input.tools),
    plugins: copyCapabilityList(input.plugins),
    mcps: copyCapabilityList(input.mcps),
    terminals: copyCapabilityList(input.terminals),
    agents: copyCapabilityList(input.agents),
    entitlements: copyEntitlements(input.entitlements),
    ...(actionSchemas === undefined ? {} : { actionSchemas }),
  };
  const validation = validateJarvisCapabilitySnapshot(snapshot);
  if (!validation.ok) throw new JarvisCapabilitySnapshotError();
  return deepFreezeJarvisCopy(snapshot);
}

export function createJarvisCapabilitySnapshotProvider(input: {
  getActiveAccountId(): string | undefined;
  resolveInputForActiveAccount(accountId: string): Promise<CapabilitySnapshotInput>;
}): JarvisCapabilitySnapshotProvider {
  return {
    async getForAccount(accountId: string): Promise<Readonly<JarvisCapabilitySnapshot>> {
      if (!accountId.trim() || input.getActiveAccountId() !== accountId) {
        throw new CapabilityAccountUnavailableError();
      }

      const resolved = await input.resolveInputForActiveAccount(accountId);
      if (input.getActiveAccountId() !== accountId) {
        throw new CapabilityAccountUnavailableError();
      }

      return createJarvisCapabilitySnapshot(resolved);
    },
  };
}

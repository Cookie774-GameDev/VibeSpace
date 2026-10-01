import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type CompiledJarvisPrompt,
  type CompiledPromptLayer,
  canonicalizeJarvisApprovalJson,
  hashCanonicalJarvisApprovalJson,
  type JarvisApprovalV1,
  type JarvisArtifactV1,
  type JarvisCapabilityRef,
  type JarvisCapabilitySnapshot,
  type JarvisContextItem,
  type JarvisContextPack,
  type JarvisContractValidationError,
  type JarvisContractValidationErrorCode,
  type JarvisContractValidationResult,
  type JarvisEntitlementSnapshot,
  type JarvisEvent,
  type JarvisCanonicalResultEvidenceV1,
  type JarvisDurableLiveEvidenceV1,
  type JarvisExecutionEvidenceV1,
  type JarvisExecutionState,
  type JarvisHiveStackPlanV1,
  type JarvisLiveProducerIdentity,
  type JarvisModelSnapshot,
  type JarvisOutputContract,
  type JarvisProducerSourceEvidenceV1,
  type JarvisRequestEnvelope,
  type JarvisResponseEnvelope,
  type JarvisResponseMode,
  type JarvisRun,
  type JarvisRunStatus,
  type JarvisScheduledRetrySnapshotV1,
  type JarvisSourceRef,
  type JarvisSourceKind,
  type JarvisTransportAttemptV1,
  type JarvisZeroConsequentialEffectEvidenceV1,
  type PromptAuthority,
  validateCompiledJarvisPrompt,
  validateJarvisApproval,
  validateJarvisArtifact,
  validateJarvisCapabilitySnapshot,
  validateJarvisContextPack,
  validateJarvisEvent,
  validateJarvisModelSnapshot,
  validateJarvisRequestEnvelope,
  validateJarvisResponseEnvelope,
  validateJarvisRun,
  validateJarvisSourceRef,
} from './index';

type Validator = (input: unknown) => JarvisContractValidationResult<unknown>;
type Path = readonly (string | number)[];

const validationErrorCodes = [
  'missing_field',
  'invalid_type',
  'unknown_field',
  'unknown_enum',
  'non_finite_number',
  'invalid_identifier',
  'non_json_safe',
] as const satisfies readonly JarvisContractValidationErrorCode[];

function validSourceRef(): JarvisSourceRef {
  return {
    id: 'source-1',
    kind: 'project_file',
    label: 'Synthetic source',
    uri: 'vibespace://source/1',
    accountId: 'account-1',
    projectId: 'project-1',
    trust: 'app_verified',
    origin: 'app_observed',
    sensitivity: 'private',
    observedAt: 100,
    contentHash: 'source-hash-1',
  };
}

function validContextPack(): JarvisContextPack {
  return {
    items: [
      {
        source: validSourceRef(),
        purpose: 'answer',
        excerpt: 'Synthetic excerpt',
        score: 0.75,
        truncated: false,
      },
    ],
    budget: {
      maxChars: 4_000,
      usedChars: 120,
    },
    exclusions: [
      {
        source: {
          ...validSourceRef(),
          id: 'source-2',
          contentHash: 'source-hash-2',
        },
        reason: 'Synthetic exclusion',
      },
    ],
  };
}

function validCapabilityRef(id = 'capability-1'): JarvisCapabilityRef {
  return {
    id,
    state: 'authenticated',
    operations: ['read', 'write'],
    evidenceRef: `${id}-evidence`,
    lastVerifiedAt: 200,
  };
}

function validEntitlementSnapshot(): JarvisEntitlementSnapshot {
  return {
    source: 'server',
    planId: 'plan-1',
    capabilities: ['kernel.read', 'kernel.write'],
    verifiedAt: 210,
    expiresAt: 310,
  };
}

function validCapabilitySnapshot(): JarvisCapabilitySnapshot {
  return {
    capturedAt: 220,
    tools: [validCapabilityRef('tool-1')],
    plugins: [validCapabilityRef('plugin-1')],
    mcps: [validCapabilityRef('mcp-1')],
    terminals: [validCapabilityRef('terminal-1')],
    agents: [validCapabilityRef('agent-capability-1')],
    entitlements: validEntitlementSnapshot(),
  };
}

function validActionSchemaSnapshot() {
  return {
    id: 'terminal.run',
    version: 1,
    title: 'Run command',
    description: 'Run one approved command.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Exact command.' },
        paneId: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
      oneOf: [
        {
          type: 'object',
          required: ['command'],
        },
        {
          type: 'object',
          required: ['paneId'],
        },
      ],
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: true,
    },
    requiredCapabilities: ['terminal.execute'],
    requiredEntitlements: [],
    risk: 'destructive',
    approval: 'always',
    expectedEffect: 'Starts one terminal process.',
  };
}

function validModelSnapshot(): JarvisModelSnapshot {
  return {
    connectionId: 'connection-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    connectionMode: 'native-api',
    capabilities: {
      tools: true,
      vision: false,
    },
    effectiveTemperature: 0.25,
    capturedAt: 230,
  };
}

function validOutputContract(): JarvisOutputContract {
  return {
    preserveStructuredBlocks: true,
    allowActionBlocks: true,
    allowPlanBlocks: true,
    allowQuestionBlocks: true,
    allowPermissionBlocks: true,
    voiceDelivery: 'validated_stream',
  };
}

function validRequestEnvelope(): JarvisRequestEnvelope {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    runId: 'run-1',
    accountId: 'account-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    chatId: 'chat-1',
    parentRunId: 'run-parent-1',
    agent: {
      id: 'agent-1',
      slug: 'jarvis',
      builtin: true,
    },
    surface: 'typed_chat',
    interactionMode: 'ask',
    responseModeHint: 'direct_answer',
    userText: 'Synthetic user text',
    messageHistory: [
      {
        role: 'user',
        content: 'Synthetic history text',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Synthetic text part',
          },
        ],
      },
      {
        role: 'system',
        content: [
          {
            type: 'image',
            data: 'c3ludGhldGlj',
            mimeType: 'image/png',
            name: 'synthetic.png',
          },
        ],
      },
    ],
    identity: {
      identityVersion: 1,
      coreHash: 'core-hash-1',
      responseContractHash: 'response-contract-hash-1',
    },
    profile: {
      profileId: 'profile-1',
      revisionId: 'profile-revision-1',
      soulRevisionId: 'soul-revision-1',
      customInstructions: 'Synthetic instructions',
      memoryScope: 'profile',
    },
    capabilities: validCapabilitySnapshot(),
    model: validModelSnapshot(),
    context: validContextPack(),
    outputContract: validOutputContract(),
    createdAt: 240,
  };
}

function validCompiledPrompt(): CompiledJarvisPrompt {
  return {
    schemaVersion: 1,
    layers: [
      {
        id: 'layer-1',
        authority: 'immutable_security',
        sourceRefs: [validSourceRef()],
        content: 'Synthetic layer content',
        contentHash: 'layer-hash-1',
        charCount: 23,
        truncated: false,
      },
    ],
    systemText: 'Synthetic system text',
    providerPrompt: 'Synthetic provider prompt',
    promptHash: 'prompt-hash-1',
    identityVersion: 1,
    profileRevisionId: 'profile-revision-1',
    diagnostics: {
      totalChars: 23,
      omittedSourceRefs: [validSourceRef()],
      warnings: ['Synthetic warning'],
    },
  };
}

function validExecutionState(): JarvisExecutionState {
  return {
    status: 'completed',
    verifiedBy: 'executor',
    lastEventSeq: 2,
  };
}

function validResponseEnvelope(): JarvisResponseEnvelope {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    runId: 'run-1',
    mode: 'direct_answer',
    displayText: 'Synthetic display text',
    spokenText: 'Synthetic spoken text',
    parts: [
      {
        kind: 'text',
        text: 'Synthetic response part',
      },
    ],
    artifactIds: ['artifact-1'],
    sourceRefs: [validSourceRef()],
    executionState: validExecutionState(),
    provider: validModelSnapshot(),
    enforcement: {
      linted: true,
      violations: ['synthetic_violation'],
      repairAttempted: false,
      repairSucceeded: false,
      fallbackUsed: false,
    },
    completedAt: 250,
  };
}

function validRun(): JarvisRun {
  return {
    id: 'run-1',
    accountId: 'account-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    chatId: 'chat-1',
    parentRunId: 'run-parent-1',
    source: 'typed_chat',
    status: 'completed',
    agentId: 'agent-1',
    identityVersion: 1,
    profileRevisionId: 'profile-revision-1',
    model: validModelSnapshot(),
    createdAt: 260,
    updatedAt: 270,
    completedAt: 280,
  };
}

function validScheduledRetrySnapshot(): JarvisScheduledRetrySnapshotV1 {
  const { requestId: _requestId, createdAt: _createdAt, ...request } = validRequestEnvelope();
  return {
    schemaVersion: 1,
    accountId: 'account-1',
    eventId: 'event-schedule-1',
    occurrenceId: 'jocc_0123456789abcdef',
    dueAt: 300,
    logicalAttempt: 0,
    request: {
      ...request,
      surface: 'schedule',
    },
  };
}

function validHiveStackPlan(): JarvisHiveStackPlanV1 {
  return {
    schemaVersion: 1,
    accountId: 'account-1',
    parentRunId: 'run-1',
    stackId: 'stack-1',
    steps: [
      {
        schemaVersion: 1,
        stepId: 'step-1',
        label: 'Research',
        workerId: 'worker-1',
        agent: {
          id: 'agent-1',
          slug: 'researcher',
          builtin: true,
          name: 'Researcher',
          description: 'Research specialist',
          systemPrompt: 'Preserve this specialist prompt.',
          toolsAllowed: [],
          memoryScope: 'workspace',
          capabilities: ['research'],
          createdAt: 200,
          updatedAt: 210,
        },
        model: validModelSnapshot(),
        messages: [{ role: 'user', content: 'Research this topic.' }],
      },
    ],
  };
}

function validEvent(): JarvisEvent {
  return {
    runId: 'run-1',
    seq: 1,
    idempotencyKey: 'event-delivery-1',
    type: 'message',
    status: 'completed',
    title: 'Synthetic event',
    safeSummary: 'Synthetic event summary',
    sourceRefs: [validSourceRef()],
    artifactIds: ['artifact-1'],
    createdAt: 290,
  };
}

function validApproval(): JarvisApprovalV1 {
  return {
    schemaVersion: 1,
    id: 'approval-1',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 2,
    actionId: 'action-1',
    actionVersion: 1,
    capabilityId: 'files.read',
    capabilitySnapshotHash: 'capability-snapshot-hash-1',
    expectedEffect: 'Reads one file without modifying it.',
    expiresAt: 1_000,
    params: {
      target: 'synthetic-target',
      options: {
        enabled: true,
      },
    },
    secretHandleRefs: [
      {
        field: 'credentialField',
        handleId: 'handle-1',
      },
    ],
    paramsHash: 'params-hash-1',
    targetSnapshot: {
      version: 1,
      labels: ['synthetic'],
    },
    risk: 'confirm',
    status: 'approved',
    createdAt: 300,
    decidedAt: 310,
    consumedAt: 320,
  };
}

function validArtifact(): JarvisArtifactV1 {
  return {
    schemaVersion: 1,
    id: 'artifact-1',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 1,
    state: 'ready',
    kind: 'document',
    title: 'Synthetic artifact',
    uri: 'vibespace://artifact/1',
    mimeType: 'text/markdown',
    safeSummary: 'Synthetic artifact summary',
    contentHash: 'a'.repeat(64),
    sizeBytes: 18,
    preview: {
      kind: 'text',
      text: 'Synthetic artifact',
      truncated: false,
      sizeBytes: 18,
    },
    localReference: { kind: 'message_part', value: 'provider-result-1' },
    sourceRefs: [validSourceRef()],
    createdAt: 330,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function valueAt(root: unknown, path: Path): unknown {
  let current = root;
  for (const segment of path) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function setAt(root: unknown, path: Path, value: unknown): unknown {
  const copy = cloneJson(root);
  if (path.length === 0) return value;
  const parent = valueAt(copy, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = value;
  return copy;
}

function deleteAt(root: unknown, path: Path): unknown {
  const copy = cloneJson(root);
  const parent = valueAt(copy, path.slice(0, -1)) as Record<string | number, unknown>;
  delete parent[path[path.length - 1]!];
  return copy;
}

function addOwnField(root: unknown, parentPath: Path, key: string, value: unknown): unknown {
  const copy = cloneJson(root);
  const parent = valueAt(copy, parentPath) as Record<string, unknown>;
  parent[key] = value;
  return copy;
}

function expectSuccess<T>(result: JarvisContractValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected validation success.');
  }
  return result.value;
}

function expectFailure(
  result: JarvisContractValidationResult<unknown>,
  code: JarvisContractValidationErrorCode,
  path: Path,
): readonly JarvisContractValidationError[] {
  expect(result.ok).toBe(false);
  expect('value' in result).toBe(false);
  if (result.ok) {
    throw new Error('Expected validation failure.');
  }
  expect(result.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        path,
      }),
    ]),
  );
  return result.errors;
}

const publicValidators = [
  {
    label: 'source reference',
    fixture: validSourceRef,
    validate: validateJarvisSourceRef as Validator,
  },
  {
    label: 'context pack',
    fixture: validContextPack,
    validate: validateJarvisContextPack as Validator,
  },
  {
    label: 'capability snapshot',
    fixture: validCapabilitySnapshot,
    validate: validateJarvisCapabilitySnapshot as Validator,
  },
  {
    label: 'model snapshot',
    fixture: validModelSnapshot,
    validate: validateJarvisModelSnapshot as Validator,
  },
  {
    label: 'request envelope',
    fixture: validRequestEnvelope,
    validate: validateJarvisRequestEnvelope as Validator,
  },
  {
    label: 'compiled prompt',
    fixture: validCompiledPrompt,
    validate: validateCompiledJarvisPrompt as Validator,
  },
  {
    label: 'response envelope',
    fixture: validResponseEnvelope,
    validate: validateJarvisResponseEnvelope as Validator,
  },
  {
    label: 'run',
    fixture: validRun,
    validate: validateJarvisRun as Validator,
  },
  {
    label: 'event',
    fixture: validEvent,
    validate: validateJarvisEvent as Validator,
  },
  {
    label: 'approval',
    fixture: validApproval,
    validate: validateJarvisApproval as Validator,
  },
  {
    label: 'artifact',
    fixture: validArtifact,
    validate: validateJarvisArtifact as Validator,
  },
] as const;

describe('Task 3 public contract barrel', () => {
  it('exports the exact validation error and result contracts', () => {
    type ExpectedError = {
      code: (typeof validationErrorCodes)[number];
      path: readonly (string | number)[];
      message: string;
    };
    type ExpectedResult<T> =
      | { ok: true; value: T }
      | { ok: false; errors: readonly ExpectedError[] };

    expectTypeOf<JarvisContractValidationError>().toEqualTypeOf<ExpectedError>();
    expectTypeOf<JarvisContractValidationResult<string>>().toEqualTypeOf<ExpectedResult<string>>();
    expectTypeOf<JarvisContractValidationErrorCode>().toEqualTypeOf<
      (typeof validationErrorCodes)[number]
    >();
  });

  it('exports every validator with the exact unknown-input result signature', () => {
    expectTypeOf(validateJarvisRequestEnvelope).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisRequestEnvelope>
    >();
    expectTypeOf(validateCompiledJarvisPrompt).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<CompiledJarvisPrompt>
    >();
    expectTypeOf(validateJarvisSourceRef).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisSourceRef>
    >();
    expectTypeOf(validateJarvisContextPack).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisContextPack>
    >();
    expectTypeOf(validateJarvisCapabilitySnapshot).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisCapabilitySnapshot>
    >();
    expectTypeOf(validateJarvisModelSnapshot).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisModelSnapshot>
    >();
    expectTypeOf(validateJarvisResponseEnvelope).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisResponseEnvelope>
    >();
    expectTypeOf(validateJarvisRun).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisRun>
    >();
    expectTypeOf(validateJarvisEvent).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisEvent>
    >();
    expectTypeOf(validateJarvisApproval).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisApprovalV1>
    >();
    expectTypeOf(validateJarvisArtifact).toEqualTypeOf<
      (input: unknown) => JarvisContractValidationResult<JarvisArtifactV1>
    >();
  });

  it('exports every named public enum type through the barrel', () => {
    expectTypeOf<PromptAuthority>().toEqualTypeOf<CompiledPromptLayer['authority']>();
    expectTypeOf<JarvisSourceKind>().toEqualTypeOf<JarvisSourceRef['kind']>();
    expectTypeOf<JarvisResponseMode>().toEqualTypeOf<JarvisResponseEnvelope['mode']>();
    expectTypeOf<JarvisRunStatus>().toEqualTypeOf<JarvisRun['status']>();
  });
});

describe('Task 17 scheduled retry snapshot validation', () => {
  it('accepts the complete account-bound schedule request snapshot on a schedule run', () => {
    const run: JarvisRun = {
      ...validRun(),
      source: 'schedule',
      scheduledRetrySnapshot: validScheduledRetrySnapshot(),
    };
    expectSuccess(validateJarvisRun(run));
  });

  it('rejects transport fields, nested request corruption, and crossed run lineage', () => {
    const snapshot = validScheduledRetrySnapshot();
    const requestWithTransport = {
      ...snapshot.request,
      requestId: 'forbidden-request-id',
    };
    expect(
      validateJarvisRun({
        ...validRun(),
        source: 'schedule',
        scheduledRetrySnapshot: { ...snapshot, request: requestWithTransport },
      }).ok,
    ).toBe(false);

    const brokenModel = {
      ...snapshot.request,
      model: { ...snapshot.request.model, providerId: '' },
    };
    expect(
      validateJarvisRun({
        ...validRun(),
        source: 'schedule',
        scheduledRetrySnapshot: { ...snapshot, request: brokenModel },
      }).ok,
    ).toBe(false);

    expect(
      validateJarvisRun({
        ...validRun(),
        accountId: 'account-other',
        source: 'schedule',
        scheduledRetrySnapshot: snapshot,
      }).ok,
    ).toBe(false);
  });

  it('rejects raw credentials and secret-handle identifiers inside the persisted request', () => {
    for (const userText of [
      'Authorization: Bearer synthetic-private-value',
      'api_key=synthetic-private-value',
      'reuse jsecret_synthetic_handle',
    ]) {
      const snapshot = validScheduledRetrySnapshot();
      expect(
        validateJarvisRun({
          ...validRun(),
          source: 'schedule',
          scheduledRetrySnapshot: {
            ...snapshot,
            request: { ...snapshot.request, userText },
          },
        }).ok,
      ).toBe(false);
    }
  });
});

describe('Task 17 persisted Hive stack plan validation', () => {
  it('accepts an exact account-bound Hive final plan and rejects crossed lineage', () => {
    expectSuccess(
      validateJarvisRun({
        ...validRun(),
        source: 'hive_final',
        hiveStackPlan: validHiveStackPlan(),
      }),
    );
    expect(
      validateJarvisRun({
        ...validRun(),
        source: 'hive_final',
        hiveStackPlan: { ...validHiveStackPlan(), parentRunId: 'run-other' },
      }).ok,
    ).toBe(false);
  });

  it('rejects duplicate steps, unknown fields, and nested credential material', () => {
    const plan = validHiveStackPlan();
    expect(
      validateJarvisRun({
        ...validRun(),
        source: 'hive_final',
        hiveStackPlan: { ...plan, steps: [plan.steps[0]!, plan.steps[0]!] },
      }).ok,
    ).toBe(false);
    expect(
      validateJarvisRun({
        ...validRun(),
        source: 'hive_final',
        hiveStackPlan: {
          ...plan,
          steps: [
            {
              ...plan.steps[0]!,
              messages: [{ role: 'user', content: 'Authorization: Bearer synthetic-value' }],
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });
});

describe('valid construction and JSON round trips', () => {
  for (const { label, fixture, validate } of publicValidators) {
    it(`accepts a canonical ${label}, returns it by reference, and accepts its JSON round trip`, () => {
      const input = fixture();
      const result = validate(input);

      expect(expectSuccess(result)).toBe(input);

      const roundTrip = JSON.parse(JSON.stringify(input)) as unknown;
      expectSuccess(validate(roundTrip));
    });
  }

  it('accepts a closed model-visible action schema snapshot', () => {
    const input = {
      ...validCapabilitySnapshot(),
      actionSchemas: [validActionSchemaSnapshot()],
    };

    expectSuccess(validateJarvisCapabilitySnapshot(input));
    expectSuccess(validateJarvisCapabilitySnapshot(JSON.parse(JSON.stringify(input))));
  });

  it('rejects conflicting model-visible action schema IDs', () => {
    const schema = validActionSchemaSnapshot();
    const result = validateJarvisCapabilitySnapshot({
      ...validCapabilitySnapshot(),
      actionSchemas: [schema, { ...schema, title: 'Conflicting title' }],
    });

    expectFailure(result, 'invalid_type', ['actionSchemas']);
  });

  it('rejects empty and oversized model-visible oneOf branches', () => {
    const empty = validActionSchemaSnapshot();
    empty.inputSchema.oneOf = [];
    expectFailure(
      validateJarvisCapabilitySnapshot({
        ...validCapabilitySnapshot(),
        actionSchemas: [empty],
      }),
      'invalid_type',
      ['actionSchemas', 0, 'inputSchema', 'oneOf'],
    );

    const oversized = validActionSchemaSnapshot();
    oversized.inputSchema.oneOf = Array.from({ length: 9 }, () => ({
      type: 'object' as const,
      required: ['command'],
    }));
    expectFailure(
      validateJarvisCapabilitySnapshot({
        ...validCapabilitySnapshot(),
        actionSchemas: [oversized],
      }),
      'invalid_type',
      ['actionSchemas', 0, 'inputSchema', 'oneOf'],
    );
  });

  it('accepts every optional field both present and absent', () => {
    const cases: {
      input: unknown;
      optionalPaths: readonly Path[];
      validate: Validator;
    }[] = [
      {
        input: validSourceRef(),
        optionalPaths: [['uri'], ['projectId'], ['origin'], ['observedAt'], ['contentHash']],
        validate: validateJarvisSourceRef as Validator,
      },
      {
        input: validCapabilitySnapshot(),
        optionalPaths: [
          ['tools', 0, 'evidenceRef'],
          ['tools', 0, 'lastVerifiedAt'],
          ['entitlements', 'planId'],
          ['entitlements', 'verifiedAt'],
          ['entitlements', 'expiresAt'],
        ],
        validate: validateJarvisCapabilitySnapshot as Validator,
      },
      {
        input: validModelSnapshot(),
        optionalPaths: [['connectionId'], ['effectiveTemperature']],
        validate: validateJarvisModelSnapshot as Validator,
      },
      {
        input: validRequestEnvelope(),
        optionalPaths: [
          ['workspaceId'],
          ['projectId'],
          ['chatId'],
          ['parentRunId'],
          ['responseModeHint'],
          ['profile', 'soulRevisionId'],
        ],
        validate: validateJarvisRequestEnvelope as Validator,
      },
      {
        input: validCompiledPrompt(),
        optionalPaths: [['providerPrompt']],
        validate: validateCompiledJarvisPrompt as Validator,
      },
      {
        input: validResponseEnvelope(),
        optionalPaths: [['spokenText'], ['executionState']],
        validate: validateJarvisResponseEnvelope as Validator,
      },
      {
        input: validRun(),
        optionalPaths: [
          ['workspaceId'],
          ['projectId'],
          ['chatId'],
          ['parentRunId'],
          ['completedAt'],
        ],
        validate: validateJarvisRun as Validator,
      },
      {
        input: validEvent(),
        optionalPaths: [['status'], ['safeSummary']],
        validate: validateJarvisEvent as Validator,
      },
      {
        input: validApproval(),
        optionalPaths: [['secretHandleRefs'], ['targetSnapshot'], ['decidedAt'], ['consumedAt']],
        validate: validateJarvisApproval as Validator,
      },
      {
        input: validArtifact(),
        optionalPaths: [
          ['uri'],
          ['mimeType'],
          ['safeSummary'],
          ['contentHash'],
          ['sizeBytes'],
          ['preview'],
          ['localReference'],
        ],
        validate: validateJarvisArtifact as Validator,
      },
    ];

    for (const testCase of cases) {
      let withoutOptionals = testCase.input;
      for (const path of testCase.optionalPaths) {
        withoutOptionals = deleteAt(withoutOptionals, path);
      }
      expectSuccess(testCase.validate(withoutOptionals));
    }
  });
});

describe('required literals', () => {
  const literalCases: {
    label: string;
    input: unknown;
    validate: Validator;
    path: Path;
  }[] = [
    {
      label: 'request schema version',
      input: validRequestEnvelope(),
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['schemaVersion'],
    },
    {
      label: 'compiled prompt schema version',
      input: validCompiledPrompt(),
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['schemaVersion'],
    },
    {
      label: 'response schema version',
      input: validResponseEnvelope(),
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['schemaVersion'],
    },
  ];

  for (const testCase of literalCases) {
    it(`requires ${testCase.label} and does not coerce it`, () => {
      expectFailure(
        testCase.validate(deleteAt(testCase.input, testCase.path)),
        'missing_field',
        testCase.path,
      );
      expectFailure(
        testCase.validate(setAt(testCase.input, testCase.path, 2)),
        'invalid_type',
        testCase.path,
      );
      expectFailure(
        testCase.validate(setAt(testCase.input, testCase.path, '1')),
        'invalid_type',
        testCase.path,
      );
    });
  }

  it('requires preserveStructuredBlocks to be the literal true', () => {
    const input = validRequestEnvelope();
    const path = ['outputContract', 'preserveStructuredBlocks'] as const;
    expectFailure(validateJarvisRequestEnvelope(deleteAt(input, path)), 'missing_field', path);
    expectFailure(validateJarvisRequestEnvelope(setAt(input, path, false)), 'invalid_type', path);
    expectFailure(validateJarvisRequestEnvelope(setAt(input, path, 'true')), 'invalid_type', path);
  });
});

describe('missing required fields', () => {
  const families: {
    label: string;
    input: () => unknown;
    validate: Validator;
    parentPath: Path;
    fields: readonly string[];
  }[] = [
    {
      label: 'request root',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: [],
      fields: [
        'schemaVersion',
        'requestId',
        'runId',
        'accountId',
        'agent',
        'surface',
        'interactionMode',
        'userText',
        'messageHistory',
        'identity',
        'profile',
        'capabilities',
        'model',
        'context',
        'outputContract',
        'createdAt',
      ],
    },
    {
      label: 'request agent',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['agent'],
      fields: ['id', 'slug', 'builtin'],
    },
    {
      label: 'LLM message',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 0],
      fields: ['role', 'content'],
    },
    {
      label: 'LLM text part',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 1, 'content', 0],
      fields: ['type', 'text'],
    },
    {
      label: 'LLM image part',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 2, 'content', 0],
      fields: ['type', 'data', 'mimeType'],
    },
    {
      label: 'identity snapshot',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['identity'],
      fields: ['identityVersion', 'coreHash', 'responseContractHash'],
    },
    {
      label: 'profile snapshot',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['profile'],
      fields: ['profileId', 'revisionId', 'customInstructions', 'memoryScope'],
    },
    {
      label: 'compiled prompt root',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: [],
      fields: [
        'schemaVersion',
        'layers',
        'systemText',
        'promptHash',
        'identityVersion',
        'profileRevisionId',
        'diagnostics',
      ],
    },
    {
      label: 'compiled prompt layer',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: ['layers', 0],
      fields: ['id', 'authority', 'sourceRefs', 'content', 'contentHash', 'charCount', 'truncated'],
    },
    {
      label: 'compiled prompt diagnostics',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: ['diagnostics'],
      fields: ['totalChars', 'omittedSourceRefs', 'warnings'],
    },
    {
      label: 'source reference',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      parentPath: [],
      fields: ['id', 'kind', 'label', 'accountId', 'trust', 'sensitivity'],
    },
    {
      label: 'context pack root',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: [],
      fields: ['items', 'budget', 'exclusions'],
    },
    {
      label: 'context item',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['items', 0],
      fields: ['source', 'purpose', 'excerpt', 'truncated'],
    },
    {
      label: 'context budget',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['budget'],
      fields: ['maxChars', 'usedChars'],
    },
    {
      label: 'context exclusion',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['exclusions', 0],
      fields: ['source', 'reason'],
    },
    {
      label: 'capability snapshot root',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: [],
      fields: ['capturedAt', 'tools', 'plugins', 'mcps', 'terminals', 'agents', 'entitlements'],
    },
    {
      label: 'capability reference',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: ['tools', 0],
      fields: ['id', 'state', 'operations'],
    },
    {
      label: 'entitlement snapshot',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: ['entitlements'],
      fields: ['source', 'capabilities'],
    },
    {
      label: 'model snapshot',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      parentPath: [],
      fields: ['providerId', 'modelId', 'connectionMode', 'capabilities', 'capturedAt'],
    },
    {
      label: 'output contract',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['outputContract'],
      fields: [
        'preserveStructuredBlocks',
        'allowActionBlocks',
        'allowPlanBlocks',
        'allowQuestionBlocks',
        'allowPermissionBlocks',
        'voiceDelivery',
      ],
    },
    {
      label: 'response root',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: [],
      fields: [
        'schemaVersion',
        'requestId',
        'runId',
        'mode',
        'displayText',
        'parts',
        'artifactIds',
        'sourceRefs',
        'provider',
        'enforcement',
        'completedAt',
      ],
    },
    {
      label: 'execution state',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: ['executionState'],
      fields: ['status', 'verifiedBy', 'lastEventSeq'],
    },
    {
      label: 'response enforcement',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: ['enforcement'],
      fields: ['linted', 'violations', 'repairAttempted', 'repairSucceeded', 'fallbackUsed'],
    },
    {
      label: 'run',
      input: validRun,
      validate: validateJarvisRun as Validator,
      parentPath: [],
      fields: [
        'id',
        'accountId',
        'source',
        'status',
        'agentId',
        'identityVersion',
        'profileRevisionId',
        'model',
        'createdAt',
        'updatedAt',
      ],
    },
    {
      label: 'event',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      parentPath: [],
      fields: [
        'runId',
        'seq',
        'idempotencyKey',
        'type',
        'title',
        'sourceRefs',
        'artifactIds',
        'createdAt',
      ],
    },
    {
      label: 'approval',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      parentPath: [],
      fields: [
        'schemaVersion',
        'id',
        'runId',
        'requestId',
        'attemptNumber',
        'actionId',
        'actionVersion',
        'capabilityId',
        'capabilitySnapshotHash',
        'expectedEffect',
        'expiresAt',
        'params',
        'paramsHash',
        'risk',
        'status',
        'createdAt',
      ],
    },
    {
      label: 'approval secret handle',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      parentPath: ['secretHandleRefs', 0],
      fields: ['field', 'handleId'],
    },
    {
      label: 'artifact',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      parentPath: [],
      fields: [
        'schemaVersion',
        'id',
        'runId',
        'requestId',
        'attemptNumber',
        'state',
        'kind',
        'title',
        'sourceRefs',
        'createdAt',
      ],
    },
  ];

  for (const family of families) {
    for (const field of family.fields) {
      it(`rejects missing ${family.label}.${field}`, () => {
        const path = [...family.parentPath, field];
        expectFailure(family.validate(deleteAt(family.input(), path)), 'missing_field', path);
      });
    }
  }
});

describe('wrong primitive and container types', () => {
  const cases: {
    label: string;
    input: () => unknown;
    validate: Validator;
    path: Path;
    replacement: unknown;
  }[] = [
    {
      label: 'request root object',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: [],
      replacement: [],
    },
    {
      label: 'request agent object',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['agent'],
      replacement: [],
    },
    {
      label: 'request agent builtin boolean',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['agent', 'builtin'],
      replacement: 'true',
    },
    {
      label: 'request message history array',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['messageHistory'],
      replacement: {},
    },
    {
      label: 'LLM content shape',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['messageHistory', 0, 'content'],
      replacement: {},
    },
    {
      label: 'prompt layers array',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['layers'],
      replacement: {},
    },
    {
      label: 'prompt layer content string',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['layers', 0, 'content'],
      replacement: false,
    },
    {
      label: 'source label string',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['label'],
      replacement: 7,
    },
    {
      label: 'context root object',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: [],
      replacement: null,
    },
    {
      label: 'context item source object',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['items', 0, 'source'],
      replacement: 'source',
    },
    {
      label: 'context item truncated boolean',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['items', 0, 'truncated'],
      replacement: 0,
    },
    {
      label: 'capability collection array',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['tools'],
      replacement: 'tools',
    },
    {
      label: 'capability operations array',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['tools', 0, 'operations'],
      replacement: {},
    },
    {
      label: 'model capabilities record',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path: ['capabilities'],
      replacement: [],
    },
    {
      label: 'model capability boolean',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path: ['capabilities', 'tools'],
      replacement: 'yes',
    },
    {
      label: 'response parts array',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['parts'],
      replacement: {},
    },
    {
      label: 'response part record',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['parts', 0],
      replacement: 'text',
    },
    {
      label: 'response part kind string',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['parts', 0, 'kind'],
      replacement: 1,
    },
    {
      label: 'response enforcement boolean',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['enforcement', 'linted'],
      replacement: 'true',
    },
    {
      label: 'run model object',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['model'],
      replacement: [],
    },
    {
      label: 'event artifact IDs array',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['artifactIds'],
      replacement: {},
    },
    {
      label: 'approval secret handles array',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['secretHandleRefs'],
      replacement: {},
    },
    {
      label: 'artifact source refs array',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      path: ['sourceRefs'],
      replacement: 'sources',
    },
  ];

  for (const testCase of cases) {
    it(`rejects wrong type for ${testCase.label}`, () => {
      expectFailure(
        testCase.validate(setAt(testCase.input(), testCase.path, testCase.replacement)),
        'invalid_type',
        testCase.path,
      );
    });
  }
});

describe('enum membership', () => {
  const enumCases: {
    label: string;
    values: readonly string[];
    invalid: string;
    input: () => unknown;
    validate: Validator;
    path: Path;
  }[] = [
    {
      label: 'request surface',
      values: ['typed_chat', 'voice', 'schedule', 'hive_final', 'phone', 'browser_chat'],
      invalid: 'surface_unknown',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['surface'],
    },
    {
      label: 'request interaction mode',
      values: ['ask', 'plan', 'agent'],
      invalid: 'interaction_unknown',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['interactionMode'],
    },
    {
      label: 'response mode hint',
      values: [
        'acknowledgement',
        'direct_answer',
        'status',
        'warning',
        'approval_required',
        'action_running',
        'action_success',
        'action_partial',
        'action_failure',
        'clarification',
        'recommendation',
        'long_form_delivery',
        'sensitive',
      ],
      invalid: 'response_mode_unknown',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['responseModeHint'],
    },
    {
      label: 'LLM role',
      values: ['system', 'user', 'assistant'],
      invalid: 'tool',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['messageHistory', 0, 'role'],
    },
    {
      label: 'profile memory scope',
      values: ['none', 'profile', 'shared_selected'],
      invalid: 'all',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['profile', 'memoryScope'],
    },
    {
      label: 'prompt authority',
      values: [
        'immutable_security',
        'immutable_identity',
        'capability_policy',
        'user_approved_preference',
        'turn_policy',
        'untrusted_context',
        'output_contract',
      ],
      invalid: 'system_override',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['layers', 0, 'authority'],
    },
    {
      label: 'source kind',
      values: [
        'user_message',
        'chat',
        'project',
        'project_file',
        'context_node',
        'memory',
        'terminal',
        'tool_result',
        'plugin',
        'mcp',
        'web',
        'schedule',
        'artifact',
        'agent_output',
      ],
      invalid: 'database',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['kind'],
    },
    {
      label: 'source trust',
      values: ['user_direct', 'app_verified', 'external_untrusted'],
      invalid: 'model_verified',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['trust'],
    },
    {
      label: 'source origin',
      values: ['user_authored', 'app_observed', 'model_inference', 'mixed', 'external_retrieved'],
      invalid: 'system_instruction',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['origin'],
    },
    {
      label: 'source sensitivity',
      values: ['public', 'private', 'restricted', 'secret'],
      invalid: 'internal',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['sensitivity'],
    },
    {
      label: 'context purpose',
      values: ['answer', 'execution', 'preference', 'history', 'capability', 'citation'],
      invalid: 'instruction',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['items', 0, 'purpose'],
    },
    {
      label: 'capability state',
      values: ['available', 'connected', 'authenticated', 'degraded', 'unavailable', 'planned'],
      invalid: 'completed',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['tools', 0, 'state'],
    },
    {
      label: 'entitlement source',
      values: ['server', 'local_development', 'unavailable'],
      invalid: 'client',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['entitlements', 'source'],
    },
    {
      label: 'connection mode',
      values: ['native-api', 'external-cli', 'local'],
      invalid: 'remote-browser',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path: ['connectionMode'],
    },
    {
      label: 'response mode',
      values: [
        'acknowledgement',
        'direct_answer',
        'status',
        'warning',
        'approval_required',
        'action_running',
        'action_success',
        'action_partial',
        'action_failure',
        'clarification',
        'recommendation',
        'long_form_delivery',
        'sensitive',
      ],
      invalid: 'response_mode_unknown',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['mode'],
    },
    {
      label: 'voice delivery',
      values: ['none', 'validated_stream', 'final_summary'],
      invalid: 'raw_stream',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['outputContract', 'voiceDelivery'],
    },
    {
      label: 'execution verifier',
      values: ['journal', 'executor', 'provider'],
      invalid: 'model',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['executionState', 'verifiedBy'],
    },
    {
      label: 'run status',
      values: [
        'queued',
        'compiling',
        'running',
        'awaiting_approval',
        'partial',
        'completed',
        'failed',
        'cancelled',
        'timed_out',
      ],
      invalid: 'stopped',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['status'],
    },
    {
      label: 'event type',
      values: [
        'run_state',
        'model',
        'context',
        'retrieval',
        'tool',
        'terminal',
        'approval',
        'artifact',
        'message',
        'warning',
        'error',
      ],
      invalid: 'debug',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['type'],
    },
    {
      label: 'approval risk',
      values: ['safe', 'confirm', 'dangerous'],
      invalid: 'critical',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['risk'],
    },
    {
      label: 'approval status',
      values: ['pending', 'approved', 'denied', 'expired', 'consumed'],
      invalid: 'executed',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['status'],
    },
    {
      label: 'artifact kind',
      values: [
        'file',
        'link',
        'text',
        'image',
        'document',
        'code',
        'terminal_output',
        'provider_result',
      ],
      invalid: 'source',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      path: ['kind'],
    },
  ];

  for (const testCase of enumCases) {
    it(`accepts every ${testCase.label} and rejects an unknown member`, () => {
      for (const value of testCase.values) {
        expectSuccess(testCase.validate(setAt(testCase.input(), testCase.path, value)));
      }
      expectFailure(
        testCase.validate(setAt(testCase.input(), testCase.path, testCase.invalid)),
        'unknown_enum',
        testCase.path,
      );
    });
  }

  it('accepts exact text and image LLM content parts and rejects an unknown part type', () => {
    const textInput = setAt(
      validRequestEnvelope(),
      ['messageHistory', 0, 'content'],
      [
        {
          type: 'text',
          text: 'Synthetic text',
        },
      ],
    );
    const imageInput = setAt(
      validRequestEnvelope(),
      ['messageHistory', 0, 'content'],
      [
        {
          type: 'image',
          data: 'c3ludGhldGlj',
          mimeType: 'image/png',
          name: 'synthetic.png',
        },
      ],
    );
    expectSuccess(validateJarvisRequestEnvelope(textInput));
    expectSuccess(validateJarvisRequestEnvelope(imageInput));

    const invalid = setAt(
      validRequestEnvelope(),
      ['messageHistory', 0, 'content'],
      [
        {
          type: 'audio',
          text: 'Synthetic audio',
        },
      ],
    );
    expectFailure(validateJarvisRequestEnvelope(invalid), 'unknown_enum', [
      'messageHistory',
      0,
      'content',
      0,
      'type',
    ]);
  });

  it('requires every durable approval v1 binding field and rejects unknown fields', () => {
    for (const field of [
      'schemaVersion',
      'requestId',
      'attemptNumber',
      'capabilityId',
      'capabilitySnapshotHash',
      'expectedEffect',
      'expiresAt',
    ]) {
      const input = { ...validApproval() } as Record<string, unknown>;
      delete input[field];
      expectFailure(validateJarvisApproval(input), 'missing_field', [field]);
    }
    expectFailure(
      validateJarvisApproval({ ...validApproval(), credential: 'never' }),
      'unknown_field',
      ['credential'],
    );
  });

  it('canonicalizes approval JSON deterministically and hashes canonical UTF-8 bytes', async () => {
    expect(canonicalizeJarvisApprovalJson({ z: -0, a: [3, { y: true, x: 'ok' }] })).toBe(
      '{"a":[3,{"x":"ok","y":true}],"z":0}',
    );
    await expect(hashCanonicalJarvisApprovalJson({ b: 2, a: 1 })).resolves.toBe(
      await hashCanonicalJarvisApprovalJson({ a: 1, b: 2 }),
    );
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    () => undefined,
    Symbol('approval'),
    new Date(0),
    [, 1],
  ])('rejects unsupported canonical approval JSON without reflecting payloads', (value) => {
    expect(() => canonicalizeJarvisApprovalJson(value)).toThrow('Invalid canonical approval JSON');
  });

  it('rejects canonical approval JSON cycles', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalizeJarvisApprovalJson(value)).toThrow('Invalid canonical approval JSON');
  });
});

describe('closed and open object boundaries', () => {
  const closedCases: {
    label: string;
    input: () => unknown;
    validate: Validator;
    parentPath: Path;
    key?: string;
  }[] = [
    {
      label: 'request root',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: [],
    },
    {
      label: 'request agent',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['agent'],
      key: 'name',
    },
    {
      label: 'LLM message',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 0],
    },
    {
      label: 'LLM text content part',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 1, 'content', 0],
    },
    {
      label: 'LLM image content part',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['messageHistory', 2, 'content', 0],
    },
    {
      label: 'identity snapshot',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['identity'],
      key: 'immutableRules',
    },
    {
      label: 'profile snapshot',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['profile'],
      key: 'accountId',
    },
    {
      label: 'compiled prompt root',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: [],
    },
    {
      label: 'compiled prompt layer',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: ['layers', 0],
    },
    {
      label: 'compiled prompt diagnostics',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      parentPath: ['diagnostics'],
    },
    {
      label: 'source reference',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      parentPath: [],
    },
    {
      label: 'context pack root',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: [],
    },
    {
      label: 'context item',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['items', 0],
    },
    {
      label: 'context budget',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['budget'],
    },
    {
      label: 'context exclusion',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      parentPath: ['exclusions', 0],
    },
    {
      label: 'capability snapshot root',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: [],
    },
    {
      label: 'capability reference',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: ['tools', 0],
    },
    {
      label: 'entitlement snapshot',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      parentPath: ['entitlements'],
    },
    {
      label: 'model snapshot',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      parentPath: [],
    },
    {
      label: 'output contract',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      parentPath: ['outputContract'],
      key: 'futureVoicePolicy',
    },
    {
      label: 'response root',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: [],
    },
    {
      label: 'execution state',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: ['executionState'],
    },
    {
      label: 'response enforcement',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      parentPath: ['enforcement'],
      key: 'rawProviderText',
    },
    {
      label: 'run',
      input: validRun,
      validate: validateJarvisRun as Validator,
      parentPath: [],
    },
    {
      label: 'event identity',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      parentPath: [],
      key: 'id',
    },
    {
      label: 'approval',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      parentPath: [],
    },
    {
      label: 'approval secret handle',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      parentPath: ['secretHandleRefs', 0],
      key: 'secretValue',
    },
    {
      label: 'artifact',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      parentPath: [],
    },
  ];

  for (const testCase of closedCases) {
    it(`rejects an unknown field on ${testCase.label}`, () => {
      const key = testCase.key ?? 'unexpectedV1Field';
      const input = addOwnField(testCase.input(), testCase.parentPath, key, 'synthetic-extra');
      expectFailure(testCase.validate(input), 'unknown_field', [...testCase.parentPath, key]);
    });
  }

  it.each([
    {
      label: 'function-valued enumerable field',
      input: () => addOwnField(validSourceRef(), [], 'unexpectedV1Field', () => undefined),
    },
    {
      label: 'non-enumerable field',
      input: () => {
        const input = validSourceRef() as JarvisSourceRef & Record<string, unknown>;
        Object.defineProperty(input, 'unexpectedV1Field', {
          configurable: true,
          enumerable: false,
          value: 'synthetic-extra',
        });
        return input;
      },
    },
  ])(
    'prioritizes unknown_field for an unexpected own $label without weakening JSON safety',
    ({ input }) => {
      const path = ['unexpectedV1Field'] as const;
      const errors = expectFailure(validateJarvisSourceRef(input()), 'unknown_field', path);

      expect(errors[0]).toMatchObject({ code: 'unknown_field', path });
      expect(errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'non_json_safe', path })]),
      );
    },
  );

  it('does not invoke an accessor while preserving JSON-safety rejection', () => {
    const input = validSourceRef();
    let reads = 0;
    Object.defineProperty(input, 'label', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return 'Synthetic source';
      },
    });

    expectFailure(validateJarvisSourceRef(input), 'non_json_safe', ['label']);
    expect(reads).toBe(0);
  });

  it('allows JSON-safe open model capabilities, approval payloads, targets, and Part payloads', () => {
    const model = validModelSnapshot();
    model.capabilities.experimentalFlag = true;
    expectSuccess(validateJarvisModelSnapshot(model));

    const approval = validApproval();
    approval.params = {
      arbitrary: {
        nested: [1, true, null, 'synthetic'],
      },
    };
    approval.targetSnapshot = {
      arbitraryTargetField: {
        version: 2,
      },
    };
    expectSuccess(validateJarvisApproval(approval));

    const response = validResponseEnvelope() as unknown as Record<string, unknown>;
    response.parts = [
      {
        kind: 'future_part',
        arbitraryPayload: {
          nested: ['synthetic', 1, false, null],
        },
      },
    ];
    expectSuccess(validateJarvisResponseEnvelope(response));
  });
});

describe('identifier validation', () => {
  const identifierCases: {
    label: string;
    input: () => unknown;
    validate: Validator;
    path: Path;
  }[] = [
    ...[
      ['requestId'],
      ['runId'],
      ['accountId'],
      ['workspaceId'],
      ['projectId'],
      ['chatId'],
      ['parentRunId'],
      ['agent', 'id'],
      ['agent', 'slug'],
      ['identity', 'coreHash'],
      ['identity', 'responseContractHash'],
      ['profile', 'profileId'],
      ['profile', 'revisionId'],
      ['profile', 'soulRevisionId'],
    ].map((path) => ({
      label: `request ${path.join('.')}`,
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path,
    })),
    ...[
      ['layers', 0, 'id'],
      ['layers', 0, 'contentHash'],
      ['promptHash'],
      ['profileRevisionId'],
    ].map((path) => ({
      label: `prompt ${path.join('.')}`,
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path,
    })),
    ...[['id'], ['accountId'], ['projectId'], ['contentHash']].map((path) => ({
      label: `source ${path.join('.')}`,
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path,
    })),
    ...[
      ['tools', 0, 'id'],
      ['tools', 0, 'evidenceRef'],
      ['tools', 0, 'operations', 0],
      ['entitlements', 'planId'],
      ['entitlements', 'capabilities', 0],
    ].map((path) => ({
      label: `capability ${path.join('.')}`,
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path,
    })),
    ...[['connectionId'], ['providerId'], ['modelId']].map((path) => ({
      label: `model ${path.join('.')}`,
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path,
    })),
    ...[['requestId'], ['runId'], ['artifactIds', 0]].map((path) => ({
      label: `response ${path.join('.')}`,
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path,
    })),
    ...[
      ['id'],
      ['accountId'],
      ['workspaceId'],
      ['projectId'],
      ['chatId'],
      ['parentRunId'],
      ['agentId'],
      ['profileRevisionId'],
    ].map((path) => ({
      label: `run ${path.join('.')}`,
      input: validRun,
      validate: validateJarvisRun as Validator,
      path,
    })),
    ...[['runId'], ['idempotencyKey'], ['artifactIds', 0]].map((path) => ({
      label: `event ${path.join('.')}`,
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path,
    })),
    ...[
      ['id'],
      ['runId'],
      ['actionId'],
      ['paramsHash'],
      ['secretHandleRefs', 0, 'field'],
      ['secretHandleRefs', 0, 'handleId'],
    ].map((path) => ({
      label: `approval ${path.join('.')}`,
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path,
    })),
    ...[['id'], ['runId']].map((path) => ({
      label: `artifact ${path.join('.')}`,
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      path,
    })),
  ];

  for (const testCase of identifierCases) {
    it(`rejects empty and whitespace-only ${testCase.label}`, () => {
      for (const invalid of ['', ' \t ']) {
        expectFailure(
          testCase.validate(setAt(testCase.input(), testCase.path, invalid)),
          'invalid_identifier',
          testCase.path,
        );
      }
    });
  }

  it('rejects empty and whitespace-only capability keys', () => {
    for (const key of ['', ' \t ']) {
      const input = validModelSnapshot();
      input.capabilities = { [key]: true };
      expectFailure(validateJarvisModelSnapshot(input), 'invalid_identifier', [
        'capabilities',
        key,
      ]);
    }
  });
});

describe('finite numbers and event sequences', () => {
  const numericCases: {
    label: string;
    input: () => unknown;
    validate: Validator;
    path: Path;
    sequence?: boolean;
  }[] = [
    {
      label: 'request createdAt',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['createdAt'],
    },
    {
      label: 'request identity version',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['identity', 'identityVersion'],
    },
    {
      label: 'prompt layer char count',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['layers', 0, 'charCount'],
    },
    {
      label: 'prompt identity version',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['identityVersion'],
    },
    {
      label: 'prompt total chars',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['diagnostics', 'totalChars'],
    },
    {
      label: 'source observedAt',
      input: validSourceRef,
      validate: validateJarvisSourceRef as Validator,
      path: ['observedAt'],
    },
    {
      label: 'context score',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['items', 0, 'score'],
    },
    {
      label: 'context max chars',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['budget', 'maxChars'],
    },
    {
      label: 'context used chars',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['budget', 'usedChars'],
    },
    {
      label: 'capability capturedAt',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['capturedAt'],
    },
    {
      label: 'capability last verified',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['tools', 0, 'lastVerifiedAt'],
    },
    {
      label: 'entitlement verified',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['entitlements', 'verifiedAt'],
    },
    {
      label: 'entitlement expiry',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['entitlements', 'expiresAt'],
    },
    {
      label: 'model temperature',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path: ['effectiveTemperature'],
    },
    {
      label: 'model capturedAt',
      input: validModelSnapshot,
      validate: validateJarvisModelSnapshot as Validator,
      path: ['capturedAt'],
    },
    {
      label: 'response sequence',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['executionState', 'lastEventSeq'],
      sequence: true,
    },
    {
      label: 'response completedAt',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['completedAt'],
    },
    {
      label: 'run identity version',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['identityVersion'],
    },
    {
      label: 'run createdAt',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['createdAt'],
    },
    {
      label: 'run updatedAt',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['updatedAt'],
    },
    {
      label: 'run completedAt',
      input: validRun,
      validate: validateJarvisRun as Validator,
      path: ['completedAt'],
    },
    {
      label: 'event sequence',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['seq'],
      sequence: true,
    },
    {
      label: 'event createdAt',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['createdAt'],
    },
    {
      label: 'approval action version',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['actionVersion'],
    },
    {
      label: 'approval createdAt',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['createdAt'],
    },
    {
      label: 'approval decidedAt',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['decidedAt'],
    },
    {
      label: 'approval consumedAt',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['consumedAt'],
    },
    {
      label: 'artifact createdAt',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      path: ['createdAt'],
    },
  ];

  for (const testCase of numericCases) {
    it(`rejects non-finite ${testCase.label}`, () => {
      for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expectFailure(
          testCase.validate(setAt(testCase.input(), testCase.path, invalid)),
          'non_finite_number',
          testCase.path,
        );
      }
    });

    if (testCase.sequence) {
      it(`requires ${testCase.label} to be a non-negative integer and accepts zero`, () => {
        expectFailure(
          testCase.validate(setAt(testCase.input(), testCase.path, -1)),
          'invalid_type',
          testCase.path,
        );
        expectFailure(
          testCase.validate(setAt(testCase.input(), testCase.path, 0.5)),
          'invalid_type',
          testCase.path,
        );
        expectSuccess(testCase.validate(setAt(testCase.input(), testCase.path, 0)));
      });
    }
  }
});

describe('nested dense arrays', () => {
  const cases: {
    label: string;
    input: () => unknown;
    validate: Validator;
    path: Path;
    replacement: unknown;
    expectedCode: JarvisContractValidationErrorCode;
  }[] = [
    {
      label: 'message history role',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['messageHistory', 0, 'role'],
      replacement: 'tool',
      expectedCode: 'unknown_enum',
    },
    {
      label: 'LLM text part text',
      input: validRequestEnvelope,
      validate: validateJarvisRequestEnvelope as Validator,
      path: ['messageHistory', 1, 'content', 0, 'text'],
      replacement: false,
      expectedCode: 'invalid_type',
    },
    {
      label: 'prompt source ref account',
      input: validCompiledPrompt,
      validate: validateCompiledJarvisPrompt as Validator,
      path: ['layers', 0, 'sourceRefs', 0, 'accountId'],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'context source trust',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['items', 0, 'source', 'trust'],
      replacement: 'trusted',
      expectedCode: 'unknown_enum',
    },
    {
      label: 'context exclusion reason',
      input: validContextPack,
      validate: validateJarvisContextPack as Validator,
      path: ['exclusions', 0, 'reason'],
      replacement: 7,
      expectedCode: 'invalid_type',
    },
    {
      label: 'capability operation',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['tools', 0, 'operations', 1],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'entitlement capability',
      input: validCapabilitySnapshot,
      validate: validateJarvisCapabilitySnapshot as Validator,
      path: ['entitlements', 'capabilities', 0],
      replacement: ' ',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'response artifact ID',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['artifactIds', 0],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'response source account',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['sourceRefs', 0, 'accountId'],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'response violation string',
      input: validResponseEnvelope,
      validate: validateJarvisResponseEnvelope as Validator,
      path: ['enforcement', 'violations', 0],
      replacement: false,
      expectedCode: 'invalid_type',
    },
    {
      label: 'event source account',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['sourceRefs', 0, 'accountId'],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'event artifact ID',
      input: validEvent,
      validate: validateJarvisEvent as Validator,
      path: ['artifactIds', 0],
      replacement: ' ',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'approval handle ID',
      input: validApproval,
      validate: validateJarvisApproval as Validator,
      path: ['secretHandleRefs', 0, 'handleId'],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
    {
      label: 'artifact source account',
      input: validArtifact,
      validate: validateJarvisArtifact as Validator,
      path: ['sourceRefs', 0, 'accountId'],
      replacement: '',
      expectedCode: 'invalid_identifier',
    },
  ];

  for (const testCase of cases) {
    it(`reports the exact array index path for ${testCase.label}`, () => {
      expectFailure(
        testCase.validate(setAt(testCase.input(), testCase.path, testCase.replacement)),
        testCase.expectedCode,
        testCase.path,
      );
    });
  }

  it('rejects sparse arrays at the missing index', () => {
    const input = validApproval();
    const sparse = ['first', , 'third'];
    input.params = {
      nested: sparse,
    };
    expectFailure(validateJarvisApproval(input), 'non_json_safe', ['params', 'nested', 1]);
  });
});

describe('deep JSON safety', () => {
  const DEEP_JSON_DEPTH = 6_000;

  function deepJsonRecord(leafKey: string, leafValue: unknown): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < DEEP_JSON_DEPTH; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor.nested = nested;
      cursor = nested;
    }
    cursor[leafKey] = leafValue;
    return root;
  }

  class SyntheticClass {
    value = 'synthetic';
  }

  function invalidValues(): {
    label: string;
    value: unknown;
    relativePath: Path;
  }[] {
    const symbolKeyed = { safe: true } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol('synthetic')] = true;

    const sparse = ['first', , 'third'];

    const arrayWithExtra = ['first'] as unknown[] & { extra?: string };
    arrayWithExtra.extra = 'synthetic';

    const accessor = {};
    Object.defineProperty(accessor, 'derived', {
      enumerable: true,
      get: () => 'synthetic',
    });

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, 'hidden', {
      enumerable: false,
      value: 'synthetic',
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('synthetic proxy failure');
        },
      },
    );

    const throwingArrayProxy = new Proxy(['synthetic'], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('synthetic array proxy failure');
        return Reflect.get(target, property, receiver);
      },
    });

    return [
      { label: 'function', value: () => undefined, relativePath: [] },
      { label: 'custom class', value: new SyntheticClass(), relativePath: [] },
      { label: 'Date', value: new Date(0), relativePath: [] },
      { label: 'symbol value', value: Symbol('synthetic'), relativePath: [] },
      { label: 'symbol-keyed property', value: symbolKeyed, relativePath: [] },
      { label: 'bigint', value: 1n, relativePath: [] },
      { label: 'undefined', value: undefined, relativePath: [] },
      { label: 'sparse array', value: sparse, relativePath: [1] },
      { label: 'array extra property', value: arrayWithExtra, relativePath: ['extra'] },
      { label: 'accessor', value: accessor, relativePath: ['derived'] },
      { label: 'non-enumerable property', value: nonEnumerable, relativePath: ['hidden'] },
      { label: 'cycle', value: cyclic, relativePath: ['self'] },
      { label: 'throwing proxy', value: throwingProxy, relativePath: [] },
      { label: 'throwing array proxy', value: throwingArrayProxy, relativePath: [] },
    ];
  }

  for (const invalid of invalidValues()) {
    it(`rejects a ${invalid.label} at the root`, () => {
      expectFailure(validateJarvisApproval(invalid.value), 'non_json_safe', invalid.relativePath);
    });

    it(`rejects a ${invalid.label} inside an open approval payload`, () => {
      const input = validApproval();
      input.params = {
        nested: invalid.value,
      };
      expectFailure(validateJarvisApproval(input), 'non_json_safe', [
        'params',
        'nested',
        ...invalid.relativePath,
      ]);
    });
  }

  it('rejects arrays with symbol properties', () => {
    const input = validApproval();
    const value = ['synthetic'] as unknown[] & Record<PropertyKey, unknown>;
    value[Symbol('synthetic')] = true;
    input.params = value;
    expectFailure(validateJarvisApproval(input), 'non_json_safe', ['params']);
  });

  it('accepts null-prototype records and repeated non-cyclic shared children', () => {
    const shared = Object.assign(Object.create(null) as Record<string, unknown>, {
      value: 'synthetic',
    });
    const input = validApproval();
    input.params = Object.assign(Object.create(null) as Record<string, unknown>, {
      first: shared,
      second: shared,
    });

    const result = validateJarvisApproval(input);
    expect(expectSuccess(result)).toBe(input);
    expect((input.params as Record<string, unknown>).first).toBe(shared);
    expect((input.params as Record<string, unknown>).second).toBe(shared);
  });

  it('validates a deeply nested JSON-safe open payload without throwing or cloning', () => {
    const input = validApproval();
    input.params = deepJsonRecord('value', 'synthetic');

    let result: JarvisContractValidationResult<JarvisApprovalV1> | undefined;
    expect(() => {
      result = validateJarvisApproval(input);
    }).not.toThrow();

    expect(expectSuccess(result!)).toBe(input);
  });

  it('reports the exact path for a deeply nested invalid leaf without throwing', () => {
    const input = validApproval();
    input.params = deepJsonRecord('invalid', undefined);
    const expectedPath = [
      'params',
      ...Array.from({ length: DEEP_JSON_DEPTH }, () => 'nested'),
      'invalid',
    ];

    let result: JarvisContractValidationResult<JarvisApprovalV1> | undefined;
    expect(() => {
      result = validateJarvisApproval(input);
    }).not.toThrow();

    expectFailure(result!, 'non_json_safe', expectedPath);
  });

  it('rejects a deeply nested cycle without throwing', () => {
    const input = validApproval();
    const params = deepJsonRecord('value', 'synthetic');
    let cursor = params;
    for (let depth = 0; depth < DEEP_JSON_DEPTH; depth += 1) {
      cursor = cursor.nested as Record<string, unknown>;
    }
    cursor.cycle = params;
    input.params = params;
    const expectedPath = [
      'params',
      ...Array.from({ length: DEEP_JSON_DEPTH }, () => 'nested'),
      'cycle',
    ];

    let result: JarvisContractValidationResult<JarvisApprovalV1> | undefined;
    expect(() => {
      result = validateJarvisApproval(input);
    }).not.toThrow();

    expectFailure(result!, 'non_json_safe', expectedPath);
  });

  it('uses numeric paths for malformed canonical array indexes', () => {
    const input = validApproval();
    const value = ['synthetic'];
    Object.defineProperty(value, '0', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: 'synthetic',
    });
    input.params = value;

    expectFailure(validateJarvisApproval(input), 'non_json_safe', ['params', 0]);
  });

  it('fails closed when an array proxy revokes itself during inspection', () => {
    let revoke: () => void = () => undefined;
    const revocable = Proxy.revocable(['synthetic'], {
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        revoke();
        return keys;
      },
    });
    revoke = revocable.revoke;

    let result: JarvisContractValidationResult<JarvisApprovalV1> | undefined;
    expect(() => {
      result = validateJarvisApproval(revocable.proxy);
    }).not.toThrow();

    expectFailure(result!, 'non_json_safe', []);
  });
});

describe('same-reference success and validator purity', () => {
  it('returns the same mutable request and every nested reference without normalization or defaults', () => {
    const identity = Object.freeze({
      identityVersion: 1,
      coreHash: 'core-hash-1',
      responseContractHash: 'response-contract-hash-1',
    });
    const profile = Object.freeze({
      profileId: 'profile-1',
      revisionId: 'profile-revision-1',
      customInstructions: '  keep exact spacing  ',
      memoryScope: 'profile' as const,
    });
    const input = validRequestEnvelope();
    input.identity = identity;
    input.profile = profile;
    input.userText = '  keep exact user text  ';
    delete input.workspaceId;
    const history = input.messageHistory;
    const capabilities = input.capabilities;
    const context = input.context;

    const result = validateJarvisRequestEnvelope(input);
    const value = expectSuccess(result);

    expect(value).toBe(input);
    expect(value.identity).toBe(identity);
    expect(value.profile).toBe(profile);
    expect(value.messageHistory).toBe(history);
    expect(value.capabilities).toBe(capabilities);
    expect(value.context).toBe(context);
    expect(value.userText).toBe('  keep exact user text  ');
    expect(value.profile.customInstructions).toBe('  keep exact spacing  ');
    expect('workspaceId' in value).toBe(false);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(history)).toBe(false);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expectTypeOf(value).toEqualTypeOf<JarvisRequestEnvelope>();
  });

  it('returns the same response, part, arrays, and provider references', () => {
    const input = validResponseEnvelope();
    input.displayText = '  keep exact display text  ';
    const parts = input.parts;
    const part = input.parts[0];
    const artifactIds = input.artifactIds;
    const sourceRefs = input.sourceRefs;
    const provider = input.provider;
    const enforcement = input.enforcement;

    const result = validateJarvisResponseEnvelope(input);
    const value = expectSuccess(result);

    expect(value).toBe(input);
    expect(value.parts).toBe(parts);
    expect(value.parts[0]).toBe(part);
    expect(value.artifactIds).toBe(artifactIds);
    expect(value.sourceRefs).toBe(sourceRefs);
    expect(value.provider).toBe(provider);
    expect(value.enforcement).toBe(enforcement);
    expect(value.displayText).toBe('  keep exact display text  ');
    expect(Object.isFrozen(value)).toBe(false);
    expectTypeOf(value).toEqualTypeOf<JarvisResponseEnvelope>();
  });

  it('does not log, read clocks, generate IDs, leak rejected values, or return partial values', () => {
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    const dateSpy = vi.spyOn(Date, 'now');
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');
    const rejectedSentinel = 'REJECTED-PAYLOAD-SENTINEL-7391';

    try {
      expectSuccess(validateJarvisRequestEnvelope(validRequestEnvelope()));

      const invalid = validRequestEnvelope() as unknown as Record<string, unknown>;
      invalid.surface = rejectedSentinel;
      invalid.userText = rejectedSentinel;
      const result = validateJarvisRequestEnvelope(invalid);
      const errors = expectFailure(result, 'unknown_enum', ['surface']);

      expect('value' in result).toBe(false);
      expect(JSON.stringify(errors)).not.toContain(rejectedSentinel);
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
        expect(JSON.stringify(spy.mock.calls)).not.toContain(rejectedSentinel);
      }
      expect(dateSpy).not.toHaveBeenCalled();
      expect(randomUuidSpy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
      dateSpy.mockRestore();
      randomUuidSpy.mockRestore();
    }
  });
});

describe('semantic boundaries remain deferred', () => {
  it('accepts shape-valid values without inventing later-task relationship rules', () => {
    const context = validContextPack();
    context.budget.usedChars = context.budget.maxChars + 1;
    expectSuccess(validateJarvisContextPack(context));

    const prompt = validCompiledPrompt();
    prompt.layers[0]!.charCount = 999;
    expectSuccess(validateCompiledJarvisPrompt(prompt));

    const response = validResponseEnvelope();
    response.enforcement.repairAttempted = false;
    response.enforcement.repairSucceeded = true;
    expectSuccess(validateJarvisResponseEnvelope(response));

    const run = validRun();
    run.updatedAt = run.createdAt - 1;
    run.completedAt = run.createdAt - 2;
    expectSuccess(validateJarvisRun(run));

    const approval = validApproval();
    approval.status = 'consumed';
    delete approval.consumedAt;
    approval.params = {
      arbitrarySensitiveLookingFieldName: 'synthetic-placeholder-only',
    };
    expectSuccess(validateJarvisApproval(approval));

    const artifact = validArtifact();
    delete artifact.uri;
    expectSuccess(validateJarvisArtifact(artifact));
  });
});

describe('Task 20A artifact v1 shape', () => {
  it('accepts the closed v1 state, preview, and local-reference enums', () => {
    for (const state of ['ready', 'partial', 'quarantined']) {
      expectSuccess(validateJarvisArtifact(setAt(validArtifact(), ['state'], state)));
    }
    for (const kind of ['text', 'image', 'none']) {
      expectSuccess(validateJarvisArtifact(setAt(validArtifact(), ['preview', 'kind'], kind)));
    }
    for (const kind of ['path', 'blob_key', 'message_part']) {
      expectSuccess(
        validateJarvisArtifact(setAt(validArtifact(), ['localReference', 'kind'], kind)),
      );
    }
  });

  it.each([
    [['state'], 'unknown'],
    [['preview', 'kind'], 'raw'],
    [['localReference', 'kind'], 'url'],
  ] as const)('rejects an unknown artifact enum at %j', (path, value) => {
    expectFailure(
      validateJarvisArtifact(setAt(validArtifact(), path, value)),
      'unknown_enum',
      path,
    );
  });

  it('closes nested preview and local-reference records', () => {
    expectFailure(
      validateJarvisArtifact(addOwnField(validArtifact(), ['preview'], 'rawBytes', 'forbidden')),
      'unknown_field',
      ['preview', 'rawBytes'],
    );
    expectFailure(
      validateJarvisArtifact(addOwnField(validArtifact(), ['localReference'], 'verified', true)),
      'unknown_field',
      ['localReference', 'verified'],
    );
  });

  it('requires positive attempts and non-negative byte counts', () => {
    expectFailure(
      validateJarvisArtifact(setAt(validArtifact(), ['attemptNumber'], 0)),
      'invalid_type',
      ['attemptNumber'],
    );
    expectFailure(
      validateJarvisArtifact(setAt(validArtifact(), ['sizeBytes'], -1)),
      'invalid_type',
      ['sizeBytes'],
    );
    expectFailure(
      validateJarvisArtifact(setAt(validArtifact(), ['preview', 'sizeBytes'], -1)),
      'invalid_type',
      ['preview', 'sizeBytes'],
    );
  });
});

function task18ZeroEffectEvidence(
  attemptNumber = 1,
  requestId = `request-${attemptNumber}`,
): JarvisZeroConsequentialEffectEvidenceV1 {
  return {
    schemaVersion: 1,
    accountId: 'account-1',
    runId: 'run-1',
    attemptNumber,
    requestId,
    assessedAt: 500,
    providerBoundary: {
      schemaVersion: 1,
      accountId: 'account-1',
      runId: 'run-1',
      requestId,
      attemptNumber,
      providerId: 'provider-1',
      modelId: 'model-1',
      boundary: 'before_first_response_byte',
      responseStarted: false,
      chunkCount: 0,
      actionDispatchCount: 0,
      failureCategory: 'network_unavailable',
      evidenceRef: `provider-failure-${attemptNumber}`,
      verifiedAt: 490,
    },
    effectBarrier: { state: 'open', version: 0 },
    approvals: { count: 0, evidenceRef: `approvals-${attemptNumber}` },
    artifacts: { count: 0, evidenceRef: `artifacts-${attemptNumber}` },
    executorClaims: {
      count: 0,
      throughSeq: 4,
      evidenceRef: `executor-claims-${attemptNumber}`,
    },
  };
}

function task18TransportAttempt(
  overrides: Partial<JarvisTransportAttemptV1> = {},
): JarvisTransportAttemptV1 {
  return {
    schemaVersion: 1,
    attemptNumber: 1,
    kind: 'initial',
    requestId: 'request-1',
    state: 'provider_in_flight',
    startedEventSeq: 1,
    effectBarrier: { state: 'open', version: 0, updatedAt: 410 },
    createdAt: 400,
    updatedAt: 410,
    ...overrides,
  };
}

const task18ProducerIdentities = [
  {
    producerKind: 'provider',
    providerId: 'provider-1',
    modelId: 'model-1',
    modelSnapshotRef: 'model-snapshot-1',
  },
  {
    producerKind: 'action',
    actionId: 'action-1',
    actionVersion: 1,
    executionId: 'execution-1',
  },
  {
    producerKind: 'file_action',
    actionId: 'file-action-1',
    actionVersion: 1,
    resultId: 'file-result-1',
  },
  { producerKind: 'terminal', sessionId: 'session-1', executionId: 'terminal-execution-1' },
  { producerKind: 'plugin', pluginId: 'plugin-1', invocationId: 'plugin-invocation-1' },
  {
    producerKind: 'mcp',
    serverId: 'server-1',
    toolName: 'tool-1',
    invocationId: 'mcp-invocation-1',
  },
  { producerKind: 'schedule', eventId: 'schedule-event-1', occurrenceId: 'occurrence-1' },
  {
    producerKind: 'voice',
    sessionId: 'voice-session-1',
    engineKind: 'tts',
    executionId: 'voice-execution-1',
  },
  { producerKind: 'hive', stackId: 'stack-1', stepId: 'step-1', workerId: 'worker-1' },
] as const satisfies readonly JarvisLiveProducerIdentity[];

function task18ProducerSource(
  producerIdentity: JarvisLiveProducerIdentity,
  phase: 'start' | 'result' = 'start',
): JarvisProducerSourceEvidenceV1 {
  const base = {
    schemaVersion: 1 as const,
    accountId: 'account-1',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 1,
    producerKind: producerIdentity.producerKind,
    producerIdentity,
    resultRef: `${producerIdentity.producerKind}-result-1`,
    observedAt: 520,
  };
  if (phase === 'start') {
    return { ...base, phase: 'start', state: 'started' } as JarvisProducerSourceEvidenceV1;
  }
  return {
    ...base,
    phase: 'result',
    state: 'completed',
    ...(['schedule', 'hive'].includes(producerIdentity.producerKind)
      ? {
          resultAuthority: {
            runId: producerIdentity.producerKind === 'hive' ? 'run-child-1' : 'run-1',
            eventSeq: 1,
            evidenceRef: `jresult_${producerIdentity.producerKind}-1` as const,
          },
        }
      : {}),
  } as JarvisProducerSourceEvidenceV1;
}

function task18CanonicalResult(): JarvisCanonicalResultEvidenceV1 {
  return {
    schemaVersion: 1,
    kind: 'kernel_turn_committed',
    accountId: 'account-1',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 1,
    state: 'completed',
    resultRef: 'jresult_kernel-turn-1',
    observedAt: 530,
  };
}

function task18ExecutionEvidence(): JarvisExecutionEvidenceV1 {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    attemptNumber: 1,
    kind: 'consequential_effect_claimed',
    ownerKind: 'action',
    ownerId: 'action-1',
    evidenceRef: 'effect-claim-1',
    observedAt: 540,
  };
}

function task18LiveEvidence(
  producerIdentity: JarvisLiveProducerIdentity,
): JarvisDurableLiveEvidenceV1 {
  const common = {
    schemaVersion: 1 as const,
    accountId: 'account-1',
    runId: 'run-1',
    requestId: 'request-1',
    attemptNumber: 1,
    registrationId: `${producerIdentity.producerKind}-registration-1`,
    producerKind: producerIdentity.producerKind,
    producerIdentity,
    transition: 'started' as const,
    resultRef: `${producerIdentity.producerKind}-result-1`,
    resultEventSeq: 1,
    observedAt: 550,
  };
  if (producerIdentity.producerKind === 'provider') {
    return {
      ...common,
      kind: 'model',
      producerKind: 'provider',
      operations: ['generate', 'stream'],
      providerId: producerIdentity.providerId,
      modelId: producerIdentity.modelId,
      modelSnapshotRef: producerIdentity.modelSnapshotRef,
    };
  }
  return {
    ...common,
    kind: 'capability',
    operations: ['execute', 'cancel'],
    category: producerIdentity.producerKind === 'terminal' ? 'terminal' : 'tool',
    capabilityId: `${producerIdentity.producerKind}-capability-1`,
  } as JarvisDurableLiveEvidenceV1;
}

describe('Task 18 closed execution evidence contracts', () => {
  it('accepts a bounded, ordered scheduled transport-attempt ledger', () => {
    const run = {
      ...validRun(),
      source: 'schedule',
      status: 'running',
      transportAttempts: [
        task18TransportAttempt({
          state: 'retryable_failed',
          effectBarrier: { state: 'sealed_for_retry', version: 0, updatedAt: 510 },
          failureCategory: 'network_unavailable',
          zeroEffectEvidence: task18ZeroEffectEvidence(),
        }),
        task18TransportAttempt({
          attemptNumber: 2,
          kind: 'transport_retry',
          requestId: 'request-2',
          startedEventSeq: 5,
          createdAt: 600,
          updatedAt: 610,
          effectBarrier: { state: 'open', version: 0, updatedAt: 610 },
        }),
      ],
    } satisfies JarvisRun;

    expectSuccess(validateJarvisRun(run));
  });

  it.each([
    ['reused attempt number', [task18TransportAttempt(), task18TransportAttempt()]],
    ['reused request id', [task18TransportAttempt(), task18TransportAttempt({ attemptNumber: 2 })]],
    ['non-schedule owner', [task18TransportAttempt()]],
  ] as const)('rejects %s in a transport-attempt ledger', (_label, attempts) => {
    const run = {
      ...validRun(),
      source: _label === 'non-schedule owner' ? 'typed_chat' : 'schedule',
      transportAttempts: attempts,
    };
    expect(validateJarvisRun(run).ok).toBe(false);
  });

  it('rejects unknown fields at every transport-attempt boundary', () => {
    const attempt = task18TransportAttempt() as JarvisTransportAttemptV1 & {
      effectBarrier: JarvisTransportAttemptV1['effectBarrier'] & { surprise?: true };
    };
    attempt.effectBarrier = { ...attempt.effectBarrier, surprise: true };
    const result = validateJarvisRun({
      ...validRun(),
      source: 'schedule',
      transportAttempts: [attempt],
    });
    expectFailure(result, 'unknown_field', ['transportAttempts', 0, 'effectBarrier', 'surprise']);
  });

  it('accepts structured execution and canonical-result evidence', () => {
    expectSuccess(
      validateJarvisEvent({
        ...validEvent(),
        seq: 4,
        executionEvidence: task18ExecutionEvidence(),
        canonicalResultEvidence: task18CanonicalResult(),
      }),
    );
  });

  it.each(task18ProducerIdentities)(
    'accepts exact start/result source members for $producerKind',
    (producerIdentity) => {
      expectSuccess(
        validateJarvisEvent({
          ...validEvent(),
          seq: 4,
          producerSourceEvidence: task18ProducerSource(producerIdentity),
        }),
      );
      expectSuccess(
        validateJarvisEvent({
          ...validEvent(),
          seq: 4,
          producerSourceEvidence: task18ProducerSource(producerIdentity, 'result'),
        }),
      );
    },
  );

  it.each(task18ProducerIdentities)(
    'accepts exact durable live evidence for $producerKind',
    (producerIdentity) => {
      expectSuccess(
        validateJarvisEvent({
          ...validEvent(),
          seq: 4,
          liveEvidence: task18LiveEvidence(producerIdentity),
        }),
      );
    },
  );

  it('rejects producer-kind/identity mismatch and crossed phase/state pairs', () => {
    const mismatch = task18ProducerSource(task18ProducerIdentities[0]) as unknown as Record<
      string,
      unknown
    >;
    mismatch.producerKind = 'action';
    expect(validateJarvisEvent({ ...validEvent(), producerSourceEvidence: mismatch }).ok).toBe(
      false,
    );

    const crossed = {
      ...task18ProducerSource(task18ProducerIdentities[1]),
      state: 'completed',
    };
    expect(validateJarvisEvent({ ...validEvent(), producerSourceEvidence: crossed }).ok).toBe(
      false,
    );
  });

  it('rejects co-carried execution and producer-source evidence bound to different attempts', () => {
    const source = {
      ...task18ProducerSource(task18ProducerIdentities[1]),
      requestId: 'request-other',
      attemptNumber: 2,
    };
    expect(
      validateJarvisEvent({
        ...validEvent(),
        executionEvidence: task18ExecutionEvidence(),
        producerSourceEvidence: source,
      }).ok,
    ).toBe(false);
  });

  it('requires schedule and Hive result members to name an earlier canonical authority row', () => {
    for (const producerIdentity of [task18ProducerIdentities[6], task18ProducerIdentities[8]]) {
      const source = task18ProducerSource(producerIdentity, 'result');
      const withoutAuthority = { ...source } as Record<string, unknown>;
      delete withoutAuthority.resultAuthority;
      expect(
        validateJarvisEvent({ ...validEvent(), seq: 4, producerSourceEvidence: withoutAuthority })
          .ok,
      ).toBe(false);

      const selfAuthority = {
        ...source,
        resultAuthority: {
          ...(source as Extract<JarvisProducerSourceEvidenceV1, { phase: 'result' }>)
            .resultAuthority,
          eventSeq: 4,
        },
      };
      expect(
        validateJarvisEvent({ ...validEvent(), seq: 4, producerSourceEvidence: selfAuthority }).ok,
      ).toBe(false);
    }
  });

  it('rejects unknown union-member fields and a live candidate that certifies itself', () => {
    const live = {
      ...task18LiveEvidence(task18ProducerIdentities[0]),
      category: 'tool',
      resultEventSeq: 4,
    };
    const result = validateJarvisEvent({ ...validEvent(), seq: 4, liveEvidence: live });
    expectFailure(result, 'unknown_field', ['liveEvidence', 'category']);
    expect(result.ok).toBe(false);
  });

  it('rejects an event carrying both producer-source and live evidence', () => {
    const result = validateJarvisEvent({
      ...validEvent(),
      seq: 4,
      producerSourceEvidence: task18ProducerSource(task18ProducerIdentities[0]),
      liveEvidence: task18LiveEvidence(task18ProducerIdentities[0]),
    });
    expect(result.ok).toBe(false);
  });
});

describe('JARVIS context freshness and conflict metadata', () => {
  it.each(['current', 'stale', 'unknown'] as const)(
    'accepts the closed %s freshness classification',
    (freshness) => {
      const input = cloneJson(validContextPack()) as unknown as {
        items: Array<Record<string, unknown>>;
      };
      input.items[0]!.freshness = freshness;

      expectSuccess(validateJarvisContextPack(input));
    },
  );

  it('rejects freshness values outside the closed vocabulary', () => {
    const input = cloneJson(validContextPack()) as unknown as {
      items: Array<Record<string, unknown>>;
    };
    input.items[0]!.freshness = 'probably_current';

    expectFailure(validateJarvisContextPack(input), 'unknown_enum', ['items', 0, 'freshness']);
  });

  it.each([
    {
      groupId: 'release-version',
      status: 'unresolved',
      sourceIds: ['source-1', 'source-2'],
    },
    {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'source-1',
      basis: 'user_selected',
    },
    {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'source-1',
      basis: 'higher_authority',
    },
    {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'source-1',
      basis: 'newer_verified_observation',
    },
  ])('accepts closed conflict metadata %#', (conflict) => {
    const input = cloneJson(validContextPack()) as unknown as {
      items: Array<Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    const second = cloneJson(input.items[0]!);
    second.source.id = 'source-2';
    second.excerpt = 'Contradictory excerpt';
    input.items.push(second);
    input.items[0]!.conflict = conflict;
    second.conflict = conflict;

    expectSuccess(validateJarvisContextPack(input));
  });

  it('rejects an unknown conflict resolution basis', () => {
    const input = cloneJson(validContextPack()) as unknown as {
      items: Array<Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    const second = cloneJson(input.items[0]!);
    second.source.id = 'source-2';
    input.items.push(second);
    const conflict = {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'source-1',
      basis: 'model_preference',
    };
    input.items[0]!.conflict = conflict;
    second.conflict = conflict;

    expectFailure(validateJarvisContextPack(input), 'unknown_enum', [
      'items',
      0,
      'conflict',
      'basis',
    ]);
  });

  it('accepts identical group metadata regardless of object key insertion order', () => {
    const input = cloneJson(validContextPack()) as unknown as {
      items: Array<Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    const second = cloneJson(input.items[0]!);
    second.source.id = 'source-2';
    input.items.push(second);
    input.items[0]!.conflict = {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'source-1',
      basis: 'higher_authority',
    };
    second.conflict = {
      basis: 'higher_authority',
      winnerSourceId: 'source-1',
      sourceIds: ['source-1', 'source-2'],
      status: 'resolved',
      groupId: 'release-version',
    };

    expectSuccess(validateJarvisContextPack(input));
  });

  it('rejects a resolved winner that is absent from its declared source set', () => {
    const input = cloneJson(validContextPack()) as unknown as {
      items: Array<Record<string, unknown> & { source: Record<string, unknown> }>;
    };
    const second = cloneJson(input.items[0]!);
    second.source.id = 'source-2';
    input.items.push(second);
    const conflict = {
      groupId: 'release-version',
      status: 'resolved',
      sourceIds: ['source-1', 'source-2'],
      winnerSourceId: 'missing-source',
      basis: 'user_selected',
    };
    input.items[0]!.conflict = conflict;
    second.conflict = conflict;

    expect(validateJarvisContextPack(input).ok).toBe(false);
  });
});

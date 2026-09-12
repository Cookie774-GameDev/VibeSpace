# VibeSpace OpenCode Harness Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the stable, provider-agnostic TypeScript contracts required for
an OpenCode-only VibeSpace harness without changing production routing.

**Architecture:** `app/src/lib/harness` becomes the boundary between existing
VibeSpace request assembly and future OpenCode server transport. This phase
defines bounded events, typed safe failures, and exact provider/model
selection from runtime-discovered OpenCode capabilities; it deliberately
contains no process, network, UI, or router implementation.

**Tech Stack:** TypeScript 5.6, Vitest 3, existing Vite path aliases.

## Global Constraints

- OpenCode is the only target production harness; this phase does not switch
  production Chat yet.
- There is no harness selector and no automatic provider/model fallback.
- Exact provider and model identity must be preserved or rejected explicitly.
- OpenCode response shapes must not leak into UI contracts.
- Error payloads are bounded and must not expose bearer tokens, Basic Auth
  credentials, API keys, or URL userinfo.
- No dependency or lockfile changes.
- No subagents, external mutation, deployment, merge, push, release, or
  installer changes.
- Every production function is preceded by a focused failing test.

---

### Task 1: Core contracts and safe typed errors

**Files:**

- Create: `app/src/lib/harness/types.ts`
- Create: `app/src/lib/harness/errors.ts`
- Test: `app/src/lib/harness/errors.test.ts`

**Interfaces:**

- Produces:
  `HarnessRuntimeState`, `HarnessErrorCode`, `HarnessErrorPayload`,
  `HarnessEvent`, `HarnessProvider`, `HarnessModel`, `HarnessModelSelection`,
  and `VibeSpaceHarness`.
- Produces:
  `HarnessError`, `toHarnessErrorPayload(error: unknown)`, and
  `redactHarnessText(value: string)`.

- [ ] **Step 1: Write the failing safe-error tests**

```ts
import { HarnessError, toHarnessErrorPayload } from './errors';

it('redacts secrets and bounds diagnostics in serialized harness failures', () => {
  const error = new HarnessError({
    code: 'HARNESS_AUTH_FAILED',
    message: 'Bearer secret-token',
    repair: 'Reconnect provider',
    diagnostic: `https://user:password@localhost ${'x'.repeat(5000)}`,
    recoverable: true,
  });

  expect(toHarnessErrorPayload(error)).toEqual({
    code: 'HARNESS_AUTH_FAILED',
    message: 'Bearer [REDACTED]',
    repair: 'Reconnect provider',
    diagnostic: expect.not.stringContaining('password'),
    recoverable: true,
  });
  expect(toHarnessErrorPayload(error).diagnostic?.length).toBeLessThanOrEqual(2048);
});

it('maps unknown failures to a bounded safe harness failure', () => {
  expect(toHarnessErrorPayload(new Error('api_key=abc123'))).toEqual({
    code: 'HARNESS_START_FAILED',
    message: 'api_key=[REDACTED]',
    repair: 'Retry the harness operation.',
    recoverable: true,
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/lib/harness/errors.test.ts
```

Expected: FAIL because `./errors` does not exist.

- [ ] **Step 3: Implement the minimal contracts and serializer**

```ts
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly repair: string;
  readonly recoverable: boolean;
  readonly diagnostic?: string;

  constructor(input: HarnessErrorPayload) {
    super(input.message);
    this.name = 'HarnessError';
    this.code = input.code;
    this.repair = input.repair;
    this.recoverable = input.recoverable;
    this.diagnostic = input.diagnostic;
  }
}

export function toHarnessErrorPayload(error: unknown): HarnessErrorPayload {
  const source =
    error instanceof HarnessError
      ? error
      : new HarnessError({
          code: 'HARNESS_START_FAILED',
          message: error instanceof Error ? error.message : 'Harness operation failed.',
          repair: 'Retry the harness operation.',
          recoverable: true,
        });
  return {
    code: source.code,
    message: redactHarnessText(source.message).slice(0, 2048),
    repair: redactHarnessText(source.repair).slice(0, 512),
    ...(source.diagnostic
      ? { diagnostic: redactHarnessText(source.diagnostic).slice(0, 2048) }
      : {}),
    recoverable: source.recoverable,
  };
}
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- --run src/lib/harness/errors.test.ts
```

Expected: PASS.

### Task 2: Exact provider translation

**Files:**

- Create: `app/src/lib/harness/providerTranslator.ts`
- Test: `app/src/lib/harness/providerTranslator.test.ts`

**Interfaces:**

- Consumes: `HarnessProvider` and `HarnessModelSelection`.
- Produces:
  `resolveOpenCodeProvider(providerId: string, providers: readonly HarnessProvider[]): HarnessProvider`.

- [ ] **Step 1: Write failing provider-resolution tests**

```ts
import { resolveOpenCodeProvider } from './providerTranslator';

const providers = [
  { id: 'openai', name: 'OpenAI', models: [] },
  { id: 'ollama', name: 'Ollama', models: [] },
] as const;

it('resolves only the exact runtime-discovered provider', () => {
  expect(resolveOpenCodeProvider('openai', providers).id).toBe('openai');
});

it('maps the VibeSpace local alias only to discovered Ollama', () => {
  expect(resolveOpenCodeProvider('local', providers).id).toBe('ollama');
});

it('rejects a missing provider instead of selecting a default', () => {
  expect(() => resolveOpenCodeProvider('anthropic', providers)).toThrowError(
    expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
  );
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/lib/harness/providerTranslator.test.ts
```

Expected: FAIL because `./providerTranslator` does not exist.

- [ ] **Step 3: Implement exact provider resolution**

```ts
export function resolveOpenCodeProvider(
  providerId: string,
  providers: readonly HarnessProvider[],
): HarnessProvider {
  const target = providerId === 'local' ? 'ollama' : providerId;
  const provider = providers.find((candidate) => candidate.id === target);
  if (!provider) {
    throw new HarnessError({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: `Provider "${providerId}" is not available through OpenCode.`,
      repair: 'Connect this provider or select an available provider.',
      recoverable: true,
    });
  }
  return provider;
}
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- --run src/lib/harness/providerTranslator.test.ts
```

Expected: PASS.

### Task 3: Exact model translation

**Files:**

- Create: `app/src/lib/harness/modelTranslator.ts`
- Test: `app/src/lib/harness/modelTranslator.test.ts`

**Interfaces:**

- Consumes: `HarnessProvider`, selected VibeSpace provider ID, and selected
  VibeSpace model ID.
- Produces:
  `resolveOpenCodeModelSelection(input): HarnessModelSelection`.

- [ ] **Step 1: Write failing model-identity tests**

```ts
import { resolveOpenCodeModelSelection } from './modelTranslator';

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    ],
  },
] as const;

it('preserves the exact selected provider and model identity', () => {
  expect(
    resolveOpenCodeModelSelection({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      providers,
    }),
  ).toEqual({ providerId: 'openai', modelId: 'gpt-5.6-sol' });
});

it('rejects a missing model instead of using the provider default', () => {
  expect(() =>
    resolveOpenCodeModelSelection({
      providerId: 'openai',
      modelId: 'missing-model',
      providers,
    }),
  ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }));
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/lib/harness/modelTranslator.test.ts
```

Expected: FAIL because `./modelTranslator` does not exist.

- [ ] **Step 3: Implement exact model resolution**

```ts
export function resolveOpenCodeModelSelection(input: {
  providerId: string;
  modelId: string;
  providers: readonly HarnessProvider[];
}): HarnessModelSelection {
  const provider = resolveOpenCodeProvider(input.providerId, input.providers);
  if (!provider.models.some((model) => model.id === input.modelId)) {
    throw new HarnessError({
      code: 'MODEL_NOT_AVAILABLE',
      message: `Model "${input.modelId}" is not available for "${provider.id}".`,
      repair: 'Refresh models or select an available model.',
      recoverable: true,
    });
  }
  return { providerId: provider.id, modelId: input.modelId };
}
```

- [ ] **Step 4: Run GREEN**

Run:

```powershell
npm test -- --run src/lib/harness/modelTranslator.test.ts
```

Expected: PASS.

### Task 4: Bounded OpenCode event normalization and public exports

**Files:**

- Create: `app/src/lib/harness/eventNormalizer.ts`
- Test: `app/src/lib/harness/eventNormalizer.test.ts`
- Create: `app/src/lib/harness/index.ts`

**Interfaces:**

- Consumes untrusted OpenCode SSE event values.
- Produces:
  `normalizeOpenCodeEvent(value: unknown, expectedSessionId: string): HarnessEvent[]`.
- Exports Phase 1 public contracts only from `app/src/lib/harness/index.ts`.

- [ ] **Step 1: Write failing event-boundary tests**

```ts
import { normalizeOpenCodeEvent } from './eventNormalizer';

it('maps a text delta only for the expected session', () => {
  expect(
    normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', sessionID: 'session-1', text: 'ignored full text' },
          delta: 'hello',
        },
      },
      'session-1',
    ),
  ).toEqual([{ type: 'assistant.delta', text: 'hello' }]);
});

it('drops cross-session and malformed events', () => {
  expect(
    normalizeOpenCodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          part: { type: 'text', sessionID: 'session-2', text: 'secret' },
          delta: 'secret',
        },
      },
      'session-1',
    ),
  ).toEqual([]);
  expect(normalizeOpenCodeEvent({ type: 'message.part.updated' }, 'session-1')).toEqual([]);
});

it('bounds event text before exposing it to VibeSpace', () => {
  const [event] = normalizeOpenCodeEvent(
    {
      type: 'message.part.updated',
      properties: {
        part: { type: 'reasoning', sessionID: 'session-1', text: '' },
        delta: 'x'.repeat(40_000),
      },
    },
    'session-1',
  );
  expect(event).toEqual({ type: 'reasoning.delta', text: 'x'.repeat(32_768) });
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/lib/harness/eventNormalizer.test.ts
```

Expected: FAIL because `./eventNormalizer` does not exist.

- [ ] **Step 3: Implement the bounded normalizer and barrel**

```ts
export function normalizeOpenCodeEvent(value: unknown, expectedSessionId: string): HarnessEvent[] {
  const event = recordOf(value);
  const properties = recordOf(event?.properties);
  const part = recordOf(properties?.part);
  if (
    event?.type !== 'message.part.updated' ||
    part?.sessionID !== expectedSessionId ||
    typeof properties?.delta !== 'string'
  ) {
    return [];
  }
  const text = properties.delta.slice(0, 32_768);
  if (!text) return [];
  if (part.type === 'text') return [{ type: 'assistant.delta', text }];
  if (part.type === 'reasoning') return [{ type: 'reasoning.delta', text }];
  return [];
}
```

- [ ] **Step 4: Run the complete Phase 1 gate**

Run:

```powershell
npm test -- --run src/lib/harness/errors.test.ts src/lib/harness/providerTranslator.test.ts src/lib/harness/modelTranslator.test.ts src/lib/harness/eventNormalizer.test.ts
npm run typecheck
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 5: Review and commit the isolated slice**

```powershell
git add .agent-coordination.lock/owner.txt docs/operations/PR31_OPENCODE_HARNESS_BASELINE.md docs/superpowers/plans/2026-08-11-vibespace-opencode-harness-phase-1.md app/src/lib/harness
git commit -m "feat(harness): define OpenCode execution contracts"
```

Expected: one logical commit containing only owned Phase 1 paths.

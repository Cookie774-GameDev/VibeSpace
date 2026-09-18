import type { OpenCodeRequestControls } from './OpenCodeRequestControls';
import type { OpenCodeExecutionAgentId } from '../permissions/OpenCodePermissionProfile';
import {
  extractOpenCodeTextPartUpdate,
  OpenCodeTextAccumulator,
  type OpenCodeTextEmission,
} from './OpenCodeTextAccumulator';
import type { HarnessScope, OpenCodeSessionClient } from './OpenCodeSessionPool';

export interface OpenCodeRawEvent {
  type: string;
  properties?: Readonly<Record<string, unknown>>;
  /** Metadata-only native→renderer timing; never provider text or tool payloads. */
  nativeTiming?: Readonly<{
    generation: string;
    sequence: number;
    nativeHandoffWallUs: number;
    nativeHandoffMonotonicUs: number;
    rendererReceivedAt: number;
    rendererReceivedMonotonicMs: number;
  }>;
}

export interface OpenCodeSdkClientLike {
  global: {
    health(): Promise<unknown>;
  };
  config: {
    providers(): Promise<unknown>;
  };
  command: {
    list(): Promise<unknown>;
  };
  session: {
    create(input: { body: { title?: string } }): Promise<unknown>;
    get?: (input: { path: { id: string } }) => Promise<unknown>;
    abort(input: { path: { id: string } }): Promise<unknown>;
    promptAsync?: (input: {
      path: { id: string };
      body: Readonly<Record<string, unknown>>;
    }) => Promise<unknown>;
    command?: (input: {
      path: { id: string };
      body: {
        command: string;
        arguments: string;
        model?: string;
        variant?: string;
        agent: OpenCodeExecutionAgentId;
      };
    }) => Promise<unknown>;
  };
  event: {
    subscribe(): Promise<{ stream: AsyncIterable<OpenCodeRawEvent> }>;
  };
}

export interface ModelControlPromptAdapter {
  /** Version-specific conversion generated from the installed server OpenAPI. */
  toPromptFields(controls: Readonly<OpenCodeRequestControls>): Readonly<Record<string, unknown>>;
}

export function toProviderSafeOpenCodeTools(
  tools: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
  const safe: Record<string, boolean> = {};
  for (const [semanticName, enabled] of Object.entries(tools)) {
    const wireName = semanticName.replace(/[^a-zA-Z0-9_-]/gu, '_');
    if (wireName in safe && safe[wireName] !== enabled) {
      throw new Error(`OpenCode tool wire-name collision: ${wireName}`);
    }
    safe[wireName] = enabled;
  }
  return Object.freeze(safe);
}

export interface OpenCodeVariantTransportDescriptor {
  /** Exact variant IDs returned by the live catalog for each effort. */
  effortVariants?: Partial<Record<string, string>>;
  /** Exact live variant that activates provider/Codex Fast mode. */
  fastVariant?: string;
  /** Exact combined variants keyed as `<effort>+fast`. */
  combinedVariants?: Readonly<Record<string, string>>;
}

/**
 * Current OpenCode prompt_async exposes model selection and named variants.
 * Provider options such as reasoning effort or API Fast service tier therefore
 * travel through exact live variants generated/returned by OpenCode, not
 * invented top-level request fields.
 */
export class CatalogVariantPromptAdapter implements ModelControlPromptAdapter {
  constructor(
    private readonly resolve: (
      controls: Readonly<OpenCodeRequestControls>,
    ) => Readonly<OpenCodeVariantTransportDescriptor> | undefined,
  ) {}

  toPromptFields(controls: Readonly<OpenCodeRequestControls>): Readonly<Record<string, unknown>> {
    const descriptor = this.resolve(controls);
    const fast = controls.serviceTier === 'fast' || controls.openCodeFastMode === true;
    if (controls.variant && fast) {
      const effort =
        controls.effort ??
        Object.entries(descriptor?.effortVariants ?? {}).find(
          ([, variant]) => variant === controls.variant,
        )?.[0];
      const combined = effort ? descriptor?.combinedVariants?.[`${effort}+fast`] : undefined;
      if (!effort || !combined) {
        throw new Error(
          `VARIANT_NOT_AVAILABLE: ${controls.modelId} does not expose a combined ${effort ?? controls.variant}+fast variant.`,
        );
      }
      return { variant: combined };
    }
    if (controls.variant) return { variant: controls.variant };
    const effort = controls.effort;
    if (fast && effort) {
      const combined = descriptor?.combinedVariants?.[`${effort}+fast`];
      if (!combined) {
        throw new Error(
          `VARIANT_NOT_AVAILABLE: ${controls.modelId} does not expose a combined ${effort}+fast variant.`,
        );
      }
      return { variant: combined };
    }
    if (fast) {
      if (!descriptor?.fastVariant) {
        throw new Error(
          `FAST_MODE_UNSUPPORTED: ${controls.modelId} has no live OpenCode fast variant.`,
        );
      }
      return { variant: descriptor.fastVariant };
    }
    if (effort) {
      const variant = descriptor?.effortVariants?.[effort];
      if (!variant) {
        throw new Error(
          `VARIANT_NOT_AVAILABLE: ${controls.modelId} does not expose effort ${effort}.`,
        );
      }
      return { variant };
    }
    return {};
  }
}

export class StrictModelControlPromptAdapter implements ModelControlPromptAdapter {
  toPromptFields(controls: Readonly<OpenCodeRequestControls>): Readonly<Record<string, unknown>> {
    if (controls.effort || controls.serviceTier || controls.openCodeFastMode) {
      throw new Error(
        'HARNESS_INCOMPATIBLE: installed OpenCode adapter cannot transport independent effort/Fast controls.',
      );
    }
    return controls.variant ? { variant: controls.variant } : {};
  }
}

function unwrapData<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'data' in value) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function requiredId(value: unknown, label: string): string {
  if (!value || typeof value !== 'object') throw new Error(`${label} response is malformed.`);
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${label} returned an empty id.`);
  return id.trim();
}

/**
 * Persistent client-only adapter for an already-owned `opencode serve`
 * process. It deliberately refuses to fall back to blocking `opencode run` or
 * synchronous per-turn process execution.
 */
export class OpenCodeSdkSessionClient implements OpenCodeSessionClient {
  constructor(
    private readonly client: OpenCodeSdkClientLike,
    private readonly modelControls: ModelControlPromptAdapter = new StrictModelControlPromptAdapter(),
  ) {}

  async health(): Promise<{ healthy: true; version: string }> {
    const data = unwrapData<{ healthy?: unknown; version?: unknown }>(
      await this.client.global.health(),
    );
    if (data?.healthy !== true || typeof data.version !== 'string' || !data.version.trim()) {
      throw new Error('HARNESS_HEALTH_FAILED: OpenCode health/version response is invalid.');
    }
    return { healthy: true, version: data.version.trim() };
  }

  async listProviders(): Promise<unknown> {
    return unwrapData(await this.client.config.providers());
  }

  async createSession(input: { scope: HarnessScope; title?: string }): Promise<{ id: string }> {
    const response = await this.client.session.create({
      body: { ...(input.title?.trim() ? { title: input.title.trim() } : {}) },
    });
    return { id: requiredId(unwrapData(response), 'OpenCode session.create') };
  }

  async getSession(sessionId: string): Promise<{ id: string } | null> {
    const id = sessionId.trim();
    if (!id || !this.client.session.get) return null;
    try {
      const response = unwrapData(await this.client.session.get({ path: { id } }));
      return { id: requiredId(response, 'OpenCode session.get') };
    } catch {
      return null;
    }
  }

  async abort(sessionId: string): Promise<void> {
    const id = sessionId.trim();
    if (!id) return;
    await this.client.session.abort({ path: { id } });
  }

  async sendAsync(input: {
    sessionId: string;
    controls: OpenCodeRequestControls;
    text: string;
    system?: string;
    agent: OpenCodeExecutionAgentId;
    tools?: Readonly<Record<string, boolean>>;
  }): Promise<void> {
    if (!this.client.session.promptAsync) {
      throw new Error(
        'HARNESS_INCOMPATIBLE: installed OpenCode SDK/server lacks session.promptAsync; refusing per-turn CLI fallback.',
      );
    }
    const sessionId = input.sessionId.trim();
    const text = input.text.trim();
    const agent = input.agent;
    if (!sessionId || !text || !agent?.trim())
      throw new Error('A session id, execution agent, and non-empty prompt text are required.');

    const controlFields = this.modelControls.toPromptFields(input.controls);
    await this.client.session.promptAsync({
      path: { id: sessionId },
      body: {
        model: {
          providerID: input.controls.providerId,
          modelID: input.controls.modelId,
        },
        ...controlFields,
        agent,
        ...(input.system?.trim() ? { system: input.system } : {}),
        ...(input.tools ? { tools: toProviderSafeOpenCodeTools(input.tools) } : {}),
        parts: [{ type: 'text', text }],
      },
    });
  }

  async sendCommandAsync(input: {
    sessionId: string;
    controls: OpenCodeRequestControls;
    command: string;
    arguments: string;
    agent: OpenCodeExecutionAgentId;
  }): Promise<void> {
    if (!this.client.session.command) {
      throw new Error('HARNESS_INCOMPATIBLE: installed OpenCode SDK/server lacks session.command.');
    }
    const sessionId = input.sessionId.trim();
    const command = input.command.trim().toLowerCase();
    const args = input.arguments.trim();
    const agent = input.agent;
    if (!sessionId || !command || !args || !agent?.trim()) {
      throw new Error(
        'A session id, execution agent, registered command, and non-empty arguments are required.',
      );
    }
    const listed = unwrapData<unknown>(await this.client.command.list());
    const commands = Array.isArray(listed) ? listed : [];
    const registered = commands.some(
      (entry) =>
        entry && typeof entry === 'object' && (entry as { name?: unknown }).name === command,
    );
    if (!registered) {
      throw new Error(
        `OpenCode command /${command} is not registered in the live command catalog.`,
      );
    }
    const controlFields = this.modelControls.toPromptFields(input.controls);
    const variant = typeof controlFields.variant === 'string' ? controlFields.variant : undefined;
    await this.client.session.command({
      path: { id: sessionId },
      body: {
        command,
        arguments: args,
        agent,
        model: `${input.controls.providerId}/${input.controls.modelId}`,
        ...(variant ? { variant } : {}),
      },
    });
  }

  async subscribeEvents(): Promise<AsyncIterable<OpenCodeRawEvent>> {
    const subscription = await this.client.event.subscribe();
    if (!subscription?.stream)
      throw new Error('HARNESS_EVENT_FAILED: OpenCode event stream is missing.');
    return subscription.stream;
  }

  async *subscribeTextEvents(
    input: {
      sessionId?: string;
      accumulator?: OpenCodeTextAccumulator;
    } = {},
  ): AsyncIterable<OpenCodeTextEmission> {
    const stream = await this.subscribeEvents();
    const accumulator = input.accumulator ?? new OpenCodeTextAccumulator();
    const expectedSessionId = input.sessionId?.trim();
    for await (const event of stream) {
      const update = extractOpenCodeTextPartUpdate(event);
      if (!update) continue;
      if (expectedSessionId && update.sessionId && update.sessionId !== expectedSessionId) continue;
      const emission = accumulator.ingest(update);
      if (emission.kind !== 'noop') yield emission;
    }
  }
}

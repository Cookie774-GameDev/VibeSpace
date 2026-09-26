import type { OpenCodeRequestControls } from './OpenCodeRequestControls';
import { MUTATING_TOOL_GATEWAY_TOOLS } from './toolGatewayProtocol';
import type { OpenCodeExecutionAgentId } from '../permissions/OpenCodePermissionProfile';
import {
  extractOpenCodeTextPartUpdate,
  OpenCodeTextAccumulator,
  type OpenCodeTextEmission,
} from './OpenCodeTextAccumulator';
import type { HarnessScope, OpenCodeSessionClient } from './OpenCodeSessionPool';
import {
  openCodePromptModel,
  qualifiedOpenCodeModelRoute,
} from './OpenCodeRequestControls';

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
  /** Read-only catalog exposed by the installed OpenCode server. */
  skill?: {
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
      signal?: AbortSignal;
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
  // OpenCode's legacy prompt endpoint persists every tools flag as a
  // session-wide wildcard permission after the selected agent's rules. Keep
  // native mutation decisions inherited from that agent so a Full capability
  // map cannot erase scoped/review asks.
  // Explicit false flags remain intact to preserve deliberate denials.
  for (const name of ['edit', 'write', 'patch', 'bash', 'shell', 'task']) {
    const wireName = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
    if (safe[wireName] === true) delete safe[wireName];
  }
  // Gateway mutations also require the matching VibeSpace grant; omit their
  // positive flags while preserving explicit denials and availability policy.
  for (const name of MUTATING_TOOL_GATEWAY_TOOLS) {
    const wireName = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
    if (safe[wireName] === true) delete safe[wireName];
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

export interface OpenCodeCommandDescriptor {
  /** Exact identifier supplied by OpenCode. */
  readonly name: string;
  readonly identifier: string;
  /** Owner/source/name key; equal names from different sources remain distinct. */
  readonly identity: string;
  readonly source: string;
  readonly executionCapability: 'session-command' | 'requires-native-cli-ui';
  readonly description?: string;
}

/** Metadata only; native skill bodies and command templates are never returned. */
export interface OpenCodeNativeSkillDescriptor {
  readonly name: string;
  /** Absolute path of the registered SKILL.md. */
  readonly location: string;
  readonly description?: string;
}

const MAX_CATALOG_NAME_LENGTH = 256;
const MAX_CATALOG_SOURCE_LENGTH = 64;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/u;
const EXECUTABLE_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/iu;
const KNOWN_COMMAND_SOURCES = new Set(['command', 'mcp', 'skill']);

function encodeIdentityPart(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    const codeUnits = Array.from({ length: value.length }, (_, index) =>
      value.charCodeAt(index).toString(16).padStart(4, '0'),
    );
    return `utf16-${codeUnits.join('-')}`;
  }
}

function cleanCatalogDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\r\n\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 512) || undefined;
}

function validCatalogName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CATALOG_NAME_LENGTH &&
    value === value.trim() && !CONTROL_BYTES.test(value);
}

/** Compare the registered SKILL.md location to a selected file or directory. */
export function canonicalOpenCodeSkillBasePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value !== value.trim() ||
    CONTROL_BYTES.test(value)
  ) return undefined;
  const slashPath = value.replace(/\\/gu, '/');
  const drive = slashPath.match(/^([a-z]:)\//iu)?.[1];
  const unc = !drive && slashPath.startsWith('//');
  if (!drive && !unc && !slashPath.startsWith('/')) return undefined;
  const prefix = drive ? `${drive}/` : unc ? '//' : '/';
  const remainder = drive ? slashPath.slice(3) : slashPath.slice(prefix.length);
  const parts: string[] = [];
  for (const part of remainder.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (unc && parts.length < 2) return undefined;
  if (parts.at(-1)?.toLocaleLowerCase('en-US') === 'skill.md') parts.pop();
  const normalized = `${prefix}${parts.join('/')}`.replace(/\/$/u, '') || prefix;
  return drive || unc ? normalized.toLocaleLowerCase('en-US') : normalized;
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

/** Parse the scoped OpenCode skill catalog without exposing private body/template fields. */
export function parseOpenCodeNativeSkillCatalog(
  payload: unknown,
): readonly OpenCodeNativeSkillDescriptor[] {
  const listed = unwrapData<unknown>(payload);
  if (!Array.isArray(listed)) throw new Error('OpenCode native skill catalog response is malformed.');
  const skills = listed.flatMap((entry): OpenCodeNativeSkillDescriptor[] => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as { name?: unknown; location?: unknown; description?: unknown };
    if (!validCatalogName(value.name) || !canonicalOpenCodeSkillBasePath(value.location)) return [];
    const description = cleanCatalogDescription(value.description);
    return [Object.freeze({
      name: value.name,
      location: value.location as string,
      ...(description ? { description } : {}),
    })];
  });
  return Object.freeze(skills);
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
    const response = unwrapData(await this.client.session.get({ path: { id } }));
    if (response === null) return null;
    return { id: requiredId(response, 'OpenCode session.get') };
  }

  async abort(sessionId: string): Promise<void> {
    const id = sessionId.trim();
    if (!id) return;
    await this.client.session.abort({ path: { id } });
  }

  async listCommandsAsync(): Promise<readonly OpenCodeCommandDescriptor[]> {
    const listed = unwrapData<unknown>(await this.client.command.list());
    if (!Array.isArray(listed)) throw new Error('OpenCode command catalog response is malformed.');
    const parsed = listed.flatMap((entry): OpenCodeCommandDescriptor[] => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as { name?: unknown; source?: unknown; description?: unknown };
      const name = value.name;
      if (!validCatalogName(name)) return [];
      const rawSource = value.source;
      const source = typeof rawSource === 'string' &&
        rawSource.length <= MAX_CATALOG_SOURCE_LENGTH &&
        rawSource === rawSource.trim() && !CONTROL_BYTES.test(rawSource)
        ? rawSource
        : rawSource === undefined ? 'command' : 'unknown';
      const description = cleanCatalogDescription(value.description);
      return [Object.freeze({
        name,
        identifier: name,
        identity: `opencode:${encodeIdentityPart(source)}:${encodeIdentityPart(name)}`,
        source,
        executionCapability:
          KNOWN_COMMAND_SOURCES.has(source) && EXECUTABLE_COMMAND_NAME.test(name)
            ? 'session-command' as const
            : 'requires-native-cli-ui' as const,
        ...(description ? { description } : {}),
      })];
    });
    const unique = new Map<string, OpenCodeCommandDescriptor>();
    for (const descriptor of parsed) {
      if (!unique.has(descriptor.identity)) unique.set(descriptor.identity, descriptor);
    }
    return Object.freeze(Array.from(unique.values()));
  }

  async listSkillsAsync(): Promise<readonly OpenCodeNativeSkillDescriptor[]> {
    if (!this.client.skill?.list) {
      throw new Error('HARNESS_INCOMPATIBLE: installed OpenCode client cannot inspect native skills.');
    }
    return parseOpenCodeNativeSkillCatalog(await this.client.skill.list());
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
        model: openCodePromptModel(input.controls),
        ...controlFields,
        agent,
        ...(input.system?.trim() ? { system: input.system } : {}),
        ...(input.tools ? { tools: toProviderSafeOpenCodeTools(input.tools) } : {}),
        parts: [{ type: 'text', text }],
      },
    });
  }

  async sendCommandAsync(input: {
    signal?: AbortSignal;
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
    if (!sessionId || !command || !agent?.trim()) {
      throw new Error(
        'A session id, execution agent, and registered command are required.',
      );
    }
    const registered = (await this.listCommandsAsync()).some(
      (entry) => entry.name.toLocaleLowerCase('en-US') === command &&
        entry.executionCapability === 'session-command',
    );
    if (!registered) {
      throw new Error(
        `OpenCode command /${command} is not registered in the live command catalog.`,
      );
    }
    if (!args && command === 'goal') {
      throw new Error('OpenCode command /goal requires non-empty arguments.');
    }
    const controlFields = this.modelControls.toPromptFields(input.controls);
    const variant = typeof controlFields.variant === 'string' ? controlFields.variant : undefined;
    await this.client.session.command({
      signal: input.signal,
      path: { id: sessionId },
      body: {
        command,
        arguments: args,
        agent,
        model: qualifiedOpenCodeModelRoute(input.controls),
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

import type { JarvisSourceKind, JarvisSourceRef } from './contracts';
import type { JarvisContextCandidate } from './contextPack';
import { JARVIS_ALL_ABOUT_ME_SOURCE_ID } from './promptCompiler';
import { deepFreezeJarvisCopy } from './requestEnvelope';

export type JarvisRuntimeContextBlockKey =
  | 'project'
  | 'project_tree'
  | 'repository_context'
  | 'local_knowledge'
  | 'user_identity'
  | 'default_write_folder'
  | 'all_about_me'
  | 'plugin_context'
  | 'plugin_status'
  | 'mcp_tool_schemas'
  | 'model_skill_inventory'
  | 'selected_skills'
  | 'resolved_context'
  | 'intent_policy'
  | 'interaction_mode'
  | 'structured_context'
  | 'mentioned_agents'
  | 'explicit_context'
  | 'explicit_files'
  | 'explicit_terminal'
  | 'coordination'
  | 'terminal_operating'
  | 'connected_files'
  | 'terminal_transcript'
  | 'completion_instruction';

export interface JarvisRuntimeContextBlock {
  key: JarvisRuntimeContextBlockKey;
  text: string;
  source?: Readonly<Pick<JarvisSourceRef, 'id' | 'label' | 'uri' | 'observedAt' | 'contentHash'>>;
  score?: number;
}

type SourceOrigin = NonNullable<JarvisContextCandidate['source']['origin']>;

interface RuntimeContextDefinition {
  kind: JarvisSourceKind;
  label: string;
  trust: JarvisContextCandidate['source']['trust'];
  origin: SourceOrigin;
  purpose: JarvisContextCandidate['purpose'];
  explicitlyAttached: boolean;
  atomicBody?: boolean;
}

const DEFINITIONS = Object.freeze({
  project: {
    kind: 'project',
    label: 'Project context',
    trust: 'app_verified',
    origin: 'user_authored',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  project_tree: {
    kind: 'context_node',
    label: 'Project context map',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  repository_context: {
    kind: 'project_file',
    label: 'Selected repository evidence',
    trust: 'app_verified',
    origin: 'user_authored',
    purpose: 'citation',
    explicitlyAttached: false,
  },
  local_knowledge: {
    kind: 'project_file',
    label: 'Approved local knowledge',
    trust: 'app_verified',
    origin: 'user_authored',
    purpose: 'citation',
    explicitlyAttached: false,
  },
  user_identity: {
    kind: 'memory',
    label: 'User-selected identity',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'preference',
    explicitlyAttached: false,
  },
  default_write_folder: {
    kind: 'project',
    label: 'Default write folder',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  all_about_me: {
    kind: 'memory',
    label: 'AllAboutMe profile',
    trust: 'app_verified',
    origin: 'mixed',
    purpose: 'preference',
    explicitlyAttached: false,
  },
  plugin_context: {
    kind: 'plugin',
    label: 'Plugin-provided context',
    trust: 'external_untrusted',
    origin: 'external_retrieved',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  plugin_status: {
    kind: 'plugin',
    label: 'Plugin connection status',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'capability',
    explicitlyAttached: false,
  },
  mcp_tool_schemas: {
    kind: 'mcp',
    label: 'Task-relevant external MCP tool schemas',
    trust: 'external_untrusted',
    origin: 'external_retrieved',
    purpose: 'capability',
    explicitlyAttached: false,
    atomicBody: true,
  },
  model_skill_inventory: {
    kind: 'tool_result',
    label: 'Model and skill availability inventory',
    trust: 'app_verified',
    origin: 'mixed',
    purpose: 'capability',
    explicitlyAttached: false,
  },
  selected_skills: {
    kind: 'tool_result',
    label: 'User-selected skills',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  resolved_context: {
    kind: 'context_node',
    label: 'Resolved app context',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  intent_policy: {
    kind: 'tool_result',
    label: 'Request policy classification',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  interaction_mode: {
    kind: 'tool_result',
    label: 'Interaction mode policy',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  structured_context: {
    kind: 'user_message',
    label: 'User-selected structured context',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'answer',
    explicitlyAttached: true,
  },
  mentioned_agents: {
    kind: 'agent_output',
    label: 'Mentioned agent context',
    trust: 'external_untrusted',
    origin: 'external_retrieved',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  explicit_context: {
    kind: 'context_node',
    label: 'Explicit context attachment',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'answer',
    explicitlyAttached: true,
  },
  explicit_files: {
    kind: 'project_file',
    label: 'Explicit file attachment',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'answer',
    explicitlyAttached: true,
  },
  explicit_terminal: {
    kind: 'terminal',
    label: 'Explicit terminal attachment',
    trust: 'external_untrusted',
    origin: 'external_retrieved',
    purpose: 'answer',
    explicitlyAttached: true,
  },
  coordination: {
    kind: 'agent_output',
    label: 'Agent coordination state',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  terminal_operating: {
    kind: 'terminal',
    label: 'Terminal operating state',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
  connected_files: {
    kind: 'project_file',
    label: 'Connected project files',
    trust: 'user_direct',
    origin: 'user_authored',
    purpose: 'answer',
    explicitlyAttached: true,
  },
  terminal_transcript: {
    kind: 'terminal',
    label: 'Terminal transcript',
    trust: 'external_untrusted',
    origin: 'external_retrieved',
    purpose: 'answer',
    explicitlyAttached: false,
  },
  completion_instruction: {
    kind: 'tool_result',
    label: 'App completion notification policy',
    trust: 'app_verified',
    origin: 'app_observed',
    purpose: 'execution',
    explicitlyAttached: false,
  },
} as const satisfies Readonly<Record<JarvisRuntimeContextBlockKey, RuntimeContextDefinition>>);

function sourceId(requestId: string, key: JarvisRuntimeContextBlockKey): string {
  return key === 'all_about_me' ? JARVIS_ALL_ABOUT_ME_SOURCE_ID : `jsource_${requestId}_${key}`;
}

type BoundedRetrievedSource = NonNullable<JarvisRuntimeContextBlock['source']>;

interface ValidBoundedRetrievedSource extends BoundedRetrievedSource {
  id: string;
  label: string;
  uri: string;
  observedAt: number;
  contentHash: string;
}

function validBoundedRetrievedSource(
  key: JarvisRuntimeContextBlockKey,
  source: BoundedRetrievedSource | undefined,
): source is ValidBoundedRetrievedSource {
  if (!source) return false;
  const validId =
    key === 'local_knowledge'
      ? /^jlocal_[a-f0-9]{16}$/.test(source.id)
      : key === 'repository_context'
        ? /^jrepo_[a-f0-9]{16}$/.test(source.id)
        : false;
  const stableText = (value: string | undefined, max: number) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
  return (
    validId &&
    stableText(source.label, 240) &&
    typeof source.uri === 'string' &&
    stableText(source.uri, 480) &&
    !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(source.uri) &&
    !source.uri.replace(/\\/g, '/').split('/').includes('..') &&
    typeof source.observedAt === 'number' &&
    Number.isSafeInteger(source.observedAt) &&
    source.observedAt >= 0 &&
    typeof source.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(source.contentHash)
  );
}

/**
 * Convert already-built runtime prompt blocks into separate immutable context
 * candidates. This function reads no files and performs no retrieval; source
 * admission and body-secret rejection still occur in buildJarvisContextPack.
 */
export function buildJarvisRuntimeContextCandidates(input: {
  accountId: string;
  requestId: string;
  projectId?: string;
  observedAt: number;
  blocks: readonly Readonly<JarvisRuntimeContextBlock>[];
}): readonly Readonly<JarvisContextCandidate>[] {
  const admittedBlocks = input.blocks.filter(
    (block) =>
      block.text.trim().length > 0 &&
      (!['local_knowledge', 'repository_context'].includes(block.key) ||
        validBoundedRetrievedSource(block.key, block.source)),
  );
  const candidates = admittedBlocks.map((block, index) => {
    const definition = DEFINITIONS[block.key];
    const boundedSource =
      (block.key === 'local_knowledge' || block.key === 'repository_context') &&
      validBoundedRetrievedSource(block.key, block.source)
        ? block.source
        : null;
    return {
      source: {
        id: boundedSource?.id ?? sourceId(input.requestId, block.key),
        kind: definition.kind,
        label: boundedSource?.label ?? definition.label,
        ...(boundedSource ? { uri: boundedSource.uri } : {}),
        accountId: input.accountId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        trust: definition.trust,
        origin: definition.origin,
        sensitivity: 'private' as const,
        observedAt: boundedSource?.observedAt ?? input.observedAt,
        ...(boundedSource ? { contentHash: boundedSource.contentHash } : {}),
      },
      purpose: definition.purpose,
      excerpt: block.text,
      score:
        typeof block.score === 'number' && Number.isFinite(block.score)
          ? block.score
          : admittedBlocks.length - index,
      freshness: 'current',
      explicitlyAttached: definition.explicitlyAttached,
      authorizedBody: true,
      ...('atomicBody' in definition && definition.atomicBody === true ? { atomicBody: true } : {}),
    } satisfies JarvisContextCandidate;
  });
  return deepFreezeJarvisCopy(candidates) as readonly Readonly<JarvisContextCandidate>[];
}

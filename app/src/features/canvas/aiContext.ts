/**
 * Pure, bounded context compiler for Canvas-aware Jarvis and Prompt Forge calls.
 *
 * The compiler accepts already-authorized local domain values. It performs no
 * reads, writes, routing, or model calls; it only creates a detached immutable
 * projection. Binary payloads, checksums, URLs, thumbnails, permission
 * evidence, and owner identifiers are deliberately outside the projection.
 */
import { deepFreezeJarvisCopy } from '@/lib/jarvis/requestEnvelope';
import { applySecretPolicy } from '@/lib/security/secretDetector';
import type { PromptForgeSourceCandidate } from '@/features/prompt-forge/sourcePack';

import type { CanvasAttachmentReference } from './attachments';
import type { CanvasBlock, CanvasDocument } from './contracts';
import type { CanvasFrame } from './frames';
import type { CanvasHistoryActionKind } from './history';
import type { CanvasLinkedContent, CanvasLinkedDocument } from './linkedContent';

export const CANVAS_AI_CONTEXT_LIMITS = Object.freeze({
  maxSelectionBlocks: 32,
  maxVisibleBlocks: 64,
  maxLinkedSources: 24,
  maxRecentChanges: 20,
  maxAttachments: 16,
  maxBlockCharacters: 2_000,
  maxSourceCharacters: 2_000,
  maxPromptCharacters: 16_000,
} as const);

export interface CanvasAiContextCapabilities {
  /**
   * Allows filename, MIME type, and byte count for binary attachments.
   * It never enables bytes, checksums, source paths/URLs, or thumbnails.
   */
  readonly includeBinaryAttachmentMetadata?: boolean;
}

export interface CanvasAiScopeIdentity {
  readonly canvasId: string;
  readonly projectId: string;
  readonly ownerId: string;
}

export interface CanvasAiSlashReference extends CanvasAiScopeIdentity {
  readonly token: string;
  readonly targetId: string;
  readonly label: string;
}

export interface CanvasAiSnapshotReference extends CanvasAiScopeIdentity {
  readonly id: string;
  readonly label: string;
  readonly capturedAt: number;
}

export type CanvasAiVisibleFrameReference = CanvasFrame & CanvasAiScopeIdentity;

export interface CanvasAiComposerInput {
  readonly slashReference?: CanvasAiSlashReference | null;
  readonly snapshot?: CanvasAiSnapshotReference | null;
}

export interface CanvasAiRecentChange extends CanvasAiScopeIdentity {
  readonly id: string;
  readonly kind: CanvasHistoryActionKind;
  readonly label: string;
  readonly objectIds: readonly string[];
  readonly timestamp: number;
}

export type CanvasAiRecentChangeContext = Omit<CanvasAiRecentChange, keyof CanvasAiScopeIdentity>;

export interface CanvasAiContextLimits {
  readonly maxSelectionBlocks?: number;
  readonly maxVisibleBlocks?: number;
  readonly maxLinkedSources?: number;
  readonly maxRecentChanges?: number;
  readonly maxAttachments?: number;
  readonly maxBlockCharacters?: number;
  readonly maxSourceCharacters?: number;
  readonly maxPromptCharacters?: number;
}

export interface CanvasAiContextInput {
  readonly document: CanvasDocument;
  readonly selectedBlockIds?: readonly string[];
  readonly visibleFrame?: CanvasAiVisibleFrameReference | null;
  readonly linkedProjectSources?: readonly (CanvasLinkedContent | CanvasLinkedDocument)[];
  readonly recentChanges?: readonly CanvasAiRecentChange[];
  readonly attachments?: readonly CanvasAttachmentReference[];
  readonly composer?: CanvasAiComposerInput;
  readonly capabilities?: CanvasAiContextCapabilities;
  readonly limits?: CanvasAiContextLimits;
}

export interface CanvasAiBlockContext {
  readonly id: string;
  readonly kind: CanvasBlock['content']['kind'];
  readonly label: string;
  readonly content: string;
  readonly updatedAt: number;
}

export interface CanvasAiFrameContext {
  readonly id: string;
  readonly name: string;
  readonly childIds: readonly string[];
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly locked: boolean;
  readonly collapsed: boolean;
}

export interface CanvasAiLinkedSourceContext {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: string;
  readonly label: string;
  readonly status: string;
  readonly available: boolean;
  readonly summary: string;
  readonly excerpt: string;
  readonly updatedAt: number;
}

export interface CanvasAiAttachmentContext {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly missing: boolean;
  readonly preview: string | null;
  readonly binaryMetadataOnly: boolean;
}

export interface CanvasAiComposerContext {
  readonly currentCanvasId: string;
  readonly selectedBlockIds: readonly string[];
  readonly visibleFrameId: string | null;
  readonly snapshotId: string | null;
  readonly snapshotLabel: string | null;
  readonly snapshotCapturedAt: number | null;
  readonly slashReference: Readonly<{
    token: string;
    targetId: string;
    label: string;
  }> | null;
}

export interface CanvasAiContext {
  readonly canvas: Readonly<{
    id: string;
    projectId: string;
    title: string;
    layoutMode: CanvasDocument['layoutMode'];
    localRevision: number;
    updatedAt: number;
    camera: Readonly<{ x: number; y: number; zoom: number }>;
    blockCount: number;
    blockKinds: Readonly<Partial<Record<CanvasBlock['content']['kind'], number>>>;
  }>;
  readonly selection: readonly CanvasAiBlockContext[];
  readonly visibleBlocks: readonly CanvasAiBlockContext[];
  readonly visibleFrame: CanvasAiFrameContext | null;
  readonly linkedProjectSources: readonly CanvasAiLinkedSourceContext[];
  readonly recentChanges: readonly CanvasAiRecentChangeContext[];
  readonly attachments: readonly CanvasAiAttachmentContext[];
  readonly composer: CanvasAiComposerContext;
  readonly promptForgeSources: readonly PromptForgeSourceCandidate[];
  readonly prompt: string;
  readonly warnings: readonly string[];
}

interface NormalizedLimits {
  readonly maxSelectionBlocks: number;
  readonly maxVisibleBlocks: number;
  readonly maxLinkedSources: number;
  readonly maxRecentChanges: number;
  readonly maxAttachments: number;
  readonly maxBlockCharacters: number;
  readonly maxSourceCharacters: number;
  readonly maxPromptCharacters: number;
}

const MODEL_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const SPACE_PATTERN = /[ \t]+/gu;
const SAFE_REFERENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,255}$/u;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

function normalizeLimits(value: CanvasAiContextLimits | undefined): NormalizedLimits {
  return {
    maxSelectionBlocks: boundedInteger(
      value?.maxSelectionBlocks,
      CANVAS_AI_CONTEXT_LIMITS.maxSelectionBlocks,
      CANVAS_AI_CONTEXT_LIMITS.maxSelectionBlocks,
    ),
    maxVisibleBlocks: boundedInteger(
      value?.maxVisibleBlocks,
      CANVAS_AI_CONTEXT_LIMITS.maxVisibleBlocks,
      CANVAS_AI_CONTEXT_LIMITS.maxVisibleBlocks,
    ),
    maxLinkedSources: boundedInteger(
      value?.maxLinkedSources,
      CANVAS_AI_CONTEXT_LIMITS.maxLinkedSources,
      CANVAS_AI_CONTEXT_LIMITS.maxLinkedSources,
    ),
    maxRecentChanges: boundedInteger(
      value?.maxRecentChanges,
      CANVAS_AI_CONTEXT_LIMITS.maxRecentChanges,
      CANVAS_AI_CONTEXT_LIMITS.maxRecentChanges,
    ),
    maxAttachments: boundedInteger(
      value?.maxAttachments,
      CANVAS_AI_CONTEXT_LIMITS.maxAttachments,
      CANVAS_AI_CONTEXT_LIMITS.maxAttachments,
    ),
    maxBlockCharacters: boundedInteger(
      value?.maxBlockCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxBlockCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxBlockCharacters,
    ),
    maxSourceCharacters: boundedInteger(
      value?.maxSourceCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxSourceCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxSourceCharacters,
    ),
    maxPromptCharacters: boundedInteger(
      value?.maxPromptCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxPromptCharacters,
      CANVAS_AI_CONTEXT_LIMITS.maxPromptCharacters,
    ),
  };
}

function modelText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const controlled = value
    .replace(/\r\n?/gu, '\n')
    .replace(MODEL_CONTROL_PATTERN, '')
    .replace(SPACE_PATTERN, ' ')
    .trim()
    .slice(0, maximum);
  if (controlled.length === 0) return '';
  return applySecretPolicy(controlled, 'redact').text ?? '';
}

function safeId(value: unknown, fallback: string): string {
  const text = modelText(value, 256);
  return SAFE_REFERENCE_TOKEN.test(text) ? text : fallback;
}

function blockContent(block: CanvasBlock, maximum: number): string {
  if (block.content.kind === 'mind-map') {
    return modelText(JSON.stringify(block.content.map), maximum);
  }
  if (block.content.kind === 'shape') {
    return modelText(block.content.shape.text ?? block.content.shape.kind, maximum);
  }
  if (block.content.kind === 'stroke') {
    return modelText(`${block.content.tool} stroke`, maximum);
  }
  if (block.content.kind === 'image') {
    return modelText(`Image: ${block.content.altText || block.content.name}`, maximum);
  }
  return modelText(block.content.text, maximum);
}

function blockContext(block: CanvasBlock, maximum: number): CanvasAiBlockContext {
  const id = safeId(block.id, 'unknown-block');
  return {
    id,
    kind: block.content.kind,
    label: modelText(`${block.content.kind} block ${id}`, 200),
    content: blockContent(block, maximum),
    updatedAt: block.updatedAt,
  };
}

function documentOrder(document: CanvasDocument): ReadonlyMap<string, number> {
  return new Map(document.pageOrder.map((id, index) => [id, index]));
}

function orderedKnownIds(
  candidates: readonly string[],
  blocks: ReadonlyMap<string, CanvasBlock>,
  order: ReadonlyMap<string, number>,
  maximum: number,
): readonly string[] {
  return [...new Set(candidates)]
    .filter((id) => blocks.has(id))
    .sort((left, right) => {
      const orderDifference =
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER);
      return orderDifference === 0 ? left.localeCompare(right) : orderDifference;
    })
    .slice(0, maximum);
}

function linkedSourceContext(
  source: CanvasLinkedContent | CanvasLinkedDocument,
  maximum: number,
): CanvasAiLinkedSourceContext {
  if ('documentKind' in source) {
    return {
      id: safeId(source.id, 'unknown-linked-document'),
      sourceId: safeId(source.sourceId, 'unknown-source'),
      kind: source.documentKind,
      label: modelText(source.title, 200),
      status: source.status,
      available: source.status !== 'unavailable',
      summary: modelText(source.summary, maximum),
      excerpt: modelText(source.excerpt, maximum),
      updatedAt: source.updatedAt,
    };
  }
  return {
    id: safeId(source.id, 'unknown-linked-source'),
    sourceId: safeId(source.sourceId, 'unknown-source'),
    kind: source.kind,
    label: modelText(source.title, 200),
    status: source.status,
    available: source.available,
    summary: modelText(source.preview?.summary ?? '', maximum),
    excerpt: modelText(source.preview?.excerpt ?? '', maximum),
    updatedAt: source.updatedAt,
  };
}

function isTextAttachment(attachment: CanvasAttachmentReference): boolean {
  const mimeType = attachment.source.mimeType.toLowerCase();
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml')
  );
}

function attachmentContext(
  attachment: CanvasAttachmentReference,
  binaryMetadataOnly: boolean,
  maximum: number,
): CanvasAiAttachmentContext {
  return {
    id: safeId(attachment.id, 'unknown-attachment'),
    filename: modelText(attachment.source.filename, 200),
    mimeType: modelText(attachment.source.mimeType.toLowerCase(), 200),
    byteSize: attachment.source.byteSize,
    missing: attachment.missing,
    preview: binaryMetadataOnly ? null : modelText(attachment.preview?.text ?? '', maximum) || null,
    binaryMetadataOnly,
  };
}

function recentChangeContext(change: CanvasAiRecentChange): CanvasAiRecentChangeContext {
  return {
    id: safeId(change.id, 'unknown-change'),
    kind: change.kind,
    label: modelText(change.label, 200),
    objectIds: [...new Set(change.objectIds)]
      .map((id) => safeId(id, 'unknown-object'))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 32),
    timestamp: change.timestamp,
  };
}

function promptForgeSource(
  input: Pick<PromptForgeSourceCandidate, 'id' | 'label' | 'reference' | 'content'>,
  observedAt: number,
  explicit: boolean,
): PromptForgeSourceCandidate {
  return {
    id: input.id,
    kind: 'canvas',
    label: input.label,
    reference: input.reference,
    content: input.content,
    verified: true,
    explicit,
    projectScoped: true,
    trust: 'project',
    exactMatch: explicit,
    lexicalScore: explicit ? 1 : 0.75,
    semanticScore: null,
    taskIntentScore: explicit ? 1 : 0.5,
    observedAt,
    whySelected: explicit ? 'Current canvas selection' : 'Active canvas',
  };
}

function compilePrompt(
  canvas: CanvasAiContext['canvas'],
  selection: readonly CanvasAiBlockContext[],
  visibleFrame: CanvasAiFrameContext | null,
  linkedSources: readonly CanvasAiLinkedSourceContext[],
  recentChanges: readonly CanvasAiRecentChangeContext[],
  maximum: number,
): string {
  const lines = [
    `Active canvas: ${canvas.title} (${canvas.id})`,
    `Layout: ${canvas.layoutMode}; revision: ${canvas.localRevision}; blocks: ${canvas.blockCount}`,
  ];
  if (visibleFrame !== null) {
    lines.push(`Visible frame: ${visibleFrame.name} (${visibleFrame.id})`);
  }
  if (selection.length > 0) {
    lines.push('Selection:');
    for (const block of selection) {
      lines.push(`- ${block.label} (${block.id}): ${block.content}`);
    }
  }
  if (linkedSources.length > 0) {
    lines.push('Linked project sources:');
    for (const source of linkedSources) {
      lines.push(`- ${source.label} (${source.id}, ${source.sourceId}): ${source.summary}`);
    }
  }
  if (recentChanges.length > 0) {
    lines.push('Recent changes:');
    for (const change of recentChanges) {
      lines.push(`- ${change.label} (${change.id})`);
    }
  }
  return modelText(lines.join('\n'), maximum);
}

/**
 * Builds deterministic, concise Canvas context for Jarvis, the composer, and
 * Prompt Forge. Inputs are never mutated or retained by reference.
 */
export function compileCanvasAiContext(input: CanvasAiContextInput): CanvasAiContext {
  const limits = normalizeLimits(input.limits);
  const document = input.document;
  const blocks = new Map<string, CanvasBlock>(
    document.blocks.map((block) => [block.id, block] as const),
  );
  const order = documentOrder(document);
  const selectionIds = orderedKnownIds(
    input.selectedBlockIds ?? [],
    blocks,
    order,
    limits.maxSelectionBlocks,
  );
  const frameIsCurrent =
    input.visibleFrame !== null &&
    input.visibleFrame !== undefined &&
    input.visibleFrame.canvasId === document.id &&
    input.visibleFrame.projectId === document.projectId &&
    input.visibleFrame.ownerId === document.ownerId;
  const visibleIds = !frameIsCurrent
    ? []
    : orderedKnownIds(input.visibleFrame.children, blocks, order, limits.maxVisibleBlocks);
  const selection = selectionIds.map((id) =>
    blockContext(blocks.get(id)!, limits.maxBlockCharacters),
  );
  const visibleBlocks = visibleIds.map((id) =>
    blockContext(blocks.get(id)!, limits.maxBlockCharacters),
  );

  const visibleFrame: CanvasAiFrameContext | null = !frameIsCurrent
    ? null
    : {
        id: safeId(input.visibleFrame.id, 'unknown-frame'),
        name: modelText(input.visibleFrame.name, 200),
        childIds: visibleIds,
        bounds: {
          x: input.visibleFrame.x,
          y: input.visibleFrame.y,
          width: input.visibleFrame.width,
          height: input.visibleFrame.height,
        },
        locked: input.visibleFrame.locked,
        collapsed: input.visibleFrame.collapsed,
      };

  const linkedProjectSources = [...(input.linkedProjectSources ?? [])]
    .filter(
      (source) => source.projectId === document.projectId && source.ownerId === document.ownerId,
    )
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .slice(0, limits.maxLinkedSources)
    .map((source) => linkedSourceContext(source, limits.maxSourceCharacters));

  const recentChanges = [...(input.recentChanges ?? [])]
    .filter(
      (change) =>
        change.canvasId === document.id &&
        change.projectId === document.projectId &&
        change.ownerId === document.ownerId,
    )
    .sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id))
    .slice(0, limits.maxRecentChanges)
    .map(recentChangeContext);

  const attachments = [...(input.attachments ?? [])]
    .filter(
      (attachment) =>
        attachment.projectId === document.projectId &&
        attachment.ownerId === document.ownerId &&
        (isTextAttachment(attachment) ||
          input.capabilities?.includeBinaryAttachmentMetadata === true),
    )
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .slice(0, limits.maxAttachments)
    .map((attachment) =>
      attachmentContext(attachment, !isTextAttachment(attachment), limits.maxSourceCharacters),
    );

  const slash = input.composer?.slashReference;
  const slashTargets = new Set([
    ...blocks.keys(),
    ...linkedProjectSources.flatMap((source) => [source.id, source.sourceId]),
  ]);
  const slashIsCurrent =
    slash !== undefined &&
    slash !== null &&
    slash.canvasId === document.id &&
    slash.projectId === document.projectId &&
    slash.ownerId === document.ownerId &&
    slashTargets.has(slash.targetId);
  const slashReference: CanvasAiComposerContext['slashReference'] = !slashIsCurrent
    ? null
    : {
        token: modelText(slash.token, 64),
        targetId: safeId(slash.targetId, 'unknown-target'),
        label: modelText(slash.label, 200),
      };
  const snapshot = input.composer?.snapshot;
  const snapshotIsCurrent =
    snapshot !== undefined &&
    snapshot !== null &&
    snapshot.canvasId === document.id &&
    snapshot.projectId === document.projectId &&
    snapshot.ownerId === document.ownerId;
  const composer: CanvasAiComposerContext = {
    currentCanvasId: safeId(document.id, 'unknown-canvas'),
    selectedBlockIds: selectionIds,
    visibleFrameId: visibleFrame?.id ?? null,
    snapshotId: !snapshotIsCurrent ? null : safeId(snapshot.id, 'unknown-snapshot'),
    snapshotLabel: !snapshotIsCurrent ? null : modelText(snapshot.label, 200),
    snapshotCapturedAt: !snapshotIsCurrent ? null : snapshot.capturedAt,
    slashReference,
  };

  const canvas: CanvasAiContext['canvas'] = {
    id: safeId(document.id, 'unknown-canvas'),
    projectId: safeId(document.projectId, 'unknown-project'),
    title: modelText(document.title, 200),
    layoutMode: document.layoutMode,
    localRevision: document.localRevision,
    updatedAt: document.updatedAt,
    camera: {
      x: document.camera.x,
      y: document.camera.y,
      zoom: document.camera.zoom,
    },
    blockCount: document.blocks.length,
    blockKinds: Object.fromEntries(
      [...new Set(document.blocks.map((block) => block.content.kind))]
        .sort((left, right) => left.localeCompare(right))
        .map((kind) => [
          kind,
          document.blocks.filter((block) => block.content.kind === kind).length,
        ]),
    ),
  };

  const promptForgeSources: PromptForgeSourceCandidate[] = [
    promptForgeSource(
      {
        id: `canvas:${canvas.id}`,
        label: canvas.title,
        reference: `canvas:${canvas.id}`,
        content: compilePrompt(
          canvas,
          selection,
          visibleFrame,
          linkedProjectSources,
          recentChanges,
          limits.maxSourceCharacters,
        ),
      },
      document.updatedAt,
      false,
    ),
    ...selection.map((block) =>
      promptForgeSource(
        {
          id: `canvas-block:${canvas.id}:${block.id}`,
          label: block.label,
          reference: `canvas:${canvas.id}#${block.id}`,
          content: block.content,
        },
        block.updatedAt,
        true,
      ),
    ),
  ];

  const warnings: string[] = [];
  const binaryCount = (input.attachments ?? []).filter(
    (attachment) => !isTextAttachment(attachment),
  ).length;
  if (binaryCount > 0 && input.capabilities?.includeBinaryAttachmentMetadata !== true) {
    warnings.push(`${binaryCount} binary attachment${binaryCount === 1 ? '' : 's'} omitted`);
  }
  if (selectionIds.length < new Set(input.selectedBlockIds ?? []).size) {
    warnings.push('Unknown or excess selection references omitted');
  }

  return deepFreezeJarvisCopy({
    canvas,
    selection,
    visibleBlocks,
    visibleFrame,
    linkedProjectSources,
    recentChanges,
    attachments,
    composer,
    promptForgeSources,
    prompt: compilePrompt(
      canvas,
      selection,
      visibleFrame,
      linkedProjectSources,
      recentChanges,
      limits.maxPromptCharacters,
    ),
    warnings,
  }) as CanvasAiContext;
}

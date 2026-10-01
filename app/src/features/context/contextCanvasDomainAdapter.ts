/**
 * Strict, versioned compatibility adapter between the canonical Infinite Idea
 * Canvas domain contracts (`../canvas/contracts`) and the existing Context /
 * open JSON Canvas bridge (`./contextCanvasIntegration`).
 *
 * The bridge `VibeSpaceCanvasDocument` is treated as a transient compatibility
 * projection of the canonical domain document, never a second persistent model.
 * Content ownership always flows from the canonical `CanvasBlock` store; the
 * adapter only re-shapes that content plus geometry across the boundary and
 * reuses the bridge's own validated `exportOpenJsonCanvas` boundary so unsafe
 * URLs, dangling edges, duplicate ids, and hostile fields fail closed with the
 * exact bridge errors.
 */

import {
  CANVAS_SCHEMA_VERSION,
  CanvasValidationError,
  pageOrderedBlocks,
  parseCanvasDocument,
  resolveEdgelessLayout,
  type CanvasDocument,
} from '../canvas/contracts';
import { branchToOutline } from '../canvas/mindmaps';
import {
  exportOpenJsonCanvas,
  type OpenJsonCanvasNode,
  type VibeSpaceCanvasDocument,
  type VibeSpaceCanvasObject,
} from './contextCanvasIntegration';

/** Adapter contract version; independent of either side's schema version. */
export const CANVAS_DOMAIN_ADAPTER_VERSION = 1;

/** Mirrors the bridge's maximum projected text length so projections stay valid. */
const BRIDGE_MAX_TEXT = 32_768;
/** Mirrors the bridge's derived label length convention. */
const BRIDGE_LABEL_LENGTH = 120;

export interface DomainToBridgeProjectionOptions {
  readonly now?: number;
  readonly selectedBlockIds?: readonly string[];
}

export interface BridgeToDomainAdaptationOptions {
  readonly ownerId: string;
  readonly projectId?: string;
  readonly now?: number;
}

function assertPlainDocument(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CanvasValidationError('invalid-type', path, 'expected a plain object');
  }
}

function assertSchemaVersion(value: unknown, path: string): void {
  if (value !== CANVAS_SCHEMA_VERSION) {
    throw new CanvasValidationError('unsupported-value', path, 'unsupported schema version');
  }
}

function projectBlockText(text: string): string {
  return text.length > BRIDGE_MAX_TEXT ? text.slice(0, BRIDGE_MAX_TEXT) : text;
}

function projectBlockLabel(text: string): string {
  return text.trim().slice(0, BRIDGE_LABEL_LENGTH) || 'Text';
}

/**
 * Projects a canonical domain document into a transient bridge document.
 * Block ids become object ids (preserving `canvas:<canvasId>:<objectId>`
 * references), block content becomes the object's projected text, and edgeless
 * geometry comes from stored placements or the deterministic automatic layout.
 * The projection carries no `compatibilitySource` and is never persisted.
 */
export function projectDomainDocumentToBridge(
  doc: CanvasDocument,
  options: DomainToBridgeProjectionOptions = {},
): Readonly<VibeSpaceCanvasDocument> {
  assertPlainDocument(doc, 'document');
  assertSchemaVersion(doc.schemaVersion, 'document.schemaVersion');
  const selected = new Set(options.selectedBlockIds ?? []);
  const layout = resolveEdgelessLayout(doc);
  const objects: readonly VibeSpaceCanvasObject[] = pageOrderedBlocks(doc).map((block) => {
    const placement = layout.get(block.id);
    if (!placement) {
      throw new CanvasValidationError(
        'invalid-reference',
        'document.blocks',
        'missing placement for block',
      );
    }
    const text =
      block.content.kind === 'mind-map'
        ? branchToOutline(block.content.map, block.content.map.rootId)
        : block.content.kind === 'shape'
          ? (block.content.shape.text ?? block.content.shape.kind)
          : block.content.kind === 'stroke'
            ? `${block.content.tool} stroke`
            : block.content.kind === 'image'
              ? `Image: ${block.content.altText || block.content.name}`
              : block.content.text;
    const object: VibeSpaceCanvasObject = Object.freeze({
      id: block.id,
      type: 'text' as const,
      label: projectBlockLabel(text),
      text: projectBlockText(text),
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      selected: selected.has(block.id),
      contextReferences: Object.freeze([]),
    });
    return object;
  });
  const projection: Readonly<VibeSpaceCanvasDocument> = Object.freeze({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: doc.id,
    projectId: doc.projectId,
    title: doc.title,
    updatedAt: options.now ?? doc.updatedAt,
    objects: Object.freeze(objects),
    connections: Object.freeze([]),
  });
  return projection;
}

function bridgeNodePayload(node: OpenJsonCanvasNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'link') return node.url ?? '';
  if (node.type === 'file') return node.file ?? '';
  return node.label ?? '';
}

/**
 * Adapts a bridge document into a validated canonical domain document. The
 * bridge input is first passed through the bridge's own `exportOpenJsonCanvas`
 * boundary so unsafe URLs, dangling edges, duplicate ids, and hostile fields
 * fail closed with the exact bridge errors. Each bridge object becomes one
 * canonical text block plus an edgeless placement; object order becomes the
 * deterministic page order. The result is a fresh, deeply frozen domain
 * document and never a second persistent copy of bridge content.
 */
export function adaptBridgeDocumentToDomain(
  bridge: VibeSpaceCanvasDocument,
  options: BridgeToDomainAdaptationOptions,
): CanvasDocument {
  assertPlainDocument(bridge, 'document');
  assertSchemaVersion(bridge.schemaVersion, 'document.schemaVersion');
  const normalized = exportOpenJsonCanvas(bridge);
  const projectId = options.projectId ?? bridge.projectId;
  if (projectId === null || projectId === undefined) {
    throw new CanvasValidationError(
      'invalid-reference',
      'document.projectId',
      'domain adaptation requires a non-null project id',
    );
  }
  const now = options.now ?? bridge.updatedAt;
  const blocks = normalized.nodes.map((node) => ({
    id: node.id,
    content: { kind: 'text' as const, text: bridgeNodePayload(node) },
    createdAt: now,
    updatedAt: now,
  }));
  const placements = normalized.nodes.map((node) => ({
    blockId: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: 0,
    z: 0,
  }));
  return parseCanvasDocument({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: bridge.id,
    projectId,
    ownerId: options.ownerId,
    title: bridge.title,
    layoutMode: 'edgeless',
    blocks,
    pageOrder: normalized.nodes.map((node) => node.id),
    placements,
    createdAt: now,
    updatedAt: now,
  });
}

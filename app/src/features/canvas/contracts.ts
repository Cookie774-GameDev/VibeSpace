/**
 * Infinite Idea Canvas domain contracts.
 *
 * Framework-agnostic, deterministic, side-effect-free data contracts for the
 * shared page/edgeless canvas document model. A canvas document stores one
 * canonical set of content blocks. Page mode renders those blocks in a
 * deterministic page order while edgeless mode renders the same blocks at
 * spatial placements kept in separate metadata. Blocks without a stored
 * placement receive a deterministic automatic grid layout. Every factory,
 * parser, and transition validates its inputs and fails closed with a
 * `CanvasValidationError`; all returned documents are deeply frozen.
 */

import { validateMindMap, type MindMap } from './mindmaps';
import { parseCanvasShape, type CanvasShape } from './shapes';
import {
  DEFAULT_CANVAS_WALLPAPER,
  normalizeWallpaperConfig,
} from '@/features/workbench/wallpaperConfig';
import type { WorkbenchWallpaperConfig } from '@/features/workbench/types';

// ---------------------------------------------------------------------------
// Validation errors

export type CanvasValidationErrorCode =
  | 'invalid-type'
  | 'invalid-id'
  | 'invalid-timestamp'
  | 'invalid-number'
  | 'duplicate-id'
  | 'invalid-reference'
  | 'unsupported-value';

export class CanvasValidationError extends Error {
  readonly code: CanvasValidationErrorCode;
  readonly path: string;

  constructor(code: CanvasValidationErrorCode, path: string, message: string) {
    super(`Canvas validation failed (${code}) at ${path}: ${message}`);
    this.name = 'CanvasValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: CanvasValidationErrorCode, path: string, message: string): never {
  throw new CanvasValidationError(code, path, message);
}

// ---------------------------------------------------------------------------
// Constants and branded identifiers
// ---------------------------------------------------------------------------

export const CANVAS_SCHEMA_VERSION = 1;

/** Stable id shape: alphanumeric nanoid-style tokens, 1-64 chars. */
export const CANVAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const CANVAS_MAX_TITLE_LENGTH = 200;
export const CANVAS_MAX_TEXT_LENGTH = 100_000;
export const CANVAS_MAX_TIMESTAMP = 8_640_000_000_000_000;

/** Bounded camera zoom: 5% to 3200%. */
export const CANVAS_MIN_ZOOM = 0.05;
export const CANVAS_MAX_ZOOM = 32;

const MAX_COORDINATE = 1_000_000_000;
const MAX_SIZE = 10_000_000;
const MAX_ROTATION = 360;
const MAX_ICON_LENGTH = 32;
const MAX_THUMBNAIL_LENGTH = 2048;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const CODE_LANGUAGE_PATTERN = /^[A-Za-z0-9+#.-]{1,32}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

declare const canvasDocumentBrand: unique symbol;
declare const canvasBlockBrand: unique symbol;
declare const canvasOwnerBrand: unique symbol;
declare const canvasProjectBrand: unique symbol;

export type CanvasDocumentId = string & { [canvasDocumentBrand]: 'CanvasDocumentId' };
export type CanvasBlockId = string & { [canvasBlockBrand]: 'CanvasBlockId' };
export type CanvasOwnerId = string & { [canvasOwnerBrand]: 'CanvasOwnerId' };
export type CanvasProjectId = string & { [canvasProjectBrand]: 'CanvasProjectId' };

/** Milliseconds since the Unix epoch; validated non-negative safe integer. */
export type CanvasTimestamp = number;

// ---------------------------------------------------------------------------
// Layout mode
// ---------------------------------------------------------------------------

export const CANVAS_LAYOUT_MODES = ['page', 'edgeless'] as const;
export type CanvasLayoutMode = (typeof CANVAS_LAYOUT_MODES)[number];

export function isCanvasLayoutMode(value: unknown): value is CanvasLayoutMode {
  return value === 'page' || value === 'edgeless';
}

// ---------------------------------------------------------------------------
// Camera, background, blocks, placements
// ---------------------------------------------------------------------------

/**
 * View state only. `x`/`y` are the world coordinates at the viewport center
 * and `zoom` is the world-to-screen scale. Screen-space positions are never
 * persisted as document coordinates.
 */
export interface CanvasCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const CANVAS_BACKGROUND_KINDS = ['plain', 'grid', 'dots', 'lines'] as const;
export type CanvasBackgroundKind = (typeof CANVAS_BACKGROUND_KINDS)[number];

export interface CanvasBackground {
  readonly kind: CanvasBackgroundKind;
  readonly color: string;
  readonly wallpaper?: WorkbenchWallpaperConfig;
}

export type ResolvedCanvasBackground = CanvasBackground & {
  readonly wallpaper: WorkbenchWallpaperConfig;
};

export const CANVAS_BLOCK_KINDS = ['heading', 'text', 'note', 'code', 'mind-map', 'shape'] as const;
export type CanvasBlockKind = (typeof CANVAS_BLOCK_KINDS)[number];

export type CanvasBlockContent =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'mind-map'; readonly map: MindMap }
  | { readonly kind: 'shape'; readonly shape: CanvasShape };

/** Canonical shared content object. Rendered identically by both layouts. */
export interface CanvasBlock {
  readonly id: CanvasBlockId;
  readonly content: CanvasBlockContent;
  readonly createdAt: CanvasTimestamp;
  readonly updatedAt: CanvasTimestamp;
}

/**
 * Spatial metadata for edgeless mode, kept strictly separate from content.
 * Carries no content payload, only a block reference and geometry.
 */
export interface CanvasSpatialPlacement {
  readonly blockId: CanvasBlockId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly z: number;
  readonly locked: boolean;
  readonly hidden: boolean;
}

export interface CanvasSpatialPlacementInput {
  readonly blockId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
  readonly z?: number;
  readonly locked?: boolean;
  readonly hidden?: boolean;
}

export interface CanvasPresentationNote {
  readonly frameId: CanvasBlockId;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface CanvasDocument {
  readonly schemaVersion: typeof CANVAS_SCHEMA_VERSION;
  readonly id: CanvasDocumentId;
  readonly projectId: CanvasProjectId;
  readonly ownerId: CanvasOwnerId;
  readonly title: string;
  readonly icon: string | null;
  readonly thumbnail: string | null;
  readonly layoutMode: CanvasLayoutMode;
  readonly camera: CanvasCamera;
  readonly background: ResolvedCanvasBackground;
  /** Single canonical content store shared by page and edgeless views. */
  readonly blocks: readonly CanvasBlock[];
  /** Deterministic rendering order for page mode; exact permutation of block ids. */
  readonly pageOrder: readonly CanvasBlockId[];
  /** Edgeless spatial metadata; references blocks, never duplicates content. */
  readonly placements: readonly CanvasSpatialPlacement[];
  /** Presentation frame order; unique subset of block ids. */
  readonly presentationOrder: readonly CanvasBlockId[];
  /** Bounded presenter-only notes, canonically ordered by presentationOrder. */
  readonly presentationNotes: readonly CanvasPresentationNote[];
  readonly localRevision: number;
  readonly syncRevision: number;
  readonly createdAt: CanvasTimestamp;
  readonly updatedAt: CanvasTimestamp;
  readonly archivedAt: CanvasTimestamp | null;
  readonly deletedAt: CanvasTimestamp | null;
}

export interface CreateCanvasDocumentInput {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly now: number;
  readonly title?: string;
  readonly icon?: string | null;
  readonly thumbnail?: string | null;
  readonly layoutMode?: CanvasLayoutMode;
  readonly camera?: CanvasCamera;
  readonly background?: CanvasBackground;
}

export interface CreateCanvasBlockInput {
  readonly id: string;
  readonly content: CanvasBlockContent;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Low-level validators
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('unsupported-value', `${path}.${key}`, `unexpected field "${key}"`);
    }
  }
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail('invalid-type', path, 'expected a string');
  }
  return value;
}

function assertId(value: unknown, path: string): string {
  const text = assertString(value, path);
  if (!CANVAS_ID_PATTERN.test(text)) {
    fail('invalid-id', path, 'expected a stable id matching /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/');
  }
  return text;
}

function assertTimestamp(value: unknown, path: string): CanvasTimestamp {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('invalid-timestamp', path, 'expected an integer timestamp');
  }
  if (value < 0 || value > CANVAS_MAX_TIMESTAMP) {
    fail('invalid-timestamp', path, `timestamp out of range [0, ${CANVAS_MAX_TIMESTAMP}]`);
  }
  return value;
}

interface FiniteNumberBounds {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: boolean;
}

function assertFiniteNumber(value: unknown, path: string, bounds: FiniteNumberBounds = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-number', path, 'expected a finite number');
  }
  const { min, max, exclusiveMin } = bounds;
  if (min !== undefined && (exclusiveMin ? value <= min : value < min)) {
    fail('invalid-number', path, 'value below the allowed minimum');
  }
  if (max !== undefined && value > max) {
    fail('invalid-number', path, 'value above the allowed maximum');
  }
  return value;
}

function assertSafeInteger(
  value: unknown,
  path: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('invalid-number', path, 'expected a safe integer');
  }
  if (bounds.min !== undefined && value < bounds.min) {
    fail('invalid-number', path, `value must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    fail('invalid-number', path, `value must be <= ${bounds.max}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    Object.freeze(value);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------

const CAMERA_KEYS = new Set(['x', 'y', 'zoom']);

function normalizeCamera(input: unknown, path: string): CanvasCamera {
  if (!isPlainObject(input)) {
    fail('invalid-type', path, 'expected a camera object');
  }
  assertExactKeys(input, CAMERA_KEYS, path);
  const x = assertFiniteNumber(input.x, `${path}.x`, { min: -MAX_COORDINATE, max: MAX_COORDINATE });
  const y = assertFiniteNumber(input.y, `${path}.y`, { min: -MAX_COORDINATE, max: MAX_COORDINATE });
  const zoom = assertFiniteNumber(input.zoom, `${path}.zoom`, {
    min: CANVAS_MIN_ZOOM,
    max: CANVAS_MAX_ZOOM,
  });
  return { x, y, zoom };
}

const BACKGROUND_KEYS = new Set(['kind', 'color', 'wallpaper']);

function normalizeBackground(input: unknown, path: string): ResolvedCanvasBackground {
  if (!isPlainObject(input)) {
    fail('invalid-type', path, 'expected a background object');
  }
  assertExactKeys(input, BACKGROUND_KEYS, path);
  const kind = assertString(input.kind, `${path}.kind`);
  if (!CANVAS_BACKGROUND_KINDS.includes(kind as CanvasBackgroundKind)) {
    fail('unsupported-value', `${path}.kind`, `unsupported background kind "${kind}"`);
  }
  const color = assertString(input.color, `${path}.color`);
  if (!COLOR_PATTERN.test(color)) {
    fail('unsupported-value', `${path}.color`, 'expected a #rrggbb hex color');
  }
  return {
    kind: kind as CanvasBackgroundKind,
    color,
    wallpaper: normalizeWallpaperConfig(input.wallpaper, DEFAULT_CANVAS_WALLPAPER),
  };
}

const CONTENT_KEYS_BY_KIND: Record<CanvasBlockKind, readonly string[]> = {
  heading: ['kind', 'level', 'text'],
  text: ['kind', 'text'],
  note: ['kind', 'text'],
  code: ['kind', 'language', 'text'],
  'mind-map': ['kind', 'map'],
  shape: ['kind', 'shape'],
};

function normalizeContent(input: unknown, path: string): CanvasBlockContent {
  if (!isPlainObject(input)) {
    fail('invalid-type', path, 'expected a block content object');
  }
  const kind = assertString(input.kind, `${path}.kind`);
  if (!CANVAS_BLOCK_KINDS.includes(kind as CanvasBlockKind)) {
    fail('unsupported-value', `${path}.kind`, `unsupported block kind "${kind}"`);
  }
  const blockKind = kind as CanvasBlockKind;
  assertExactKeys(input, new Set(CONTENT_KEYS_BY_KIND[blockKind]), path);
  if (blockKind === 'mind-map') {
    return { kind: 'mind-map', map: validateMindMap(input.map) };
  }
  if (blockKind === 'shape') {
    return { kind: 'shape', shape: parseCanvasShape(input.shape) };
  }
  const text = assertString(input.text, `${path}.text`);
  if (text.length > CANVAS_MAX_TEXT_LENGTH) {
    fail('unsupported-value', `${path}.text`, `text exceeds ${CANVAS_MAX_TEXT_LENGTH} characters`);
  }
  if (blockKind === 'heading') {
    const level = assertSafeInteger(input.level, `${path}.level`, { min: 1, max: 6 });
    return { kind: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, text };
  }
  if (blockKind === 'code') {
    const language = assertString(input.language, `${path}.language`);
    if (!CODE_LANGUAGE_PATTERN.test(language)) {
      fail('unsupported-value', `${path}.language`, 'unsupported code language token');
    }
    return { kind: 'code', language, text };
  }
  if (blockKind === 'note') {
    return { kind: 'note', text };
  }
  return { kind: 'text', text };
}

const BLOCK_KEYS = new Set(['id', 'content', 'createdAt', 'updatedAt']);

function normalizeBlock(input: unknown, path: string): CanvasBlock {
  if (!isPlainObject(input)) {
    fail('invalid-type', path, 'expected a block object');
  }
  assertExactKeys(input, BLOCK_KEYS, path);
  const id = assertId(input.id, `${path}.id`) as CanvasBlockId;
  const content = normalizeContent(input.content, `${path}.content`);
  const createdAt = assertTimestamp(input.createdAt, `${path}.createdAt`);
  const updatedAt = assertTimestamp(input.updatedAt, `${path}.updatedAt`);
  if (updatedAt < createdAt) {
    fail('invalid-timestamp', `${path}.updatedAt`, 'updatedAt precedes createdAt');
  }
  if (content.kind === 'shape' && content.shape.id !== id) {
    fail('invalid-reference', `${path}.content.shape.id`, 'shape id must match its block id');
  }
  return deepFreeze({ id, content, createdAt, updatedAt });
}

const PLACEMENT_KEYS = new Set([
  'blockId',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'z',
  'locked',
  'hidden',
]);

function normalizePlacement(input: unknown, path: string): CanvasSpatialPlacement {
  if (!isPlainObject(input)) {
    fail('invalid-type', path, 'expected a placement object');
  }
  assertExactKeys(input, PLACEMENT_KEYS, path);
  const blockId = assertId(input.blockId, `${path}.blockId`) as CanvasBlockId;
  const x = assertFiniteNumber(input.x, `${path}.x`, { min: -MAX_COORDINATE, max: MAX_COORDINATE });
  const y = assertFiniteNumber(input.y, `${path}.y`, { min: -MAX_COORDINATE, max: MAX_COORDINATE });
  const width = assertFiniteNumber(input.width, `${path}.width`, {
    min: 0,
    exclusiveMin: true,
    max: MAX_SIZE,
  });
  const height = assertFiniteNumber(input.height, `${path}.height`, {
    min: 0,
    exclusiveMin: true,
    max: MAX_SIZE,
  });
  const rotation =
    input.rotation === undefined
      ? 0
      : assertFiniteNumber(input.rotation, `${path}.rotation`, {
          min: -MAX_ROTATION,
          max: MAX_ROTATION,
        });
  const z = input.z === undefined ? 0 : assertSafeInteger(input.z, `${path}.z`);
  const locked = input.locked === undefined ? false : input.locked;
  if (typeof locked !== 'boolean') {
    fail('invalid-type', `${path}.locked`, 'expected a boolean');
  }
  const hidden = input.hidden === undefined ? false : input.hidden;
  if (typeof hidden !== 'boolean') {
    fail('invalid-type', `${path}.hidden`, 'expected a boolean');
  }
  return deepFreeze({ blockId, x, y, width, height, rotation, z, locked, hidden });
}

function normalizeTitle(value: unknown, path: string): string {
  const text = assertString(value, path).trim();
  if (CONTROL_CHAR_PATTERN.test(text)) {
    fail('unsupported-value', path, 'title contains control characters');
  }
  if (text.length > CANVAS_MAX_TITLE_LENGTH) {
    fail('unsupported-value', path, `title exceeds ${CANVAS_MAX_TITLE_LENGTH} characters`);
  }
  return text === '' ? 'Untitled' : text;
}

function normalizeOptionalText(value: unknown, path: string, maxLength: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = assertString(value, path);
  if (text.length === 0 || text.length > maxLength || CONTROL_CHAR_PATTERN.test(text)) {
    fail('unsupported-value', path, `expected 1-${maxLength} printable characters`);
  }
  return text;
}
// ---------------------------------------------------------------------------
// Parsing and factories
// ---------------------------------------------------------------------------

const DOCUMENT_KEYS = new Set([
  'schemaVersion',
  'id',
  'projectId',
  'ownerId',
  'title',
  'icon',
  'thumbnail',
  'layoutMode',
  'camera',
  'background',
  'blocks',
  'pageOrder',
  'placements',
  'presentationOrder',
  'presentationNotes',
  'localRevision',
  'syncRevision',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'deletedAt',
]);
const PRESENTATION_NOTE_KEYS = new Set(['frameId', 'text']);

/**
 * Strictly validates unknown input as a canvas document. Fails closed on
 * malformed ids, timestamps, numeric fields, duplicate ids, invalid object
 * references, unknown fields, and unsupported schema values. The result is
 * deeply frozen.
 */
export function parseCanvasDocument(input: unknown): CanvasDocument {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'document', 'expected a plain object');
  }
  assertExactKeys(input, DOCUMENT_KEYS, 'document');

  if (input.schemaVersion !== undefined && input.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    fail('unsupported-value', 'document.schemaVersion', 'unsupported schema version');
  }

  const id = assertId(input.id, 'document.id') as CanvasDocumentId;
  const projectId = assertId(input.projectId, 'document.projectId') as CanvasProjectId;
  const ownerId = assertId(input.ownerId, 'document.ownerId') as CanvasOwnerId;
  const createdAt = assertTimestamp(input.createdAt, 'document.createdAt');
  const updatedAt = assertTimestamp(input.updatedAt, 'document.updatedAt');
  if (updatedAt < createdAt) {
    fail('invalid-timestamp', 'document.updatedAt', 'updatedAt precedes createdAt');
  }

  const title = normalizeTitle(
    input.title === undefined ? 'Untitled' : input.title,
    'document.title',
  );
  const icon = normalizeOptionalText(input.icon, 'document.icon', MAX_ICON_LENGTH);
  const thumbnail = normalizeOptionalText(
    input.thumbnail,
    'document.thumbnail',
    MAX_THUMBNAIL_LENGTH,
  );

  const layoutModeRaw = input.layoutMode === undefined ? 'page' : input.layoutMode;
  if (!isCanvasLayoutMode(layoutModeRaw)) {
    fail('unsupported-value', 'document.layoutMode', 'unsupported layout mode');
  }
  const layoutMode: CanvasLayoutMode = layoutModeRaw;

  const camera = normalizeCamera(
    input.camera === undefined ? { x: 0, y: 0, zoom: 1 } : input.camera,
    'document.camera',
  );
  const background = normalizeBackground(
    input.background === undefined ? { kind: 'plain', color: '#ffffff' } : input.background,
    'document.background',
  );

  const blocksRaw = input.blocks === undefined ? [] : input.blocks;
  if (!Array.isArray(blocksRaw)) {
    fail('invalid-type', 'document.blocks', 'expected an array');
  }
  const blocks = blocksRaw.map((item, index) => normalizeBlock(item, `document.blocks[${index}]`));
  const blockIds = new Set<CanvasBlockId>();
  for (const block of blocks) {
    if (blockIds.has(block.id)) {
      fail('duplicate-id', 'document.blocks', `duplicate block id "${block.id}"`);
    }
    blockIds.add(block.id);
  }

  const pageOrderRaw =
    input.pageOrder === undefined ? blocks.map((block) => block.id) : input.pageOrder;
  if (!Array.isArray(pageOrderRaw)) {
    fail('invalid-type', 'document.pageOrder', 'expected an array');
  }
  const pageOrder = pageOrderRaw.map(
    (item, index) => assertId(item, `document.pageOrder[${index}]`) as CanvasBlockId,
  );
  const pageOrderSeen = new Set<CanvasBlockId>();
  for (const blockId of pageOrder) {
    if (pageOrderSeen.has(blockId)) {
      fail('duplicate-id', 'document.pageOrder', `duplicate block id "${blockId}"`);
    }
    pageOrderSeen.add(blockId);
  }
  if (pageOrderSeen.size !== blockIds.size) {
    fail('invalid-reference', 'document.pageOrder', 'must list every block id exactly once');
  }
  for (const blockId of pageOrderSeen) {
    if (!blockIds.has(blockId)) {
      fail('invalid-reference', 'document.pageOrder', `references unknown block "${blockId}"`);
    }
  }

  const placementsRaw = input.placements === undefined ? [] : input.placements;
  if (!Array.isArray(placementsRaw)) {
    fail('invalid-type', 'document.placements', 'expected an array');
  }
  const placements = placementsRaw.map((item, index) =>
    normalizePlacement(item, `document.placements[${index}]`),
  );
  const placedIds = new Set<CanvasBlockId>();
  for (const placement of placements) {
    if (placedIds.has(placement.blockId)) {
      fail('duplicate-id', 'document.placements', `duplicate placement for "${placement.blockId}"`);
    }
    placedIds.add(placement.blockId);
    if (!blockIds.has(placement.blockId)) {
      fail(
        'invalid-reference',
        'document.placements',
        `references unknown block "${placement.blockId}"`,
      );
    }
  }

  const presentationRaw = input.presentationOrder === undefined ? [] : input.presentationOrder;
  if (!Array.isArray(presentationRaw)) {
    fail('invalid-type', 'document.presentationOrder', 'expected an array');
  }
  const presentationOrder = presentationRaw.map(
    (item, index) => assertId(item, `document.presentationOrder[${index}]`) as CanvasBlockId,
  );
  const presentationSeen = new Set<CanvasBlockId>();
  for (const blockId of presentationOrder) {
    if (presentationSeen.has(blockId)) {
      fail('duplicate-id', 'document.presentationOrder', `duplicate block id "${blockId}"`);
    }
    presentationSeen.add(blockId);
    if (!blockIds.has(blockId)) {
      fail(
        'invalid-reference',
        'document.presentationOrder',
        `references unknown block "${blockId}"`,
      );
    }
  }

  const presentationNotesRaw = input.presentationNotes === undefined ? [] : input.presentationNotes;
  if (!Array.isArray(presentationNotesRaw)) {
    fail('invalid-type', 'document.presentationNotes', 'expected an array');
  }
  const presentationNotesByFrame = new Map<CanvasBlockId, string>();
  for (const [index, entry] of presentationNotesRaw.entries()) {
    const path = `document.presentationNotes[${index}]`;
    if (!isPlainObject(entry)) {
      fail('invalid-type', path, 'expected a plain object');
    }
    assertExactKeys(entry, PRESENTATION_NOTE_KEYS, path);
    const frameId = assertId(entry.frameId, `${path}.frameId`) as CanvasBlockId;
    if (!presentationSeen.has(frameId)) {
      fail(
        'invalid-reference',
        `${path}.frameId`,
        `references frame "${frameId}" outside presentationOrder`,
      );
    }
    if (presentationNotesByFrame.has(frameId)) {
      fail('duplicate-id', 'document.presentationNotes', `duplicate frame id "${frameId}"`);
    }
    const text = assertString(entry.text, `${path}.text`);
    if (text.length > CANVAS_MAX_TEXT_LENGTH) {
      fail(
        'unsupported-value',
        `${path}.text`,
        `text exceeds ${CANVAS_MAX_TEXT_LENGTH} characters`,
      );
    }
    presentationNotesByFrame.set(frameId, text);
  }
  const presentationNotes = presentationOrder.flatMap((frameId) => {
    const text = presentationNotesByFrame.get(frameId);
    return text ? [{ frameId, text }] : [];
  });

  const localRevision = assertSafeInteger(
    input.localRevision === undefined ? 0 : input.localRevision,
    'document.localRevision',
    { min: 0 },
  );
  const syncRevision = assertSafeInteger(
    input.syncRevision === undefined ? 0 : input.syncRevision,
    'document.syncRevision',
    { min: 0 },
  );

  const archivedAt =
    input.archivedAt === null || input.archivedAt === undefined
      ? null
      : assertTimestamp(input.archivedAt, 'document.archivedAt');
  if (archivedAt !== null && archivedAt < createdAt) {
    fail('invalid-timestamp', 'document.archivedAt', 'archivedAt precedes createdAt');
  }
  const deletedAt =
    input.deletedAt === null || input.deletedAt === undefined
      ? null
      : assertTimestamp(input.deletedAt, 'document.deletedAt');
  if (deletedAt !== null && deletedAt < createdAt) {
    fail('invalid-timestamp', 'document.deletedAt', 'deletedAt precedes createdAt');
  }

  return deepFreeze({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id,
    projectId,
    ownerId,
    title,
    icon,
    thumbnail,
    layoutMode,
    camera,
    background,
    blocks,
    pageOrder,
    placements,
    presentationOrder,
    presentationNotes,
    localRevision,
    syncRevision,
    createdAt,
    updatedAt,
    archivedAt,
    deletedAt,
  });
}

/** Structural guard built on the strict parser. Never throws. */
export function isCanvasDocument(value: unknown): value is CanvasDocument {
  try {
    parseCanvasDocument(value);
    return true;
  } catch (error) {
    if (error instanceof CanvasValidationError) {
      return false;
    }
    throw error;
  }
}

export function parseCanvasDocumentId(value: unknown): CanvasDocumentId {
  return assertId(value, 'id') as CanvasDocumentId;
}

export function parseCanvasBlockId(value: unknown): CanvasBlockId {
  return assertId(value, 'id') as CanvasBlockId;
}

/** Creates a validated, frozen block. Content is validated fail-closed. */
export function createCanvasBlock(input: CreateCanvasBlockInput): CanvasBlock {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'block', 'expected an input object');
  }
  return normalizeBlock(
    { id: input.id, content: input.content, createdAt: input.now, updatedAt: input.now },
    'block',
  );
}

/** Creates a validated, frozen empty document with deterministic defaults. */
export function createCanvasDocument(input: CreateCanvasDocumentInput): CanvasDocument {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'document', 'expected an input object');
  }
  return parseCanvasDocument({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: input.id,
    projectId: input.projectId,
    ownerId: input.ownerId,
    title: input.title === undefined ? 'Untitled' : input.title,
    icon: input.icon === undefined ? null : input.icon,
    thumbnail: input.thumbnail === undefined ? null : input.thumbnail,
    layoutMode: input.layoutMode === undefined ? 'page' : input.layoutMode,
    camera: input.camera === undefined ? { x: 0, y: 0, zoom: 1 } : input.camera,
    background:
      input.background === undefined ? { kind: 'plain', color: '#ffffff' } : input.background,
    blocks: [],
    pageOrder: [],
    placements: [],
    presentationOrder: [],
    presentationNotes: [],
    localRevision: 0,
    syncRevision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    deletedAt: null,
  });
}
// ---------------------------------------------------------------------------
// Pure document transitions
// ---------------------------------------------------------------------------

function transition(
  doc: CanvasDocument,
  changes: Record<string, unknown>,
  now: number,
): CanvasDocument {
  return parseCanvasDocument({
    ...doc,
    ...changes,
    updatedAt: now,
    localRevision: doc.localRevision + 1,
  });
}

function requireBlockIndex(doc: CanvasDocument, blockId: string): number {
  const id = parseCanvasBlockId(blockId);
  const index = doc.blocks.findIndex((block) => block.id === id);
  if (index < 0) {
    fail('invalid-reference', 'blocks', `references unknown block "${blockId}"`);
  }
  return index;
}

export function withTitle(doc: CanvasDocument, title: string, now: number): CanvasDocument {
  return transition(doc, { title }, now);
}

export function withLayoutMode(
  doc: CanvasDocument,
  layoutMode: CanvasLayoutMode,
  now: number,
): CanvasDocument {
  return transition(doc, { layoutMode }, now);
}

export function withBackground(
  doc: CanvasDocument,
  background: CanvasBackground,
  now: number,
): CanvasDocument {
  return transition(
    doc,
    {
      background: {
        ...background,
        wallpaper: background.wallpaper ?? doc.background.wallpaper,
      },
    },
    now,
  );
}

/**
 * Edits the single canonical block shared by page and edgeless views. Both
 * layouts observe the new content; no copy is made.
 */
export function withBlockContent(
  doc: CanvasDocument,
  blockId: string,
  content: CanvasBlockContent,
  now: number,
): CanvasDocument {
  const index = requireBlockIndex(doc, blockId);
  const normalized = normalizeContent(content, 'content');
  const blocks = doc.blocks.map((block, i) =>
    i === index ? { ...block, content: normalized, updatedAt: now } : block,
  );
  return transition(doc, { blocks }, now);
}

export function withBlockAdded(
  doc: CanvasDocument,
  block: CanvasBlock,
  now: number,
  atIndex?: number,
): CanvasDocument {
  const normalized = normalizeBlock(block, 'block');
  if (doc.blocks.some((existing) => existing.id === normalized.id)) {
    fail('duplicate-id', 'blocks', `duplicate block id "${normalized.id}"`);
  }
  const index =
    atIndex === undefined
      ? doc.blocks.length
      : assertSafeInteger(atIndex, 'atIndex', { min: 0, max: doc.blocks.length });
  const blocks = [...doc.blocks.slice(0, index), normalized, ...doc.blocks.slice(index)];
  const pageOrder = [
    ...doc.pageOrder.slice(0, index),
    normalized.id,
    ...doc.pageOrder.slice(index),
  ];
  return transition(doc, { blocks, pageOrder }, now);
}

/** Removes a block plus its placement and presentation references. */
export function withBlockRemoved(
  doc: CanvasDocument,
  blockId: string,
  now: number,
): CanvasDocument {
  const id = parseCanvasBlockId(blockId);
  if (!doc.blocks.some((block) => block.id === id)) {
    fail('invalid-reference', 'blocks', `references unknown block "${blockId}"`);
  }
  return transition(
    doc,
    {
      blocks: doc.blocks.filter((block) => block.id !== id),
      pageOrder: doc.pageOrder.filter((entry) => entry !== id),
      placements: doc.placements.filter((placement) => placement.blockId !== id),
      presentationOrder: doc.presentationOrder.filter((entry) => entry !== id),
      presentationNotes: doc.presentationNotes.filter((entry) => entry.frameId !== id),
    },
    now,
  );
}

export function withPageOrder(
  doc: CanvasDocument,
  order: readonly string[],
  now: number,
): CanvasDocument {
  return transition(doc, { pageOrder: order }, now);
}

export function withPresentationOrder(
  doc: CanvasDocument,
  order: readonly string[],
  now: number,
): CanvasDocument {
  const retained = new Set(order.map((frameId) => parseCanvasBlockId(frameId)));
  return transition(
    doc,
    {
      presentationOrder: order,
      presentationNotes: doc.presentationNotes.filter((entry) => retained.has(entry.frameId)),
    },
    now,
  );
}

/** Adds, replaces, or clears bounded presenter notes for one included frame. */
export function withPresentationNote(
  doc: CanvasDocument,
  frameId: string,
  text: string,
  now: number,
): CanvasDocument {
  const id = parseCanvasBlockId(frameId);
  if (!doc.presentationOrder.includes(id)) {
    fail(
      'invalid-reference',
      'presentationNotes.frameId',
      `references frame "${id}" outside presentationOrder`,
    );
  }
  const validatedText = assertString(text, 'presentationNotes.text');
  if (validatedText.length > CANVAS_MAX_TEXT_LENGTH) {
    fail(
      'unsupported-value',
      'presentationNotes.text',
      `text exceeds ${CANVAS_MAX_TEXT_LENGTH} characters`,
    );
  }
  const presentationNotes = [
    ...doc.presentationNotes.filter((entry) => entry.frameId !== id),
    ...(validatedText ? [{ frameId: id, text: validatedText }] : []),
  ];
  return transition(doc, { presentationNotes }, now);
}

/** Upserts edgeless spatial metadata for an existing block. */
export function withPlacement(
  doc: CanvasDocument,
  placement: CanvasSpatialPlacementInput,
  now: number,
): CanvasDocument {
  const normalized = normalizePlacement(placement, 'placement');
  if (!doc.blocks.some((block) => block.id === normalized.blockId)) {
    fail(
      'invalid-reference',
      'placement.blockId',
      `references unknown block "${normalized.blockId}"`,
    );
  }
  const placements = [
    ...doc.placements.filter((entry) => entry.blockId !== normalized.blockId),
    normalized,
  ];
  return transition(doc, { placements }, now);
}

/** Removes a placement. Returns the same document when nothing is placed. */
export function withoutPlacement(
  doc: CanvasDocument,
  blockId: string,
  now: number,
): CanvasDocument {
  const id = parseCanvasBlockId(blockId);
  if (!doc.placements.some((placement) => placement.blockId === id)) {
    return doc;
  }
  return transition(
    doc,
    { placements: doc.placements.filter((placement) => placement.blockId !== id) },
    now,
  );
}

/**
 * Updates view-only camera state. Does not bump revisions or updatedAt
 * because camera position is not document content.
 */
export function withCamera(doc: CanvasDocument, camera: CanvasCamera): CanvasDocument {
  const normalized = normalizeCamera(camera, 'camera');
  return parseCanvasDocument({ ...doc, camera: normalized });
}

export function withArchived(doc: CanvasDocument, archived: boolean, now: number): CanvasDocument {
  if (typeof archived !== 'boolean') {
    fail('invalid-type', 'archived', 'expected a boolean');
  }
  const archivedAt = archived ? now : null;
  if (doc.archivedAt === archivedAt) {
    return doc;
  }
  return transition(doc, { archivedAt }, now);
}

export function withDeleted(doc: CanvasDocument, deleted: boolean, now: number): CanvasDocument {
  if (typeof deleted !== 'boolean') {
    fail('invalid-type', 'deleted', 'expected a boolean');
  }
  const deletedAt = deleted ? now : null;
  if (doc.deletedAt === deletedAt) {
    return doc;
  }
  return transition(doc, { deletedAt }, now);
}

// ---------------------------------------------------------------------------
// Derived views and automatic layout
// ---------------------------------------------------------------------------

/** Blocks in deterministic page-mode order. Shares references with `doc.blocks`. */
export function pageOrderedBlocks(doc: CanvasDocument): readonly CanvasBlock[] {
  const byId = new Map<CanvasBlockId, CanvasBlock>(doc.blocks.map((block) => [block.id, block]));
  return Object.freeze(doc.pageOrder.map((id) => byId.get(id)!));
}

export function blockById(doc: CanvasDocument, blockId: string): CanvasBlock | undefined {
  const id = parseCanvasBlockId(blockId);
  return doc.blocks.find((block) => block.id === id);
}

export function placementsByBlockId(
  doc: CanvasDocument,
): ReadonlyMap<CanvasBlockId, CanvasSpatialPlacement> {
  return new Map(doc.placements.map((placement) => [placement.blockId, placement]));
}

/**
 * Deterministic automatic grid layout for blocks without stored placements,
 * ordered by page order so results are stable across calls and sessions.
 */
export const CANVAS_AUTO_LAYOUT = Object.freeze({
  columns: 4,
  blockWidth: 280,
  blockHeight: 180,
  gapX: 48,
  gapY: 48,
} as const);

export function computeAutomaticPlacements(doc: CanvasDocument): readonly CanvasSpatialPlacement[] {
  const placed = new Set<CanvasBlockId>(doc.placements.map((placement) => placement.blockId));
  const pending = doc.pageOrder.filter((id) => !placed.has(id));
  const { columns, blockWidth, blockHeight, gapX, gapY } = CANVAS_AUTO_LAYOUT;
  return Object.freeze(
    pending.map((blockId, index) =>
      deepFreeze({
        blockId,
        x: (index % columns) * (blockWidth + gapX),
        y: Math.floor(index / columns) * (blockHeight + gapY),
        width: blockWidth,
        height: blockHeight,
        rotation: 0,
        z: 0,
        locked: false,
        hidden: false,
      }),
    ),
  );
}

/**
 * Resolves the full edgeless layout: stored placements win, and every
 * remaining block receives a deterministic automatic placement. Returns a
 * fresh map per call so callers cannot mutate shared state.
 */
export function resolveEdgelessLayout(
  doc: CanvasDocument,
): ReadonlyMap<CanvasBlockId, CanvasSpatialPlacement> {
  const resolved = new Map<CanvasBlockId, CanvasSpatialPlacement>();
  for (const placement of doc.placements) {
    resolved.set(placement.blockId, placement);
  }
  for (const placement of computeAutomaticPlacements(doc)) {
    resolved.set(placement.blockId, placement);
  }
  return resolved;
}

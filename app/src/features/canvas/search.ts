/**
 * Infinite Idea Canvas search domain.
 *
 * Framework-agnostic, deterministic, side-effect-free search and focus-target
 * contracts for the shared canvas. A pure search index filters and ranks
 * projected canvas objects by text, tag, object type, frame, linked source,
 * status, and database field. Every result carries a validated world-space
 * focus target that the camera can zoom to. Global document projections expose
 * only canvas titles and textual content with validated focus geometry; binary
 * and private payloads (icons, thumbnails, camera view state) never leak into a
 * projection. All parsers validate inputs and fail closed with a
 * CanvasValidationError; all returned values are deeply frozen. UI and global
 * registry integration is coordinator-owned and lives outside this module.
 */

import {
  CANVAS_ID_PATTERN,
  CANVAS_MAX_TEXT_LENGTH,
  CANVAS_MAX_TITLE_LENGTH,
  CanvasValidationError,
  pageOrderedBlocks,
  resolveEdgelessLayout,
  type CanvasCamera,
  type CanvasDocument,
} from './contracts';
import { fitWorldBounds, type CanvasViewport, type CanvasWorldBounds } from './camera';
import { branchToOutline } from './mindmaps';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_RESULT_LIMIT = 50;
export const MAX_RESULT_LIMIT = 200;

const MAX_OBJECT_TYPE_LENGTH = 32;
const MAX_STATUS_LENGTH = 64;
const MAX_TAG_LENGTH = 64;
const MAX_TAGS_PER_OBJECT = 64;
const MAX_LINKED_SOURCE_LENGTH = 2048;
const MAX_DATABASE_FIELDS_PER_OBJECT = 64;
const MAX_DATABASE_FIELD_VALUE_LENGTH = 1000;
const MAX_FOCUS_COORDINATE = 1_000_000_000;
const MAX_FOCUS_SIZE = 10_000_000;
const MAX_INDEX_OBJECTS = 100_000;
const MAX_QUERY_TEXT_LENGTH = 1000;
const MAX_QUERY_TOKENS = 16;

export const CANVAS_SEARCH_LIMITS = Object.freeze({
  maxObjects: MAX_INDEX_OBJECTS,
  maxTagsPerObject: MAX_TAGS_PER_OBJECT,
  maxTagLength: MAX_TAG_LENGTH,
  maxDatabaseFieldsPerObject: MAX_DATABASE_FIELDS_PER_OBJECT,
  maxDatabaseFieldValueLength: MAX_DATABASE_FIELD_VALUE_LENGTH,
  maxLinkedSourceLength: MAX_LINKED_SOURCE_LENGTH,
  maxStatusLength: MAX_STATUS_LENGTH,
  maxObjectTypeLength: MAX_OBJECT_TYPE_LENGTH,
  maxQueryTextLength: MAX_QUERY_TEXT_LENGTH,
  maxQueryTokens: MAX_QUERY_TOKENS,
  defaultResultLimit: DEFAULT_RESULT_LIMIT,
  maxResultLimit: MAX_RESULT_LIMIT,
});

const TOKEN_SPLIT_PATTERN = /[^\p{L}\p{N}]+/u;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const OBJECT_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FIELD_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const FOCUS_KEYS = new Set(['x', 'y', 'width', 'height']);
const QUERY_KEYS = new Set([
  'text',
  'objectType',
  'tag',
  'frameId',
  'linkedSource',
  'status',
  'databaseField',
  'limit',
]);
const DATABASE_FIELD_KEYS = new Set(['field', 'value']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

declare const canvasSearchObjectIdBrand: unique symbol;
export type CanvasSearchObjectId = string & {
  [canvasSearchObjectIdBrand]: 'CanvasSearchObjectId';
};

/** World-space bounds the camera can fit. Validated finite and bounded. */
export interface CanvasSearchFocusTarget {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Loose, untrusted input shape for a searchable canvas object. */
export interface CanvasSearchObjectInput {
  readonly id: string;
  readonly objectType: string;
  readonly title?: string;
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly frameId?: string | null;
  readonly linkedSource?: string | null;
  readonly status?: string | null;
  readonly databaseFields?: Readonly<Record<string, string>>;
  readonly focus: CanvasSearchFocusTarget;
}

/** A validated, normalized, frozen searchable canvas object. */
export interface CanvasSearchObject {
  readonly id: CanvasSearchObjectId;
  readonly objectType: string;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly frameId: string | null;
  readonly linkedSource: string | null;
  readonly status: string | null;
  readonly databaseFields: Readonly<Record<string, string>>;
  readonly focus: CanvasSearchFocusTarget;
}

export interface CanvasSearchDatabaseFieldFilter {
  readonly field: string;
  readonly value?: string;
}

export interface CanvasSearchQueryInput {
  readonly text?: string;
  readonly objectType?: string;
  readonly tag?: string;
  readonly frameId?: string;
  readonly linkedSource?: string;
  readonly status?: string;
  readonly databaseField?: CanvasSearchDatabaseFieldFilter;
  readonly limit?: number;
}

/** A validated, normalized, frozen query. Absent filters are null. */
export interface CanvasSearchQuery {
  readonly text: string | null;
  readonly tokens: readonly string[];
  readonly objectType: string | null;
  readonly tag: string | null;
  readonly frameId: string | null;
  readonly linkedSource: string | null;
  readonly status: string | null;
  readonly databaseField: CanvasSearchDatabaseFieldFilter | null;
  readonly limit: number;
}

export interface CanvasSearchResult {
  readonly object: CanvasSearchObject;
  readonly score: number;
  readonly focus: CanvasSearchFocusTarget;
}

export interface CanvasSearchIndex {
  readonly size: number;
  query(query: CanvasSearchQueryInput): readonly CanvasSearchResult[];
}

/** A safe, search-only projection of a canvas document. */
export interface CanvasDocumentSearchProjection {
  readonly documentId: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly objects: readonly CanvasSearchObject[];
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

type CanvasSearchValidationCode =
  'invalid-type' | 'invalid-id' | 'invalid-number' | 'duplicate-id' | 'unsupported-value';

function fail(code: CanvasSearchValidationCode, path: string, message: string): never {
  throw new CanvasValidationError(code, path, message);
}

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
      fail('unsupported-value', path + '.' + key, 'unexpected field "' + key + '"');
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

function assertPrintable(value: string, path: string): void {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    fail('unsupported-value', path, 'value contains control characters');
  }
}

/** Deterministic, locale-independent case normalization. */
function caseKey(value: string): string {
  return value.trim().toLowerCase();
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(TOKEN_SPLIT_PATTERN)
    .filter((token) => token.length > 0)
    .slice(0, MAX_QUERY_TOKENS);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Focus target validation
// ---------------------------------------------------------------------------

function focusNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-number', path, 'expected a finite number');
  }
  return value;
}

export function parseCanvasSearchFocusTarget(input: unknown): CanvasSearchFocusTarget {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'focus', 'expected a plain object');
  }
  assertExactKeys(input, FOCUS_KEYS, 'focus');
  const x = focusNumber(input.x, 'focus.x');
  const y = focusNumber(input.y, 'focus.y');
  const width = focusNumber(input.width, 'focus.width');
  const height = focusNumber(input.height, 'focus.height');
  if (x < -MAX_FOCUS_COORDINATE || x > MAX_FOCUS_COORDINATE) {
    fail('invalid-number', 'focus.x', 'coordinate out of bounds');
  }
  if (y < -MAX_FOCUS_COORDINATE || y > MAX_FOCUS_COORDINATE) {
    fail('invalid-number', 'focus.y', 'coordinate out of bounds');
  }
  if (width < 0 || width > MAX_FOCUS_SIZE) {
    fail('invalid-number', 'focus.width', 'size out of bounds');
  }
  if (height < 0 || height > MAX_FOCUS_SIZE) {
    fail('invalid-number', 'focus.height', 'size out of bounds');
  }
  return Object.freeze({ x, y, width, height });
}

// ---------------------------------------------------------------------------
// Object validation
// ---------------------------------------------------------------------------

function normalizeTags(value: unknown, path: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    fail('invalid-type', path, 'expected an array');
  }
  if (value.length > MAX_TAGS_PER_OBJECT) {
    fail('unsupported-value', path, 'too many tags (max ' + MAX_TAGS_PER_OBJECT + ')');
  }
  const normalized = new Set<string>();
  value.forEach((item, index) => {
    const tagPath = path + '[' + index + ']';
    const text = assertString(item, tagPath).trim();
    if (text.length === 0) {
      fail('unsupported-value', tagPath, 'tag must not be empty');
    }
    if (text.length > MAX_TAG_LENGTH) {
      fail('unsupported-value', tagPath, 'tag exceeds ' + MAX_TAG_LENGTH + ' characters');
    }
    assertPrintable(text, tagPath);
    normalized.add(text.toLowerCase());
  });
  return Object.freeze([...normalized].sort());
}

function normalizeDatabaseFields(value: unknown, path: string): Readonly<Record<string, string>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    fail('invalid-type', path, 'expected a plain object');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_DATABASE_FIELDS_PER_OBJECT) {
    fail('unsupported-value', path, 'too many fields (max ' + MAX_DATABASE_FIELDS_PER_OBJECT + ')');
  }
  const entries: Array<[string, string]> = keys.map((key) => {
    const fieldPath = path + '.' + key;
    if (!FIELD_KEY_PATTERN.test(key)) {
      fail('unsupported-value', fieldPath, 'unsupported field key');
    }
    const text = assertString(value[key], fieldPath).trim();
    if (text.length > MAX_DATABASE_FIELD_VALUE_LENGTH) {
      fail(
        'unsupported-value',
        fieldPath,
        'value exceeds ' + MAX_DATABASE_FIELD_VALUE_LENGTH + ' characters',
      );
    }
    assertPrintable(text, fieldPath);
    return [key.toLowerCase(), text];
  });
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const fields: Record<string, string> = {};
  for (const [key, text] of entries) {
    fields[key] = text;
  }
  return Object.freeze(fields);
}

export function parseCanvasSearchObject(input: unknown): CanvasSearchObject {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'object', 'expected a plain object');
  }
  const id = assertId(input.id, 'object.id') as CanvasSearchObjectId;

  const objectType = caseKey(assertString(input.objectType, 'object.objectType'));
  if (
    objectType.length === 0 ||
    objectType.length > MAX_OBJECT_TYPE_LENGTH ||
    !OBJECT_TYPE_PATTERN.test(objectType)
  ) {
    fail('unsupported-value', 'object.objectType', 'unsupported object type token');
  }

  const title = input.title === undefined ? '' : assertString(input.title, 'object.title').trim();
  if (title.length > CANVAS_MAX_TITLE_LENGTH) {
    fail(
      'unsupported-value',
      'object.title',
      'title exceeds ' + CANVAS_MAX_TITLE_LENGTH + ' characters',
    );
  }
  assertPrintable(title, 'object.title');

  const text = input.text === undefined ? '' : assertString(input.text, 'object.text');
  if (text.length > CANVAS_MAX_TEXT_LENGTH) {
    fail(
      'unsupported-value',
      'object.text',
      'text exceeds ' + CANVAS_MAX_TEXT_LENGTH + ' characters',
    );
  }

  const tags = normalizeTags(input.tags, 'object.tags');

  const frameId =
    input.frameId === undefined || input.frameId === null
      ? null
      : assertId(input.frameId, 'object.frameId');

  let linkedSource: string | null = null;
  if (input.linkedSource !== undefined && input.linkedSource !== null) {
    const trimmed = assertString(input.linkedSource, 'object.linkedSource').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LINKED_SOURCE_LENGTH) {
      fail('unsupported-value', 'object.linkedSource', 'unsupported linked source');
    }
    assertPrintable(trimmed, 'object.linkedSource');
    linkedSource = trimmed;
  }

  let status: string | null = null;
  if (input.status !== undefined && input.status !== null) {
    const trimmed = assertString(input.status, 'object.status').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_STATUS_LENGTH) {
      fail('unsupported-value', 'object.status', 'unsupported status token');
    }
    assertPrintable(trimmed, 'object.status');
    status = trimmed.toLowerCase();
  }

  const databaseFields = normalizeDatabaseFields(input.databaseFields, 'object.databaseFields');
  const focus = parseCanvasSearchFocusTarget(input.focus);

  return deepFreeze({
    id,
    objectType,
    title,
    text,
    tags,
    frameId,
    linkedSource,
    status,
    databaseFields,
    focus,
  });
}

export function parseCanvasSearchObjects(
  inputs: readonly unknown[],
): readonly CanvasSearchObject[] {
  if (!Array.isArray(inputs)) {
    fail('invalid-type', 'objects', 'expected an array');
  }
  if (inputs.length > MAX_INDEX_OBJECTS) {
    fail('unsupported-value', 'objects', 'too many objects (max ' + MAX_INDEX_OBJECTS + ')');
  }
  const seen = new Set<CanvasSearchObjectId>();
  const objects = inputs.map((item) => {
    const object = parseCanvasSearchObject(item);
    if (seen.has(object.id)) {
      fail('duplicate-id', 'objects', 'duplicate object id "' + object.id + '"');
    }
    seen.add(object.id);
    return object;
  });
  return Object.freeze(objects);
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

export function parseCanvasSearchQuery(input: unknown): CanvasSearchQuery {
  if (!isPlainObject(input)) {
    fail('invalid-type', 'query', 'expected a plain object');
  }
  assertExactKeys(input, QUERY_KEYS, 'query');

  let text: string | null = null;
  let tokens: readonly string[] = Object.freeze([]);
  if (input.text !== undefined) {
    const trimmed = assertString(input.text, 'query.text').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_QUERY_TEXT_LENGTH) {
      fail('unsupported-value', 'query.text', 'unsupported query text');
    }
    const parsed = tokenize(trimmed);
    if (parsed.length === 0) {
      fail('unsupported-value', 'query.text', 'query text has no searchable tokens');
    }
    text = trimmed;
    tokens = Object.freeze(parsed);
  }

  let objectType: string | null = null;
  if (input.objectType !== undefined) {
    objectType = caseKey(assertString(input.objectType, 'query.objectType'));
    if (!OBJECT_TYPE_PATTERN.test(objectType)) {
      fail('unsupported-value', 'query.objectType', 'unsupported object type token');
    }
  }

  let tag: string | null = null;
  if (input.tag !== undefined) {
    const trimmed = assertString(input.tag, 'query.tag').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TAG_LENGTH) {
      fail('unsupported-value', 'query.tag', 'unsupported tag');
    }
    assertPrintable(trimmed, 'query.tag');
    tag = trimmed.toLowerCase();
  }

  let frameId: string | null = null;
  if (input.frameId !== undefined) {
    frameId = assertId(input.frameId, 'query.frameId');
  }

  let linkedSource: string | null = null;
  if (input.linkedSource !== undefined) {
    const trimmed = assertString(input.linkedSource, 'query.linkedSource').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LINKED_SOURCE_LENGTH) {
      fail('unsupported-value', 'query.linkedSource', 'unsupported linked source');
    }
    assertPrintable(trimmed, 'query.linkedSource');
    linkedSource = trimmed;
  }

  let status: string | null = null;
  if (input.status !== undefined) {
    const trimmed = assertString(input.status, 'query.status').trim();
    if (trimmed.length === 0 || trimmed.length > MAX_STATUS_LENGTH) {
      fail('unsupported-value', 'query.status', 'unsupported status token');
    }
    assertPrintable(trimmed, 'query.status');
    status = trimmed.toLowerCase();
  }

  let databaseField: CanvasSearchDatabaseFieldFilter | null = null;
  if (input.databaseField !== undefined) {
    if (input.databaseField === null || !isPlainObject(input.databaseField)) {
      fail('invalid-type', 'query.databaseField', 'expected a plain object');
    }
    assertExactKeys(input.databaseField, DATABASE_FIELD_KEYS, 'query.databaseField');
    const field = caseKey(assertString(input.databaseField.field, 'query.databaseField.field'));
    if (!FIELD_KEY_PATTERN.test(field)) {
      fail('unsupported-value', 'query.databaseField.field', 'unsupported field key');
    }
    let value: string | undefined;
    if (input.databaseField.value !== undefined) {
      const trimmed = assertString(input.databaseField.value, 'query.databaseField.value').trim();
      if (trimmed.length > MAX_DATABASE_FIELD_VALUE_LENGTH) {
        fail('unsupported-value', 'query.databaseField.value', 'value too long');
      }
      assertPrintable(trimmed, 'query.databaseField.value');
      value = trimmed;
    }
    databaseField =
      value === undefined ? Object.freeze({ field }) : Object.freeze({ field, value });
  }

  let limit = DEFAULT_RESULT_LIMIT;
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit)) {
      fail('invalid-number', 'query.limit', 'expected an integer');
    }
    if (input.limit < 1 || input.limit > MAX_RESULT_LIMIT) {
      fail('unsupported-value', 'query.limit', 'limit out of range [1, ' + MAX_RESULT_LIMIT + ']');
    }
    limit = input.limit;
  }

  return Object.freeze({
    text,
    tokens,
    objectType,
    tag,
    frameId,
    linkedSource,
    status,
    databaseField,
    limit,
  });
}

// ---------------------------------------------------------------------------
// Indexing and ranking
// ---------------------------------------------------------------------------

interface IndexedEntry {
  readonly object: CanvasSearchObject;
  readonly titleNorm: string;
  readonly textNorm: string;
  readonly tagSet: ReadonlySet<string>;
  readonly linkedSourceNorm: string | null;
  readonly fieldNorm: Readonly<Record<string, string>>;
}

interface ScoredMatch {
  readonly entry: IndexedEntry;
  readonly score: number;
}

function buildEntry(object: CanvasSearchObject): IndexedEntry {
  const fieldNorm: Record<string, string> = {};
  for (const [key, value] of Object.entries(object.databaseFields)) {
    fieldNorm[key] = value.trim().toLowerCase();
  }
  return {
    object,
    titleNorm: object.title.trim().toLowerCase(),
    textNorm: object.text.toLowerCase(),
    tagSet: new Set(object.tags),
    linkedSourceNorm:
      object.linkedSource === null ? null : object.linkedSource.trim().toLowerCase(),
    fieldNorm: Object.freeze(fieldNorm),
  };
}

function fieldMatches(entry: IndexedEntry, token: string): boolean {
  for (const value of Object.values(entry.fieldNorm)) {
    if (value.includes(token)) {
      return true;
    }
  }
  return false;
}

function scoreEntry(entry: IndexedEntry, tokens: readonly string[], queryNorm: string): number {
  let score = 0;
  for (const token of tokens) {
    let weight = 0;
    if (entry.titleNorm.includes(token)) {
      weight = Math.max(weight, 100);
    }
    if (entry.tagSet.has(token)) {
      weight = Math.max(weight, 60);
    }
    if (fieldMatches(entry, token)) {
      weight = Math.max(weight, 30);
    }
    if (entry.textNorm.includes(token)) {
      weight = Math.max(weight, 20);
    }
    if (entry.object.objectType.includes(token)) {
      weight = Math.max(weight, 10);
    }
    if (entry.linkedSourceNorm !== null && entry.linkedSourceNorm.includes(token)) {
      weight = Math.max(weight, 8);
    }
    if (entry.object.status !== null && entry.object.status === token) {
      weight = Math.max(weight, 8);
    }
    score += weight;
  }
  if (tokens.length > 0 && entry.titleNorm !== '' && entry.titleNorm === queryNorm) {
    score += 200;
  }
  return score;
}

function passesFilters(entry: IndexedEntry, query: CanvasSearchQuery): boolean {
  if (query.objectType !== null && entry.object.objectType !== query.objectType) {
    return false;
  }
  if (query.tag !== null && !entry.tagSet.has(query.tag)) {
    return false;
  }
  if (query.frameId !== null && entry.object.frameId !== query.frameId) {
    return false;
  }
  if (query.linkedSource !== null) {
    const target = query.linkedSource.trim().toLowerCase();
    if (entry.linkedSourceNorm === null || entry.linkedSourceNorm !== target) {
      return false;
    }
  }
  if (query.status !== null && entry.object.status !== query.status) {
    return false;
  }
  if (query.databaseField !== null) {
    const fieldValue = entry.fieldNorm[query.databaseField.field];
    if (fieldValue === undefined) {
      return false;
    }
    if (query.databaseField.value !== undefined) {
      if (!fieldValue.includes(query.databaseField.value.trim().toLowerCase())) {
        return false;
      }
    }
  }
  return true;
}

function compareMatches(a: ScoredMatch, b: ScoredMatch): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const aTitle = a.entry.titleNorm;
  const bTitle = b.entry.titleNorm;
  if (aTitle !== bTitle) {
    return aTitle < bTitle ? -1 : 1;
  }
  const aType = a.entry.object.objectType;
  const bType = b.entry.object.objectType;
  if (aType !== bType) {
    return aType < bType ? -1 : 1;
  }
  const aId = a.entry.object.id;
  const bId = b.entry.object.id;
  if (aId !== bId) {
    return aId < bId ? -1 : 1;
  }
  return 0;
}

export function createCanvasSearchIndex(
  objects: readonly CanvasSearchObjectInput[],
): CanvasSearchIndex {
  const parsed = parseCanvasSearchObjects(objects as readonly unknown[]);
  const entries = Object.freeze(parsed.map(buildEntry));

  return Object.freeze({
    size: entries.length,
    query(queryInput: CanvasSearchQueryInput): readonly CanvasSearchResult[] {
      const query = parseCanvasSearchQuery(queryInput);
      const queryNorm = query.tokens.join(' ');
      const matches: ScoredMatch[] = [];
      for (const entry of entries) {
        if (!passesFilters(entry, query)) {
          continue;
        }
        const score = query.tokens.length > 0 ? scoreEntry(entry, query.tokens, queryNorm) : 0;
        if (query.tokens.length > 0 && score === 0) {
          continue;
        }
        matches.push({ entry, score });
      }
      matches.sort(compareMatches);
      const results = matches.slice(0, query.limit).map((match): CanvasSearchResult =>
        Object.freeze({
          object: match.entry.object,
          score: match.score,
          focus: match.entry.object.focus,
        }),
      );
      return Object.freeze(results);
    },
  });
}

// ---------------------------------------------------------------------------
// Camera focus integration
// ---------------------------------------------------------------------------

export function cameraForFocusTarget(
  focus: CanvasSearchFocusTarget,
  viewport: CanvasViewport,
  padding = 48,
): CanvasCamera {
  const bounds = parseCanvasSearchFocusTarget(focus);
  const world: CanvasWorldBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  return fitWorldBounds(world, viewport, padding);
}

// ---------------------------------------------------------------------------
// Global canvas document projection
// ---------------------------------------------------------------------------

function unionBounds(doc: CanvasDocument): CanvasSearchFocusTarget {
  const layout = resolveEdgelessLayout(doc);
  if (layout.size === 0) {
    return Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const placement of layout.values()) {
    minX = Math.min(minX, placement.x);
    minY = Math.min(minY, placement.y);
    maxX = Math.max(maxX, placement.x + placement.width);
    maxY = Math.max(maxY, placement.y + placement.height);
  }
  return Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

export function projectCanvasDocumentForSearch(
  doc: CanvasDocument,
): CanvasDocumentSearchProjection {
  const layout = resolveEdgelessLayout(doc);
  const documentFocus = unionBounds(doc);

  const inputs: CanvasSearchObjectInput[] = [
    {
      id: doc.id,
      objectType: 'document',
      title: doc.title,
      text: doc.title,
      tags: [],
      frameId: null,
      linkedSource: null,
      status: null,
      databaseFields: {},
      focus: documentFocus,
    },
  ];

  for (const block of pageOrderedBlocks(doc)) {
    const placement = layout.get(block.id);
    const focus: CanvasSearchFocusTarget =
      placement === undefined
        ? Object.freeze({ x: 0, y: 0, width: 0, height: 0 })
        : Object.freeze({
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
          });
    const text =
      block.content.kind === 'mind-map'
        ? branchToOutline(block.content.map, block.content.map.rootId)
        : block.content.kind === 'shape'
          ? (block.content.shape.text ?? '')
          : block.content.kind === 'stroke'
            ? `${block.content.tool} stroke`
            : block.content.kind === 'image'
              ? `${block.content.name} ${block.content.altText}`
              : block.content.text;
    inputs.push({
      id: block.id,
      objectType: block.content.kind,
      title: '',
      text,
      tags: [],
      frameId: doc.presentationOrder.includes(block.id) ? block.id : null,
      linkedSource: null,
      status: null,
      databaseFields: {},
      focus,
    });
  }

  // Deterministic id dedupe: the document title object wins any id collision.
  const seen = new Set<string>();
  const objects: CanvasSearchObject[] = [];
  for (const input of inputs) {
    if (seen.has(input.id)) {
      continue;
    }
    seen.add(input.id);
    objects.push(parseCanvasSearchObject(input));
  }

  return deepFreeze({
    documentId: doc.id,
    projectId: doc.projectId,
    ownerId: doc.ownerId,
    title: doc.title,
    objects: Object.freeze(objects),
  });
}

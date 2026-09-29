import type { CanvasAssetReference } from './assets';
import {
  pageOrderedBlocks,
  resolveEdgelessLayout,
  type CanvasBlock,
  type CanvasDocument,
  type CanvasLayoutMode,
  type CanvasSpatialPlacement,
} from './contracts';

const MAX_ACCESSIBLE_LABEL_LENGTH = 96;
const MAX_ANNOUNCEMENT_LENGTH = 180;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function boundedText(value: string, maximum = MAX_ACCESSIBLE_LABEL_LENGTH): string {
  const text = normalizedText(value);
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return Object.freeze(value);
}

function assertNonEmptyId(value: string, path: string): string {
  if (typeof value !== 'string' || normalizedText(value) === '') {
    throw new Error(`Canvas accessibility ${path} must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Labels and image alternatives

/** A bounded object label suitable for aria-label, an outline, or a live region. */
export function canvasBlockAccessibleLabel(block: CanvasBlock): string {
  const content = block.content;
  let label: string;
  switch (content.kind) {
    case 'heading':
      label = `Heading ${content.level}: ${content.text}`;
      break;
    case 'text':
      label = `Text: ${content.text}`;
      break;
    case 'note':
      label = `Note: ${content.text}`;
      break;
    case 'code':
      label = `Code (${content.language}): ${content.text}`;
      break;
    case 'mind-map': {
      const root = content.map.nodes.find((node) => node.id === content.map.rootId);
      label = `Mind map: ${root?.label ?? 'Untitled'}`;
      break;
    }
    case 'shape': {
      const kind = content.shape.kind.replaceAll('-', ' ');
      label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} shape: ${content.shape.text ?? 'Unlabeled'}`;
      break;
    }
    case 'stroke':
      label = `${content.tool === 'pencil' ? 'Pencil' : 'Marker'} stroke`;
      break;
    case 'image':
      label = `Image: ${content.altText || content.name}`;
      break;
  }
  return boundedText(label);
}

export type CanvasImageAltState = 'provided' | 'decorative' | 'missing' | 'required';

export interface CanvasImageAltDescriptor {
  readonly state: CanvasImageAltState;
  readonly text: string;
}

/**
 * Distinguishes intentional decorative images from images that still require
 * author-provided text. A missing binary is announced even when prior alt text
 * exists, so assistive technology never describes unavailable content as present.
 */
export function canvasImageAltText(asset: CanvasAssetReference): CanvasImageAltDescriptor {
  const filename = boundedText(asset.original.filename, 72);
  if (asset.missing) {
    return freeze({ state: 'missing', text: `Missing image: ${filename}` });
  }
  if (asset.altText === '') {
    return freeze({ state: 'decorative', text: '' });
  }
  if (asset.altText === null) {
    return freeze({ state: 'required', text: `Image description needed: ${filename}` });
  }
  if (normalizedText(asset.altText) === '') {
    return freeze({ state: 'required', text: `Image description needed: ${filename}` });
  }
  return freeze({ state: 'provided', text: boundedText(asset.altText) });
}

// ---------------------------------------------------------------------------
// Structured screen-reader outline

export type CanvasAccessibilityContainerKind = 'frame' | 'group';

export interface CanvasAccessibilityContainer {
  readonly id: string;
  readonly kind: CanvasAccessibilityContainerKind;
  readonly label: string;
  /** Exact reading order for direct child containers and document blocks. */
  readonly childIds: readonly string[];
}

export interface CanvasAccessibilityBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CanvasAccessibilityItemKind =
  | 'frame'
  | 'group'
  | 'heading'
  | 'text'
  | 'note'
  | 'code'
  | 'mind-map'
  | 'shape'
  | 'stroke'
  | 'image';

export interface CanvasAccessibilityItem {
  readonly id: string;
  readonly kind: CanvasAccessibilityItemKind;
  readonly role: 'region' | 'group' | 'heading' | 'article';
  readonly label: string;
  readonly level: number;
  readonly parentId: string;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly selected: boolean;
  readonly stateText: 'Selected' | 'Not selected';
  /** A visual shape plus an icon/checkmark; selection is never color-only. */
  readonly selectionCue: 'outline-and-checkmark';
  readonly bounds: CanvasAccessibilityBounds | null;
  readonly children: readonly CanvasAccessibilityItem[];
}

export interface CanvasScreenReaderOutline {
  readonly id: string;
  readonly kind: 'page';
  readonly role: 'document';
  readonly label: string;
  readonly level: 1;
  readonly children: readonly CanvasAccessibilityItem[];
  /** Focusable preorder, excluding the page document itself. */
  readonly flatItems: readonly CanvasAccessibilityItem[];
}

export interface BuildCanvasScreenReaderOutlineOptions {
  readonly containers?: readonly CanvasAccessibilityContainer[];
  readonly selectedIds?: readonly string[];
}

function itemRole(kind: CanvasAccessibilityItemKind): CanvasAccessibilityItem['role'] {
  if (kind === 'frame') return 'region';
  if (kind === 'group') return 'group';
  if (kind === 'heading') return 'heading';
  return 'article';
}

function placementBounds(
  placement: CanvasSpatialPlacement | undefined,
): CanvasAccessibilityBounds | null {
  if (!placement) return null;
  return freeze({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
  });
}

/**
 * Produces a deterministic accessibility tree. Page order governs ungrouped
 * objects, while each frame/group's `childIds` governs its explicit subtree.
 * Containers are placed at the position of their earliest page-ordered descendant.
 */
export function buildCanvasScreenReaderOutline(
  document: CanvasDocument,
  options: BuildCanvasScreenReaderOutlineOptions = {},
): CanvasScreenReaderOutline {
  const containers = options.containers ?? [];
  const selectedIds = new Set(options.selectedIds ?? []);
  const blocks = pageOrderedBlocks(document);
  const blockById = new Map(blocks.map((block) => [block.id as string, block]));
  const containerById = new Map<string, CanvasAccessibilityContainer>();
  const inputOrder = new Map<string, number>();

  containers.forEach((container, index) => {
    const id = assertNonEmptyId(container.id, `containers[${index}].id`);
    if (blockById.has(id) || containerById.has(id)) {
      throw new Error(`Canvas accessibility duplicate object id "${id}"`);
    }
    if (container.kind !== 'frame' && container.kind !== 'group') {
      throw new Error(`Canvas accessibility container "${id}" has an unsupported kind`);
    }
    if (boundedText(container.label) === '') {
      throw new Error(`Canvas accessibility container "${id}" must have a label`);
    }
    containerById.set(id, container);
    inputOrder.set(id, index);
  });

  const parentById = new Map<string, string>();
  for (const container of containers) {
    const seen = new Set<string>();
    for (const childIdValue of container.childIds) {
      const childId = assertNonEmptyId(childIdValue, `${container.id}.childIds`);
      if (seen.has(childId)) {
        throw new Error(
          `Canvas accessibility container "${container.id}" repeats child "${childId}"`,
        );
      }
      seen.add(childId);
      if (!blockById.has(childId) && !containerById.has(childId)) {
        throw new Error(
          `Canvas accessibility container "${container.id}" has unknown child "${childId}"`,
        );
      }
      const existingParent = parentById.get(childId);
      if (existingParent) {
        throw new Error(
          `Canvas accessibility object "${childId}" belongs to more than one container`,
        );
      }
      parentById.set(childId, container.id);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitContainer = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Canvas accessibility container cycle includes "${id}"`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const container = containerById.get(id)!;
    for (const childId of container.childIds) {
      if (containerById.has(childId)) visitContainer(childId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of containerById.keys()) visitContainer(id);

  const pageIndex = new Map(blocks.map((block, index) => [block.id as string, index]));
  const earliestDescendant = (id: string): number => {
    const directIndex = pageIndex.get(id);
    if (directIndex !== undefined) return directIndex;
    const container = containerById.get(id)!;
    let earliest = Number.POSITIVE_INFINITY;
    for (const childId of container.childIds) {
      earliest = Math.min(earliest, earliestDescendant(childId));
    }
    return earliest;
  };
  const topLevelIds = [
    ...blocks.map((block) => block.id as string),
    ...containers.map((container) => container.id),
  ]
    .filter((id) => !parentById.has(id))
    .sort((left, right) => {
      const byPage = earliestDescendant(left) - earliestDescendant(right);
      if (Number.isFinite(byPage) && byPage !== 0) return byPage;
      const leftInput = inputOrder.get(left) ?? Number.POSITIVE_INFINITY;
      const rightInput = inputOrder.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftInput !== rightInput) return leftInput - rightInput;
      return left.localeCompare(right);
    });
  const placements = resolveEdgelessLayout(document);

  const createItem = (
    id: string,
    parentId: string,
    level: number,
    positionInSet: number,
    setSize: number,
  ): CanvasAccessibilityItem => {
    const container = containerById.get(id);
    const block = blockById.get(id);
    const kind: CanvasAccessibilityItemKind = container?.kind ?? block!.content.kind;
    const childIds = container?.childIds ?? [];
    const children = childIds.map((childId, index) =>
      createItem(childId, id, level + 1, index + 1, childIds.length),
    );
    const selected = selectedIds.has(id);
    const semanticLevel = block?.content.kind === 'heading' ? block.content.level : level;
    return freeze({
      id,
      kind,
      role: itemRole(kind),
      label: container ? boundedText(container.label) : canvasBlockAccessibleLabel(block!),
      level: semanticLevel,
      parentId,
      positionInSet,
      setSize,
      selected,
      stateText: selected ? 'Selected' : 'Not selected',
      selectionCue: 'outline-and-checkmark',
      bounds: block ? placementBounds(placements.get(block.id)) : null,
      children,
    });
  };

  const children = topLevelIds.map((id, index) =>
    createItem(id, document.id, 2, index + 1, topLevelIds.length),
  );
  const flatItems: CanvasAccessibilityItem[] = [];
  const flatten = (items: readonly CanvasAccessibilityItem[]): void => {
    for (const item of items) {
      flatItems.push(item);
      flatten(item.children);
    }
  };
  flatten(children);

  return freeze({
    id: document.id,
    kind: 'page',
    role: 'document',
    label: boundedText(`Canvas page: ${document.title}`),
    level: 1,
    children,
    flatItems,
  });
}

// ---------------------------------------------------------------------------
// Focus and keyboard commands

export type CanvasNavigationDirection =
  'next' | 'previous' | 'home' | 'end' | 'left' | 'right' | 'up' | 'down';

function center(bounds: CanvasAccessibilityBounds): readonly [number, number] {
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2];
}

/** Returns a stable object id and never wraps unexpectedly at an edge. */
export function navigateCanvasObjects(
  items: readonly CanvasAccessibilityItem[],
  currentId: string | null,
  direction: CanvasNavigationDirection,
): string | null {
  if (items.length === 0) return null;
  const currentIndex = currentId === null ? -1 : items.findIndex((item) => item.id === currentId);
  if (direction === 'home') return items[0].id;
  if (direction === 'end') return items[items.length - 1].id;
  if (direction === 'next') {
    return items[Math.min(items.length - 1, Math.max(0, currentIndex + 1))].id;
  }
  if (direction === 'previous') {
    return items[Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1)].id;
  }
  if (currentIndex < 0) return items[0].id;

  const current = items[currentIndex];
  if (current.bounds) {
    const [currentX, currentY] = center(current.bounds);
    const candidates = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.id !== current.id && item.bounds !== null)
      .map(({ item, index }) => {
        const [x, y] = center(item.bounds!);
        const dx = x - currentX;
        const dy = y - currentY;
        const eligible =
          direction === 'left'
            ? dx < 0
            : direction === 'right'
              ? dx > 0
              : direction === 'up'
                ? dy < 0
                : dy > 0;
        const primary = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
        const secondary =
          direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
        return { item, index, eligible, score: primary * 1_000_000 + secondary };
      })
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => left.score - right.score || left.index - right.index);
    if (candidates[0]) return candidates[0].item.id;
  }

  const delta = direction === 'left' || direction === 'up' ? -1 : 1;
  const nextIndex = currentIndex + delta;
  return items[Math.max(0, Math.min(items.length - 1, nextIndex))].id;
}

/** Chooses the next surviving item, then the previous one, after deletion. */
export function findCanvasFocusSuccessor(
  items: readonly CanvasAccessibilityItem[],
  currentId: string,
  removedIds: readonly string[],
): string | null {
  const removed = new Set(removedIds);
  const index = items.findIndex((item) => item.id === currentId);
  if (index < 0) return items.find((item) => !removed.has(item.id))?.id ?? null;
  for (let offset = index + 1; offset < items.length; offset += 1) {
    if (!removed.has(items[offset].id)) return items[offset].id;
  }
  for (let offset = index - 1; offset >= 0; offset -= 1) {
    if (!removed.has(items[offset].id)) return items[offset].id;
  }
  return null;
}

export interface CanvasKeyboardInput {
  readonly key: string;
  readonly layoutMode: CanvasLayoutMode;
  readonly selectedIds: readonly string[];
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly editableTarget?: boolean;
}

export type CanvasKeyboardCommand =
  | { readonly type: 'create'; readonly kind: 'note' | 'text' | 'heading' | 'code' | 'mind-map' }
  | {
      readonly type: 'move';
      readonly ids: readonly string[];
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly type: 'activate'; readonly id: string }
  | { readonly type: 'delete'; readonly ids: readonly string[] }
  | { readonly type: 'clear-selection' };

/** Pure decoder for global canvas keyboard handling; editable controls are ignored. */
export function decodeCanvasKeyboardCommand(
  input: CanvasKeyboardInput,
): CanvasKeyboardCommand | null {
  if (input.editableTarget) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const selectedIds = Object.freeze([...new Set(input.selectedIds)]);

  if (input.altKey && input.shiftKey && !input.ctrlKey && !input.metaKey) {
    const kindByKey = {
      n: 'note',
      t: 'text',
      h: 'heading',
      c: 'code',
      m: 'mind-map',
    } as const;
    const kind = kindByKey[key as keyof typeof kindByKey];
    if (kind) return freeze({ type: 'create', kind });
  }
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (key === 'Escape' && selectedIds.length > 0) {
    return freeze({ type: 'clear-selection' });
  }
  if ((key === 'Delete' || key === 'Backspace') && selectedIds.length > 0) {
    return freeze({ type: 'delete', ids: selectedIds });
  }
  if ((key === 'Enter' || key === ' ') && selectedIds.length === 1) {
    return freeze({ type: 'activate', id: selectedIds[0] });
  }
  if (
    input.layoutMode === 'edgeless' &&
    selectedIds.length > 0 &&
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)
  ) {
    const amount = input.shiftKey ? 10 : 1;
    const deltas: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    };
    const [dx, dy] = deltas[key];
    return freeze({ type: 'move', ids: selectedIds, dx, dy });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preferences and live-region descriptions

export interface CanvasAccessibilityPreferences {
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly prefersMoreContrast: boolean;
}

export interface CanvasAccessibilityPolicy {
  readonly animationDurationMs: number;
  readonly animateCamera: boolean;
  readonly contrast: 'standard' | 'more' | 'forced';
  readonly focusIndicator: 'system-outline' | 'high-contrast-outline';
  readonly selectionIndicator: 'outline-and-checkmark';
  readonly useTransparency: boolean;
}

export function canvasAccessibilityPolicy(
  preferences: CanvasAccessibilityPreferences,
): CanvasAccessibilityPolicy {
  return freeze({
    animationDurationMs: preferences.reducedMotion ? 0 : 160,
    animateCamera: !preferences.reducedMotion,
    contrast: preferences.forcedColors
      ? 'forced'
      : preferences.prefersMoreContrast
        ? 'more'
        : 'standard',
    focusIndicator: preferences.forcedColors ? 'system-outline' : 'high-contrast-outline',
    selectionIndicator: 'outline-and-checkmark',
    useTransparency: !preferences.forcedColors && !preferences.prefersMoreContrast,
  });
}

export interface CanvasLiveAnnouncement {
  readonly politeness: 'polite' | 'assertive';
  readonly message: string;
}

export function canvasZoomAnnouncement(zoom: number): CanvasLiveAnnouncement {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error('Canvas accessibility zoom must be a positive finite number');
  }
  return freeze({
    politeness: 'polite',
    message: boundedText(`Canvas zoom ${Math.round(zoom * 100)} percent`, MAX_ANNOUNCEMENT_LENGTH),
  });
}

export type CanvasAnnouncementEvent =
  | { readonly type: 'created' | 'deleted' | 'selected'; readonly count: number }
  | { readonly type: 'moved'; readonly count: number; readonly dx: number; readonly dy: number }
  | { readonly type: 'focused'; readonly label: string }
  | { readonly type: 'zoomed'; readonly zoom: number };

function objectCount(count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Canvas accessibility object count must be a non-negative integer');
  }
  return `${count} canvas object${count === 1 ? '' : 's'}`;
}

export function canvasLiveAnnouncement(event: CanvasAnnouncementEvent): CanvasLiveAnnouncement {
  if (event.type === 'zoomed') return canvasZoomAnnouncement(event.zoom);
  let message: string;
  switch (event.type) {
    case 'created':
      message = `Created ${objectCount(event.count)}`;
      break;
    case 'deleted':
      message = `Deleted ${objectCount(event.count)}`;
      break;
    case 'selected':
      message = `Selected ${objectCount(event.count)}`;
      break;
    case 'focused':
      message = `Focused ${boundedText(event.label)}`;
      break;
    case 'moved': {
      if (!Number.isFinite(event.dx) || !Number.isFinite(event.dy)) {
        throw new Error('Canvas accessibility movement must be finite');
      }
      const parts = [`Moved ${objectCount(event.count)}`];
      if (event.dx !== 0)
        parts.push(`${event.dx < 0 ? 'left' : 'right'} ${Math.abs(event.dx)} pixels`);
      if (event.dy !== 0)
        parts.push(`${event.dy < 0 ? 'up' : 'down'} ${Math.abs(event.dy)} pixels`);
      message = parts.join(' ');
      break;
    }
  }
  return freeze({ politeness: 'polite', message: boundedText(message, MAX_ANNOUNCEMENT_LENGTH) });
}

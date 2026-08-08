import { describe, expect, it } from 'vitest';
import {
  CANVAS_AUTO_LAYOUT,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_SCHEMA_VERSION,
  CanvasValidationError,
  computeAutomaticPlacements,
  createCanvasBlock,
  createCanvasDocument,
  isCanvasDocument,
  isCanvasLayoutMode,
  pageOrderedBlocks,
  parseCanvasBlockId,
  parseCanvasDocument,
  parseCanvasDocumentId,
  placementsByBlockId,
  resolveEdgelessLayout,
  withBackground,
  withBlockAdded,
  withBlockContent,
  withBlockRemoved,
  withCamera,
  withDeleted,
  withArchived,
  withLayoutMode,
  withPageOrder,
  withPlacement,
  withPresentationNote,
  withPresentationOrder,
  withTitle,
  withoutPlacement,
  type CanvasBlock,
  type CanvasDocument,
} from './contracts';
import { createMindMap } from './mindmaps';
import { createCanvasShape } from './shapes';

const T0 = 1_750_000_000_000;
const T1 = T0 + 60_000;

function baseDoc(overrides: Record<string, unknown> = {}): CanvasDocument {
  return createCanvasDocument({
    id: 'doc-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    title: 'Ideas',
    now: T0,
    ...overrides,
  });
}

function block(id: string, text = 'hello', now = T0): CanvasBlock {
  return createCanvasBlock({ id, content: { kind: 'text', text }, now });
}

function docWithBlocks(): CanvasDocument {
  let doc = baseDoc();
  doc = withBlockAdded(doc, block('blk-a', 'alpha'), T0);
  doc = withBlockAdded(doc, block('blk-b', 'beta'), T0);
  doc = withBlockAdded(doc, block('blk-c', 'gamma'), T0);
  return doc;
}

function toUnknown(doc: CanvasDocument): unknown {
  return JSON.parse(JSON.stringify(doc)) as unknown;
}

describe('canvas id parsing', () => {
  it('accepts stable alphanumeric ids with hyphen and underscore', () => {
    expect(parseCanvasDocumentId('doc-1')).toBe('doc-1');
    expect(parseCanvasBlockId('blk_a1')).toBe('blk_a1');
    expect(parseCanvasBlockId('V1StGXR8_Z5jdHi6B-myT')).toBe('V1StGXR8_Z5jdHi6B-myT');
  });

  it.each([
    ['empty string', ''],
    ['leading hyphen', '-doc'],
    ['leading underscore', '_doc'],
    ['space inside', 'doc 1'],
    ['unicode', 'doc-é'],
    ['too long (65 chars)', 'a'.repeat(65)],
    ['punctuation', 'doc.1'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseCanvasDocumentId(value)).toThrow(CanvasValidationError);
    try {
      parseCanvasDocumentId(value);
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasValidationError);
      expect((error as CanvasValidationError).code).toBe('invalid-id');
    }
  });

  it('rejects non-string ids', () => {
    expect(() => parseCanvasBlockId(42)).toThrow(CanvasValidationError);
    expect(() => parseCanvasBlockId(null)).toThrow(CanvasValidationError);
  });
});

describe('createCanvasDocument', () => {
  it('creates a frozen document with deterministic defaults', () => {
    const doc = baseDoc();
    expect(doc.schemaVersion).toBe(CANVAS_SCHEMA_VERSION);
    expect(doc.id).toBe('doc-1');
    expect(doc.projectId).toBe('project-1');
    expect(doc.ownerId).toBe('owner-1');
    expect(doc.title).toBe('Ideas');
    expect(doc.icon).toBeNull();
    expect(doc.thumbnail).toBeNull();
    expect(doc.layoutMode).toBe('page');
    expect(doc.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(doc.background).toEqual({
      kind: 'plain',
      color: '#ffffff',
      wallpaper: {
        id: 'none',
        paused: false,
        interactive: true,
        intensity: 0.72,
        brightness: 0.5,
        quality: 'balanced',
      },
    });
    expect(doc.blocks).toEqual([]);
    expect(doc.pageOrder).toEqual([]);
    expect(doc.placements).toEqual([]);
    expect(doc.presentationOrder).toEqual([]);
    expect(doc.presentationNotes).toEqual([]);
    expect(doc.localRevision).toBe(0);
    expect(doc.syncRevision).toBe(0);
    expect(doc.createdAt).toBe(T0);
    expect(doc.updatedAt).toBe(T0);
    expect(doc.archivedAt).toBeNull();
    expect(doc.deletedAt).toBeNull();
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.blocks)).toBe(true);
    expect(Object.isFrozen(doc.camera)).toBe(true);
  });

  it('normalizes an empty title to Untitled and trims whitespace', () => {
    expect(baseDoc({ title: '' }).title).toBe('Untitled');
    expect(baseDoc({ title: '  Pinned  ' }).title).toBe('Pinned');
  });

  it('rejects malformed ids and scope ids', () => {
    expect(() => baseDoc({ id: '' })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ projectId: 'bad id' })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ ownerId: '-owner' })).toThrow(CanvasValidationError);
  });

  it('rejects malformed timestamps', () => {
    expect(() => baseDoc({ now: Number.NaN })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ now: -1 })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ now: 1.5 })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ now: Number.POSITIVE_INFINITY })).toThrow(CanvasValidationError);
  });

  it('rejects non-finite or out-of-bounds camera zoom', () => {
    expect(() => baseDoc({ camera: { x: 0, y: 0, zoom: Number.NaN } })).toThrow(
      CanvasValidationError,
    );
    expect(() => baseDoc({ camera: { x: 0, y: 0, zoom: CANVAS_MIN_ZOOM / 2 } })).toThrow(
      CanvasValidationError,
    );
    expect(() => baseDoc({ camera: { x: 0, y: 0, zoom: CANVAS_MAX_ZOOM * 2 } })).toThrow(
      CanvasValidationError,
    );
  });

  it('rejects unsupported layout modes and background kinds', () => {
    expect(() => baseDoc({ layoutMode: '3d' })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ background: { kind: 'video', color: '#000000' } })).toThrow(
      CanvasValidationError,
    );
    expect(() => baseDoc({ background: { kind: 'plain', color: 'white' } })).toThrow(
      CanvasValidationError,
    );
  });

  it('normalizes a Canvas-owned ambience wallpaper without sharing mutable state', () => {
    const doc = baseDoc({
      background: {
        kind: 'dots',
        color: '#101820',
        wallpaper: {
          id: 'warm-gradient',
          paused: true,
          interactive: false,
          intensity: 5,
          brightness: -1,
          quality: 'high',
        },
      },
    });

    expect(doc.background.wallpaper).toEqual({
      id: 'warm-gradient',
      paused: true,
      interactive: false,
      intensity: 1,
      brightness: 0,
      quality: 'high',
    });
    expect(Object.isFrozen(doc.background.wallpaper)).toBe(true);
  });

  it('rejects control characters and overlong titles', () => {
    expect(() => baseDoc({ title: 'bad\nline' })).toThrow(CanvasValidationError);
    expect(() => baseDoc({ title: 'x'.repeat(201) })).toThrow(CanvasValidationError);
  });
});

describe('createCanvasBlock', () => {
  it('creates a frozen block with validated content', () => {
    const b = block('blk-1', 'note body');
    expect(b.id).toBe('blk-1');
    expect(b.content).toEqual({ kind: 'text', text: 'note body' });
    expect(b.createdAt).toBe(T0);
    expect(b.updatedAt).toBe(T0);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.content)).toBe(true);
  });

  it('supports heading, note, and code content kinds', () => {
    expect(
      createCanvasBlock({ id: 'b1', content: { kind: 'heading', level: 2, text: 'H' }, now: T0 })
        .content,
    ).toEqual({ kind: 'heading', level: 2, text: 'H' });
    expect(
      createCanvasBlock({ id: 'b2', content: { kind: 'note', text: 'N' }, now: T0 }).content,
    ).toEqual({ kind: 'note', text: 'N' });
    expect(
      createCanvasBlock({ id: 'b3', content: { kind: 'code', language: 'ts', text: 'x' }, now: T0 })
        .content,
    ).toEqual({ kind: 'code', language: 'ts', text: 'x' });
  });

  it('stores a validated mind map as one canonical block payload', () => {
    const map = createMindMap({
      id: 'map-1',
      rootId: 'map-root-1',
      label: 'Launch plan',
      now: T0,
    });

    const created = createCanvasBlock({
      id: 'mind-map-block-1',
      content: { kind: 'mind-map', map },
      now: T0,
    });

    expect(created.content).toEqual({ kind: 'mind-map', map });
    expect(Object.isFrozen(created.content)).toBe(true);
  });

  it('stores a validated shape as canonical shared page and edgeless content', () => {
    const shape = createCanvasShape({
      id: 'shape-block-1',
      kind: 'rectangle',
      fill: '#f2c94c',
      borderColor: '#111111',
      borderWidth: 2,
      text: 'System boundary',
    });

    const created = createCanvasBlock({
      id: 'shape-block-1',
      content: { kind: 'shape', shape },
      now: T0,
    });

    expect(created.content).toEqual({ kind: 'shape', shape });
    expect(Object.isFrozen(created.content)).toBe(true);
    if (created.content.kind !== 'shape') throw new Error('expected shape content');
    expect(Object.isFrozen(created.content.shape)).toBe(true);
    const document = withBlockAdded(
      createCanvasDocument({
        id: 'shape-document',
        projectId: 'project-shape',
        ownerId: 'owner-shape',
        title: 'Shape document',
        now: T0,
      }),
      created,
      T1,
    );
    const restored = parseCanvasDocument(JSON.parse(JSON.stringify(document)) as unknown);
    expect(restored.blocks[0]?.content).toEqual({ kind: 'shape', shape });
    expect(() =>
      createCanvasBlock({
        id: 'different-block',
        content: { kind: 'shape', shape },
        now: T0,
      }),
    ).toThrow(CanvasValidationError);
  });

  it('rejects unsupported content kinds and invalid fields', () => {
    expect(() =>
      createCanvasBlock({ id: 'b1', content: { kind: 'video', text: '' } as never, now: T0 }),
    ).toThrow(CanvasValidationError);
    expect(() =>
      createCanvasBlock({
        id: 'b1',
        content: { kind: 'heading', level: 7, text: 'H' } as never,
        now: T0,
      }),
    ).toThrow(CanvasValidationError);
    expect(() =>
      createCanvasBlock({
        id: 'b1',
        content: { kind: 'heading', level: 0, text: 'H' } as never,
        now: T0,
      }),
    ).toThrow(CanvasValidationError);
    expect(() =>
      createCanvasBlock({ id: 'b1', content: { kind: 'text', text: 42 } as never, now: T0 }),
    ).toThrow(CanvasValidationError);
    expect(() =>
      createCanvasBlock({
        id: 'b1',
        content: { kind: 'text', text: 'x'.repeat(100_001) },
        now: T0,
      }),
    ).toThrow(CanvasValidationError);
  });
});

describe('parseCanvasDocument', () => {
  it('round-trips a serialized valid document', () => {
    const doc = docWithBlocks();
    const parsed = parseCanvasDocument(toUnknown(doc));
    expect(parsed).toEqual(doc);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts a minimal plain object with only required fields', () => {
    const parsed = parseCanvasDocument({
      id: 'doc-9',
      projectId: 'project-9',
      ownerId: 'owner-9',
      createdAt: T0,
      updatedAt: T0,
    });
    expect(parsed.title).toBe('Untitled');
    expect(parsed.layoutMode).toBe('page');
    expect(parsed.blocks).toEqual([]);
  });

  it('rejects an unsupported schema version', () => {
    const raw = { ...JSON.parse(JSON.stringify(baseDoc())), schemaVersion: 2 };
    try {
      parseCanvasDocument(raw);
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasValidationError);
      expect((error as CanvasValidationError).code).toBe('unsupported-value');
    }
  });

  it('rejects unknown top-level fields', () => {
    const raw = { ...JSON.parse(JSON.stringify(baseDoc())), hiddenContent: 'surprise' };
    try {
      parseCanvasDocument(raw);
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('unsupported-value');
    }
  });

  it('rejects duplicate block ids', () => {
    const b = JSON.parse(JSON.stringify(block('dup-1')));
    const raw = {
      ...JSON.parse(JSON.stringify(baseDoc())),
      blocks: [b, b],
      pageOrder: ['dup-1', 'dup-1'],
    };
    try {
      parseCanvasDocument(raw);
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('duplicate-id');
    }
  });

  it('rejects pageOrder that is not an exact permutation of block ids', () => {
    const raw = JSON.parse(JSON.stringify(docWithBlocks()));
    try {
      parseCanvasDocument({ ...raw, pageOrder: raw.pageOrder.slice(0, 2) });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('invalid-reference');
    }
    try {
      parseCanvasDocument({ ...raw, pageOrder: [...raw.pageOrder, 'ghost'] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('invalid-reference');
    }
    try {
      parseCanvasDocument({ ...raw, pageOrder: ['blk-a', 'blk-a', 'blk-b', 'blk-c'] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('duplicate-id');
    }
  });

  it('rejects placements with unknown or duplicate block references', () => {
    const raw = JSON.parse(JSON.stringify(docWithBlocks()));
    const placement = { blockId: 'ghost', x: 0, y: 0, width: 10, height: 10, rotation: 0, z: 0 };
    try {
      parseCanvasDocument({ ...raw, placements: [placement] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('invalid-reference');
    }
    const a = { blockId: 'blk-a', x: 0, y: 0, width: 10, height: 10, rotation: 0, z: 0 };
    try {
      parseCanvasDocument({ ...raw, placements: [a, { ...a, x: 5 }] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('duplicate-id');
    }
  });

  it('rejects presentationOrder with unknown or duplicate references', () => {
    const raw = JSON.parse(JSON.stringify(docWithBlocks()));
    try {
      parseCanvasDocument({ ...raw, presentationOrder: ['ghost'] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('invalid-reference');
    }
    try {
      parseCanvasDocument({ ...raw, presentationOrder: ['blk-a', 'blk-a'] });
      expect.unreachable('expected validation failure');
    } catch (error) {
      expect((error as CanvasValidationError).code).toBe('duplicate-id');
    }
  });

  it('rejects presenter notes for frames outside the presentation order', () => {
    const raw = JSON.parse(JSON.stringify(docWithBlocks()));
    expect(() =>
      parseCanvasDocument({
        ...raw,
        presentationOrder: ['blk-a'],
        presentationNotes: [{ frameId: 'blk-b', text: 'Not a slide' }],
      }),
    ).toThrow(CanvasValidationError);
  });

  it('rejects non-finite spatial numbers and non-positive sizes', () => {
    const raw = JSON.parse(JSON.stringify(docWithBlocks()));
    const bad = [
      { blockId: 'blk-a', x: Number.NaN, y: 0, width: 10, height: 10, rotation: 0, z: 0 },
      {
        blockId: 'blk-a',
        x: 0,
        y: Number.POSITIVE_INFINITY,
        width: 10,
        height: 10,
        rotation: 0,
        z: 0,
      },
      { blockId: 'blk-a', x: 0, y: 0, width: 0, height: 10, rotation: 0, z: 0 },
      { blockId: 'blk-a', x: 0, y: 0, width: 10, height: -4, rotation: 0, z: 0 },
      { blockId: 'blk-a', x: 0, y: 0, width: 10, height: 10, rotation: Number.NaN, z: 0 },
    ];
    for (const placement of bad) {
      expect(() => parseCanvasDocument({ ...raw, placements: [placement] })).toThrow(
        CanvasValidationError,
      );
    }
  });

  it('rejects timestamps that are negative, fractional, or out of order', () => {
    const raw = JSON.parse(JSON.stringify(baseDoc()));
    expect(() => parseCanvasDocument({ ...raw, createdAt: -5 })).toThrow(CanvasValidationError);
    expect(() => parseCanvasDocument({ ...raw, createdAt: 1.25 })).toThrow(CanvasValidationError);
    expect(() => parseCanvasDocument({ ...raw, updatedAt: T0 - 1000 })).toThrow(
      CanvasValidationError,
    );
  });

  it('rejects non-object inputs', () => {
    expect(() => parseCanvasDocument(null)).toThrow(CanvasValidationError);
    expect(() => parseCanvasDocument('doc')).toThrow(CanvasValidationError);
    expect(() => parseCanvasDocument([])).toThrow(CanvasValidationError);
  });
});

describe('isCanvasDocument', () => {
  it('accepts valid documents and rejects tampered ones', () => {
    expect(isCanvasDocument(baseDoc())).toBe(true);
    expect(isCanvasDocument(toUnknown(baseDoc()))).toBe(true);
    const tamperedZoom = JSON.parse(JSON.stringify(baseDoc()));
    tamperedZoom.camera.zoom = Number.NaN;
    expect(isCanvasDocument(tamperedZoom)).toBe(false);
    const tamperedMode = JSON.parse(JSON.stringify(baseDoc()));
    tamperedMode.layoutMode = 'isometric';
    expect(isCanvasDocument(tamperedMode)).toBe(false);
    expect(isCanvasDocument(null)).toBe(false);
  });
});

describe('shared page and edgeless content', () => {
  it('edits one shared block visible from both layout views', () => {
    const doc = docWithBlocks();
    const edited = withBlockContent(doc, 'blk-b', { kind: 'text', text: 'beta v2' }, T1);

    const pageBlock = pageOrderedBlocks(edited).find((b) => b.id === 'blk-b');
    expect(pageBlock?.content).toEqual({ kind: 'text', text: 'beta v2' });

    const layout = resolveEdgelessLayout(edited);
    expect(layout.has(parseCanvasBlockId('blk-b'))).toBe(true);

    const shared = edited.blocks.find((b) => b.id === 'blk-b');
    expect(shared?.content).toEqual({ kind: 'text', text: 'beta v2' });
    expect(pageBlock).toBe(shared);
    expect(shared?.updatedAt).toBe(T1);
    expect(edited.localRevision).toBe(doc.localRevision + 1);
    expect(edited.updatedAt).toBe(T1);
    // The original document is untouched.
    expect(doc.blocks.find((b) => b.id === 'blk-b')?.content).toEqual({
      kind: 'text',
      text: 'beta',
    });
  });

  it('keeps spatial metadata separate from content with no hidden copies', () => {
    let doc = docWithBlocks();
    doc = withPlacement(doc, { blockId: 'blk-a', x: 10, y: 20, width: 100, height: 50 }, T1);
    const serialized = JSON.stringify(doc);
    expect(serialized.match(/alpha/g)?.length).toBe(1);
    for (const placement of doc.placements) {
      expect(Object.keys(placement).sort()).toEqual(
        ['blockId', 'height', 'hidden', 'locked', 'rotation', 'width', 'x', 'y', 'z'].sort(),
      );
    }
    expect(placementsByBlockId(doc).get(parseCanvasBlockId('blk-a'))).toEqual({
      blockId: 'blk-a',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      rotation: 0,
      z: 0,
      locked: false,
      hidden: false,
    });
  });

  it('persists validated lock and visibility state on spatial objects', () => {
    let doc = docWithBlocks();
    doc = withPlacement(
      doc,
      {
        blockId: 'blk-a',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        locked: true,
        hidden: true,
      },
      T1,
    );

    expect(doc.placements[0]).toMatchObject({ locked: true, hidden: true });
    const raw = JSON.parse(JSON.stringify(doc));
    raw.placements[0].locked = 'yes';
    expect(() => parseCanvasDocument(raw)).toThrow(CanvasValidationError);
  });

  it('changes layout mode without duplicating or dropping content', () => {
    const doc = docWithBlocks();
    const edgeless = withLayoutMode(doc, 'edgeless', T1);
    expect(edgeless.layoutMode).toBe('edgeless');
    expect(edgeless.blocks).toBe(
      doc.blocks.length === edgeless.blocks.length ? edgeless.blocks : [],
    );
    expect(pageOrderedBlocks(edgeless).map((b) => b.id)).toEqual(['blk-a', 'blk-b', 'blk-c']);
    const backToPage = withLayoutMode(edgeless, 'page', T1 + 1);
    expect(backToPage.layoutMode).toBe('page');
    expect(backToPage.blocks.map((b) => b.content)).toEqual(doc.blocks.map((b) => b.content));
  });
});

describe('deterministic page ordering', () => {
  it('returns blocks in stored page order', () => {
    const doc = docWithBlocks();
    expect(pageOrderedBlocks(doc).map((b) => b.id)).toEqual(['blk-a', 'blk-b', 'blk-c']);
  });

  it('reorders through withPageOrder and rejects invalid permutations', () => {
    const doc = docWithBlocks();
    const reordered = withPageOrder(doc, ['blk-c', 'blk-a', 'blk-b'], T1);
    expect(pageOrderedBlocks(reordered).map((b) => b.id)).toEqual(['blk-c', 'blk-a', 'blk-b']);
    expect(() => withPageOrder(doc, ['blk-a', 'blk-b'], T1)).toThrow(CanvasValidationError);
    expect(() => withPageOrder(doc, ['blk-a', 'blk-a', 'blk-b', 'blk-c'], T1)).toThrow(
      CanvasValidationError,
    );
    expect(() => withPageOrder(doc, ['blk-a', 'blk-b', 'ghost'], T1)).toThrow(
      CanvasValidationError,
    );
  });
});

describe('automatic edgeless layout', () => {
  it('places unpositioned blocks on a deterministic grid following page order', () => {
    const doc = docWithBlocks();
    const first = computeAutomaticPlacements(doc);
    const second = computeAutomaticPlacements(doc);
    expect(first).toEqual(second);
    expect(first.map((p) => p.blockId)).toEqual(['blk-a', 'blk-b', 'blk-c']);
    const { blockWidth, blockHeight, columns, gapX, gapY } = CANVAS_AUTO_LAYOUT;
    first.forEach((placement, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      expect(placement.x).toBe(col * (blockWidth + gapX));
      expect(placement.y).toBe(row * (blockHeight + gapY));
      expect(placement.width).toBe(blockWidth);
      expect(placement.height).toBe(blockHeight);
      expect(placement.rotation).toBe(0);
    });
  });

  it('preserves stored placements and only fills missing ones', () => {
    let doc = docWithBlocks();
    doc = withPlacement(doc, { blockId: 'blk-b', x: 999, y: -42, width: 200, height: 120 }, T1);
    const automatic = computeAutomaticPlacements(doc);
    expect(automatic.map((p) => p.blockId)).toEqual(['blk-a', 'blk-c']);
    const resolved = resolveEdgelessLayout(doc);
    expect(resolved.get(parseCanvasBlockId('blk-b'))).toEqual({
      blockId: 'blk-b',
      x: 999,
      y: -42,
      width: 200,
      height: 120,
      rotation: 0,
      z: 0,
      locked: false,
      hidden: false,
    });
    expect(resolved.size).toBe(3);
  });

  it('returns an empty automatic list when every block is placed', () => {
    let doc = docWithBlocks();
    doc = withPlacement(doc, { blockId: 'blk-a', x: 0, y: 0, width: 10, height: 10 }, T1);
    doc = withPlacement(doc, { blockId: 'blk-b', x: 20, y: 0, width: 10, height: 10 }, T1);
    doc = withPlacement(doc, { blockId: 'blk-c', x: 40, y: 0, width: 10, height: 10 }, T1);
    expect(computeAutomaticPlacements(doc)).toEqual([]);
    expect(resolveEdgelessLayout(doc).size).toBe(3);
  });
});

describe('document mutations', () => {
  it('adds blocks at an explicit index and appends by default', () => {
    const doc = docWithBlocks();
    const appended = withBlockAdded(doc, block('blk-d'), T1);
    expect(appended.pageOrder).toEqual(['blk-a', 'blk-b', 'blk-c', 'blk-d']);
    const inserted = withBlockAdded(doc, block('blk-d'), T1, 1);
    expect(inserted.pageOrder).toEqual(['blk-a', 'blk-d', 'blk-b', 'blk-c']);
    expect(() => withBlockAdded(doc, block('blk-a'), T1)).toThrow(CanvasValidationError);
    expect(() => withBlockAdded(doc, block('blk-d'), T1, 99)).toThrow(CanvasValidationError);
  });

  it('removes a block together with its placement and presentation entries', () => {
    let doc = docWithBlocks();
    doc = withPlacement(doc, { blockId: 'blk-b', x: 5, y: 5, width: 20, height: 20 }, T1);
    doc = withPresentationOrder(doc, ['blk-b', 'blk-c'], T1);
    doc = withPresentationNote(doc, 'blk-b', 'Introduce the decision', T1 + 1);
    const removed = withBlockRemoved(doc, 'blk-b', T1 + 1);
    expect(removed.blocks.map((b) => b.id)).toEqual(['blk-a', 'blk-c']);
    expect(removed.pageOrder).toEqual(['blk-a', 'blk-c']);
    expect(removed.placements).toEqual([]);
    expect(removed.presentationOrder).toEqual(['blk-c']);
    expect(removed.presentationNotes).toEqual([]);
    expect(() => withBlockRemoved(doc, 'ghost', T1)).toThrow(CanvasValidationError);
  });

  it('persists bounded presenter notes and preserves them across frame reordering', () => {
    let doc = withPresentationOrder(docWithBlocks(), ['blk-a', 'blk-b'], T1);
    doc = withPresentationNote(doc, 'blk-b', 'Call out the tradeoff', T1 + 1);
    expect(doc.presentationNotes).toEqual([{ frameId: 'blk-b', text: 'Call out the tradeoff' }]);

    doc = withPresentationOrder(doc, ['blk-b', 'blk-a'], T1 + 2);
    expect(doc.presentationNotes).toEqual([{ frameId: 'blk-b', text: 'Call out the tradeoff' }]);
    expect(() => withPresentationNote(doc, 'blk-c', 'Not included', T1 + 3)).toThrow(
      CanvasValidationError,
    );
    expect(withPresentationNote(doc, 'blk-b', '', T1 + 3).presentationNotes).toEqual([]);
  });

  it('upserts placements and removes them idempotently', () => {
    let doc = docWithBlocks();
    doc = withPlacement(doc, { blockId: 'blk-a', x: 1, y: 2, width: 30, height: 40 }, T1);
    const moved = withPlacement(
      doc,
      { blockId: 'blk-a', x: 9, y: 8, width: 30, height: 40 },
      T1 + 1,
    );
    expect(moved.placements).toHaveLength(1);
    expect(moved.placements[0]?.x).toBe(9);
    const cleared = withoutPlacement(moved, 'blk-a', T1 + 2);
    expect(cleared.placements).toEqual([]);
    const clearedAgain = withoutPlacement(cleared, 'blk-a', T1 + 3);
    expect(clearedAgain).toBe(cleared);
    expect(() =>
      withPlacement(doc, { blockId: 'ghost', x: 0, y: 0, width: 5, height: 5 }, T1),
    ).toThrow(CanvasValidationError);
  });

  it('bumps localRevision for content changes but not for camera moves', () => {
    const doc = docWithBlocks();
    const titled = withTitle(doc, 'Renamed', T1);
    expect(titled.localRevision).toBe(doc.localRevision + 1);
    expect(titled.updatedAt).toBe(T1);
    const panned = withCamera(titled, { x: 100, y: 50, zoom: 2 });
    expect(panned.camera).toEqual({ x: 100, y: 50, zoom: 2 });
    expect(panned.localRevision).toBe(titled.localRevision);
    expect(panned.updatedAt).toBe(titled.updatedAt);
    expect(() => withCamera(titled, { x: 0, y: 0, zoom: CANVAS_MAX_ZOOM * 4 })).toThrow(
      CanvasValidationError,
    );
  });

  it('updates background, archive, and deletion state', () => {
    const doc = baseDoc();
    const bg = withBackground(doc, { kind: 'grid', color: '#112233' }, T1);
    expect(bg.background).toEqual({
      kind: 'grid',
      color: '#112233',
      wallpaper: doc.background.wallpaper,
    });
    const archived = withArchived(doc, true, T1);
    expect(archived.archivedAt).toBe(T1);
    expect(withArchived(archived, false, T1 + 1).archivedAt).toBeNull();
    const deleted = withDeleted(doc, true, T1);
    expect(deleted.deletedAt).toBe(T1);
    expect(withDeleted(doc, true, T1)).not.toBe(doc);
    expect(withArchived(doc, false, T1)).toBe(doc);
  });

  it('preserves the Canvas ambience when only the grid background changes', () => {
    const doc = baseDoc({
      background: {
        kind: 'plain',
        color: '#ffffff',
        wallpaper: {
          id: 'aurora',
          paused: true,
          interactive: false,
          intensity: 0.45,
          brightness: 0.6,
          quality: 'high',
        },
      },
    });

    const updated = withBackground(doc, { kind: 'dots', color: '#101820' }, T1);

    expect(updated.background.wallpaper).toEqual(doc.background.wallpaper);
  });

  it('keeps prior documents immutable', () => {
    const doc = docWithBlocks();
    withBlockContent(doc, 'blk-a', { kind: 'text', text: 'changed' }, T1);
    expect(doc.blocks.find((b) => b.id === 'blk-a')?.content).toEqual({
      kind: 'text',
      text: 'alpha',
    });
    expect(() => {
      (doc as { title?: string }).title = 'hacked';
    }).toThrow(TypeError);
  });
});

describe('layout mode guard', () => {
  it('recognizes exactly page and edgeless', () => {
    expect(isCanvasLayoutMode('page')).toBe(true);
    expect(isCanvasLayoutMode('edgeless')).toBe(true);
    expect(isCanvasLayoutMode('Page')).toBe(false);
    expect(isCanvasLayoutMode(undefined)).toBe(false);
  });
});

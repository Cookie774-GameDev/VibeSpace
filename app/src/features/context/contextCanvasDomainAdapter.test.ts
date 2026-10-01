import { describe, expect, it } from 'vitest';
import {
  CANVAS_AUTO_LAYOUT,
  blockById,
  createCanvasBlock,
  createCanvasDocument,
  isCanvasDocument,
  pageOrderedBlocks,
  parseCanvasBlockId,
  resolveEdgelessLayout,
  withBlockAdded,
  withPlacement,
  type CanvasDocument,
} from '../canvas/contracts';
import {
  createCanvasObjectContextReference,
  type VibeSpaceCanvasDocument,
} from './contextCanvasIntegration';
import {
  adaptBridgeDocumentToDomain,
  projectDomainDocumentToBridge,
} from './contextCanvasDomainAdapter';
import { createCanvasShape } from '../canvas/shapes';

const NOW = 1_000;

function buildDomainDoc(): CanvasDocument {
  let doc = createCanvasDocument({
    id: 'doc1',
    projectId: 'project1',
    ownerId: 'owner1',
    now: NOW,
    title: 'Domain board',
  });
  doc = withBlockAdded(
    doc,
    createCanvasBlock({
      id: 'block1',
      content: { kind: 'text', text: 'First canonical block.' },
      now: NOW,
    }),
    NOW,
  );
  doc = withBlockAdded(
    doc,
    createCanvasBlock({
      id: 'block2',
      content: { kind: 'text', text: 'Second canonical block.' },
      now: NOW,
    }),
    NOW,
  );
  return doc;
}

function buildBridgeDoc(): VibeSpaceCanvasDocument {
  return {
    schemaVersion: 1,
    id: 'bridgedoc1',
    projectId: 'project1',
    title: 'Bridge board',
    updatedAt: 2_000,
    objects: [
      {
        id: 'obj-text',
        type: 'text',
        label: 'Note',
        text: 'A bridge text object.',
        x: 10,
        y: 20,
        width: 320,
        height: 180,
        selected: false,
        contextReferences: [],
      },
      {
        id: 'obj-link',
        type: 'link',
        label: 'https://example.test/docs',
        url: 'https://example.test/docs',
        x: 350,
        y: 20,
        width: 320,
        height: 180,
        selected: false,
        contextReferences: [],
      },
      {
        id: 'obj-file',
        type: 'file',
        label: 'runbook.md',
        file: 'docs/runbook.md',
        x: 10,
        y: 220,
        width: 320,
        height: 180,
        selected: false,
        contextReferences: [],
      },
      {
        id: 'obj-group',
        type: 'group',
        label: 'Cluster',
        groupLabel: 'Cluster',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        selected: false,
        contextReferences: [],
      },
    ],
    connections: [{ id: 'conn1', fromObjectId: 'obj-text', toObjectId: 'obj-link', label: 'uses' }],
  };
}

describe('Canvas domain <-> Context/Open JSON Canvas bridge adapter', () => {
  describe('domain-to-bridge projection', () => {
    it('projects canonical text blocks into a transient, frozen bridge document in page order', () => {
      const doc = buildDomainDoc();
      const bridge = projectDomainDocumentToBridge(doc, { now: 5_000 });
      expect(bridge.schemaVersion).toBe(1);
      expect(bridge.id).toBe('doc1');
      expect(bridge.projectId).toBe('project1');
      expect(bridge.title).toBe('Domain board');
      expect(bridge.updatedAt).toBe(5_000);
      expect(bridge.connections).toEqual([]);
      expect(bridge.compatibilitySource).toBeUndefined();
      expect(bridge.objects.map((object) => object.id)).toEqual(['block1', 'block2']);
      expect(bridge.objects[0]).toMatchObject({
        id: 'block1',
        type: 'text',
        label: 'First canonical block.',
        text: 'First canonical block.',
        selected: false,
      });
      expect(bridge.objects[0].contextReferences).toEqual([]);
      expect(Object.isFrozen(bridge)).toBe(true);
      expect(Object.isFrozen(bridge.objects)).toBe(true);
      expect(Object.isFrozen(bridge.objects[0])).toBe(true);
    });

    it.each([
      {
        content: {
          kind: 'stroke' as const,
          tool: 'pencil' as const,
          color: '#112233',
          width: 2,
          points: [
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ],
        },
        text: 'pencil stroke',
      },
      {
        content: {
          kind: 'image' as const,
          name: 'diagram.png',
          mimeType: 'image/png' as const,
          dataUrl: 'data:image/png;base64,aGVsbG8=',
          width: 80,
          height: 60,
          altText: 'Architecture diagram',
        },
        text: 'Image: Architecture diagram',
      },
      {
        content: {
          kind: 'image' as const,
          name: 'diagram.png',
          mimeType: 'image/png' as const,
          dataUrl: 'data:image/png;base64,aGVsbG8=',
          width: 80,
          height: 60,
          altText: '',
        },
        text: 'Image: diagram.png',
      },
    ])(
      'projects $content.kind content without changing its canonical payload',
      ({ content, text }) => {
        const doc = withBlockAdded(
          createCanvasDocument({
            id: 'media-doc',
            projectId: 'project1',
            ownerId: 'owner1',
            now: NOW,
          }),
          createCanvasBlock({ id: 'media-block', content, now: NOW }),
          NOW,
        );
        const bridge = projectDomainDocumentToBridge(doc);
        expect(bridge.objects[0]).toMatchObject({
          id: 'media-block',
          type: 'text',
          label: text,
          text,
        });
        expect(blockById(doc, 'media-block')?.content).toEqual(content);
        expect(Object.isFrozen(bridge.objects[0])).toBe(true);
      },
    );

    it('projects structured blocks as lossy text objects without altering canonical content', () => {
      let doc = createCanvasDocument({
        id: 'doc2',
        projectId: 'project1',
        ownerId: 'owner1',
        now: NOW,
      });
      doc = withBlockAdded(
        doc,
        createCanvasBlock({
          id: 'h1',
          content: { kind: 'heading', level: 2, text: 'Section title' },
          now: NOW,
        }),
        NOW,
      );
      doc = withBlockAdded(
        doc,
        createCanvasBlock({
          id: 'c1',
          content: { kind: 'code', language: 'ts', text: 'const x = 1;' },
          now: NOW,
        }),
        NOW,
      );
      doc = withBlockAdded(
        doc,
        createCanvasBlock({
          id: 'shape1',
          content: {
            kind: 'shape',
            shape: createCanvasShape({
              id: 'shape1',
              kind: 'diamond',
              fill: '#2f80ed',
              text: 'Architecture decision',
            }),
          },
          now: NOW,
        }),
        NOW,
      );
      const bridge = projectDomainDocumentToBridge(doc);
      expect(bridge.objects[0]).toMatchObject({ id: 'h1', type: 'text', text: 'Section title' });
      expect(bridge.objects[1]).toMatchObject({ id: 'c1', type: 'text', text: 'const x = 1;' });
      expect(bridge.objects[2]).toMatchObject({
        id: 'shape1',
        type: 'text',
        text: 'Architecture decision',
      });
      expect(blockById(doc, 'h1')?.content).toEqual({
        kind: 'heading',
        level: 2,
        text: 'Section title',
      });
    });
  });

  describe('bridge-to-domain adaptation', () => {
    it('adapts every bridge object type into a validated, frozen domain document', () => {
      const bridge = buildBridgeDoc();
      const doc = adaptBridgeDocumentToDomain(bridge, { ownerId: 'owner1', now: 7_000 });
      expect(isCanvasDocument(doc)).toBe(true);
      expect(Object.isFrozen(doc)).toBe(true);
      expect(doc.id).toBe('bridgedoc1');
      expect(doc.projectId).toBe('project1');
      expect(doc.ownerId).toBe('owner1');
      expect(doc.title).toBe('Bridge board');
      expect(doc.layoutMode).toBe('edgeless');
      expect(doc.pageOrder).toEqual(['obj-text', 'obj-link', 'obj-file', 'obj-group']);
      expect(blockById(doc, 'obj-text')?.content).toEqual({
        kind: 'text',
        text: 'A bridge text object.',
      });
      expect(blockById(doc, 'obj-link')?.content).toEqual({
        kind: 'text',
        text: 'https://example.test/docs',
      });
      expect(blockById(doc, 'obj-file')?.content).toEqual({
        kind: 'text',
        text: 'docs/runbook.md',
      });
      expect(blockById(doc, 'obj-group')?.content).toEqual({ kind: 'text', text: 'Cluster' });
    });
  });

  describe('stable object IDs and context references', () => {
    it('keeps block ids as object ids so canvas context references stay stable', () => {
      const doc = buildDomainDoc();
      const bridge = projectDomainDocumentToBridge(doc);
      const reference = createCanvasObjectContextReference(bridge, bridge.objects[0]);
      expect(reference.entityId).toBe('canvas:doc1:block1');
      expect(reference.sourceId).toBe('canvas:doc1');
      expect(reference.kind).toBe('canvas_object');
    });
  });

  describe('single canonical content ownership', () => {
    it('round-trips content and ids through the transient projection without duplicating persistence', () => {
      const doc = buildDomainDoc();
      const bridge = projectDomainDocumentToBridge(doc);
      expect(bridge.objects[0].text).toBe('First canonical block.');
      expect(bridge.compatibilitySource).toBeUndefined();
      const adapted = adaptBridgeDocumentToDomain(bridge, {
        ownerId: 'owner1',
        projectId: 'project1',
        now: 9_000,
      });
      expect(adapted.blocks.map((block) => block.id)).toEqual(['block1', 'block2']);
      expect(blockById(adapted, 'block1')?.content).toEqual({
        kind: 'text',
        text: 'First canonical block.',
      });
      expect(blockById(adapted, 'block2')?.content).toEqual({
        kind: 'text',
        text: 'Second canonical block.',
      });
      expect(isCanvasDocument(adapted)).toBe(true);
    });
  });

  describe('page/edgeless compatibility', () => {
    it('uses stored placements when present and deterministic automatic layout otherwise', () => {
      let doc = buildDomainDoc();
      doc = withPlacement(doc, { blockId: 'block1', x: 500, y: 600, width: 300, height: 200 }, NOW);
      const bridge = projectDomainDocumentToBridge(doc);
      const block1 = bridge.objects.find((object) => object.id === 'block1');
      const block2 = bridge.objects.find((object) => object.id === 'block2');
      expect(block1).toMatchObject({ x: 500, y: 600, width: 300, height: 200 });
      expect(block2).toMatchObject({
        x: 0,
        y: 0,
        width: CANVAS_AUTO_LAYOUT.blockWidth,
        height: CANVAS_AUTO_LAYOUT.blockHeight,
      });
    });

    it('preserves bridge geometry as edgeless placements and object order as page order', () => {
      const bridge = buildBridgeDoc();
      const doc = adaptBridgeDocumentToDomain(bridge, { ownerId: 'owner1' });
      const layout = resolveEdgelessLayout(doc);
      expect(layout.get(parseCanvasBlockId('obj-text'))).toMatchObject({
        x: 10,
        y: 20,
        width: 320,
        height: 180,
      });
      expect(pageOrderedBlocks(doc).map((block) => block.id)).toEqual([
        'obj-text',
        'obj-link',
        'obj-file',
        'obj-group',
      ]);
    });
  });

  describe('unknown schema rejection', () => {
    it('rejects domain documents with an unsupported schema version', () => {
      const doc = buildDomainDoc();
      const wrong = { ...doc, schemaVersion: 2 } as unknown as CanvasDocument;
      expect(() => projectDomainDocumentToBridge(wrong)).toThrow(/schema version/i);
    });

    it('rejects bridge documents with an unsupported schema version', () => {
      const bridge = {
        ...buildBridgeDoc(),
        schemaVersion: 9,
      } as unknown as VibeSpaceCanvasDocument;
      expect(() => adaptBridgeDocumentToDomain(bridge, { ownerId: 'owner1' })).toThrow(
        /schema version/i,
      );
    });
  });

  describe('unsafe and dangling input parity', () => {
    it('rejects executable link URLs exactly like the bridge', () => {
      const hostile = {
        schemaVersion: 1,
        id: 'hostile1',
        projectId: 'project1',
        title: 'Unsafe',
        updatedAt: 1,
        objects: [
          {
            id: 'link1',
            type: 'link',
            label: 'x',
            url: 'javascript:alert(1)',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            selected: false,
            contextReferences: [],
          },
        ],
        connections: [],
      } as unknown as VibeSpaceCanvasDocument;
      expect(() => adaptBridgeDocumentToDomain(hostile, { ownerId: 'owner1' })).toThrow(
        /unsafe link/i,
      );
    });

    it('rejects dangling connections exactly like the bridge', () => {
      const hostile = {
        schemaVersion: 1,
        id: 'hostile2',
        projectId: 'project1',
        title: 'Broken',
        updatedAt: 1,
        objects: [
          {
            id: 'a',
            type: 'text',
            label: 'A',
            text: 'A',
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            selected: false,
            contextReferences: [],
          },
        ],
        connections: [{ id: 'c', fromObjectId: 'a', toObjectId: 'missing' }],
      } as unknown as VibeSpaceCanvasDocument;
      expect(() => adaptBridgeDocumentToDomain(hostile, { ownerId: 'owner1' })).toThrow(
        /dangling edge/i,
      );
    });
  });
});

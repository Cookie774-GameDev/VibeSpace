import { describe, expect, it } from 'vitest';
import { createJarvisDb } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { createCanvasPersistenceRepository } from './persistence';
import {
  CanvasValidationError,
  createCanvasBlock,
  createCanvasDocument,
  parseCanvasDocument,
  withBlockAdded,
} from './contracts';

const base = createCanvasDocument({
  id: 'drawing-contract',
  projectId: 'project-a',
  ownerId: 'account-a',
  now: 1,
});

describe('Canvas persisted drawing and image content', () => {
  it('round-trips bounded pencil/marker points and a validated raster data URL', () => {
    const stroke = createCanvasBlock({
      id: 'stroke-one',
      now: 2,
      content: {
        kind: 'stroke',
        tool: 'pencil',
        color: '#123456',
        width: 3,
        points: [
          { x: 0, y: 0 },
          { x: 12, y: 9 },
        ],
      },
    });
    const image = createCanvasBlock({
      id: 'image-one',
      now: 3,
      content: {
        kind: 'image',
        name: 'qa.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        width: 1,
        height: 1,
        altText: 'QA pixel',
      },
    });
    const document = withBlockAdded(withBlockAdded(base, stroke, 2), image, 3);
    const reopened = parseCanvasDocument(JSON.parse(JSON.stringify(document)));
    expect(reopened.blocks.map((block) => block.content.kind)).toEqual(['stroke', 'image']);
    expect(reopened.blocks[0].content).toMatchObject({
      tool: 'pencil',
      points: [
        { x: 0, y: 0 },
        { x: 12, y: 9 },
      ],
    });
    expect(reopened.blocks[1].content).toMatchObject({ name: 'qa.png', width: 1, height: 1 });
  });

  it('rejects oversized or unsafe image payloads and invalid stroke samples', () => {
    const image = {
      kind: 'image',
      name: 'bad.svg',
      mimeType: 'image/svg+xml',
      dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
      width: 1,
      height: 1,
      altText: '',
    };
    expect(() => createCanvasBlock({ id: 'bad-image', now: 2, content: image as never })).toThrow(
      CanvasValidationError,
    );
    expect(() =>
      createCanvasBlock({
        id: 'bad-stroke',
        now: 2,
        content: {
          kind: 'stroke',
          tool: 'marker',
          color: '#123456',
          width: 8,
          points: [{ x: Number.NaN, y: 0 }],
        } as never,
      }),
    ).toThrow(CanvasValidationError);
  });

  it('saves and reopens both content kinds through the account-scoped Dexie repository', async () => {
    const db = createJarvisDb(uniqueTestDbName('canvas-drawing-image'), TEST_INDEXED_DB);
    await db.open();
    try {
      const scope = { accountId: 'account-a', projectId: 'project-a', ownerId: 'account-a' };
      const document = withBlockAdded(
        withBlockAdded(
          base,
          createCanvasBlock({
            id: 'persisted-stroke',
            now: 2,
            content: {
              kind: 'stroke',
              tool: 'marker',
              color: '#d97757',
              width: 10,
              points: [
                { x: 1, y: 1 },
                { x: 10, y: 12 },
              ],
            },
          }),
          2,
        ),
        createCanvasBlock({
          id: 'persisted-image',
          now: 3,
          content: {
            kind: 'image',
            name: 'qa.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            width: 1,
            height: 1,
            altText: 'QA pixel',
          },
        }),
        3,
      );
      const repository = createCanvasPersistenceRepository(db);
      await repository.save(scope, document);
      const reopened = await repository.load(scope, document.id);
      expect(reopened?.blocks.map((block) => block.content)).toEqual(
        document.blocks.map((block) => block.content),
      );
    } finally {
      await db.delete();
    }
  });
});

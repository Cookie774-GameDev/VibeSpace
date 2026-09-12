import { describe, expect, it } from 'vitest';
import {
  CANVAS_PACKAGE_KIND,
  CANVAS_PACKAGE_MAX_TEXT_LENGTH,
  CANVAS_PACKAGE_SCHEMA_VERSION,
  CANVAS_PACKAGE_VERSION,
  CanvasPackageError,
  decodeCanvasPackage,
  encodeCanvasPackage,
  parseCanvasPackage,
  type CanvasPackageErrorCode,
} from './packageFormat';
import {
  CANVAS_SCHEMA_VERSION,
  createCanvasBlock,
  createCanvasDocument,
  withBlockAdded,
  withPlacement,
  withPresentationOrder,
  type CanvasDocument,
} from './contracts';

const T0 = 1_750_000_000_000;

/** A rich, fully-populated document exercising blocks, edgeless placements, presentation order, and view settings. */
function richDoc(): CanvasDocument {
  let doc = createCanvasDocument({
    id: 'doc-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    now: T0,
    title: 'Ideas',
    icon: 'id\u00e9a',
    thumbnail: 'data:image/png;base64,AAAA',
    layoutMode: 'edgeless',
    camera: { x: 12, y: -34, zoom: 1.5 },
    background: { kind: 'grid', color: '#012345' },
  });
  doc = withBlockAdded(
    doc,
    createCanvasBlock({
      id: 'block-1',
      content: { kind: 'heading', level: 2, text: 'Hello' },
      now: T0,
    }),
    T0,
  );
  doc = withBlockAdded(
    doc,
    createCanvasBlock({
      id: 'block-2',
      content: { kind: 'code', language: 'typescript', text: 'const x = 1;' },
      now: T0,
    }),
    T0,
  );
  doc = withPlacement(
    doc,
    { blockId: 'block-1', x: 10, y: 20, width: 280, height: 180, rotation: 0, z: 1 },
    T0,
  );
  doc = withPresentationOrder(doc, ['block-1', 'block-2'], T0);
  return doc;
}

/** Asserts a thunk throws a CanvasPackageError with the given code (and optional path), returning it. */
function expectPackageError(
  fn: () => unknown,
  code: CanvasPackageErrorCode,
  path?: string,
): CanvasPackageError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasPackageError);
    const e = error as CanvasPackageError;
    expect(e.name).toBe('CanvasPackageError');
    expect(e.code).toBe(code);
    if (path !== undefined) {
      expect(e.path).toBe(path);
    }
    expect(e.message).toContain(`(${code})`);
    return e;
  }
  throw new Error(`expected CanvasPackageError(${code}) but nothing was thrown`);
}

describe('canvas package codec', () => {
  describe('round-trip and preservation', () => {
    it('decodes an encoded package back to a deeply-equal canonical document', () => {
      const doc = richDoc();
      const decoded = decodeCanvasPackage(encodeCanvasPackage(doc));
      expect(decoded.document).toEqual(doc);
    });

    it('preserves blocks, placements, page order, and presentation order', () => {
      const doc = richDoc();
      const decoded = decodeCanvasPackage(encodeCanvasPackage(doc));
      expect(decoded.document.blocks).toEqual(doc.blocks);
      expect(decoded.document.placements).toEqual(doc.placements);
      expect(decoded.document.pageOrder).toEqual(doc.pageOrder);
      expect(decoded.document.presentationOrder).toEqual(doc.presentationOrder);
    });

    it('preserves view settings (title, icon, thumbnail, layout, camera, background)', () => {
      const doc = richDoc();
      const decoded = decodeCanvasPackage(encodeCanvasPackage(doc));
      expect(decoded.document.title).toBe('Ideas');
      expect(decoded.document.icon).toBe('id\u00e9a');
      expect(decoded.document.thumbnail).toBe('data:image/png;base64,AAAA');
      expect(decoded.document.layoutMode).toBe('edgeless');
      expect(decoded.document.camera).toEqual({ x: 12, y: -34, zoom: 1.5 });
      expect(decoded.document.background).toEqual(doc.background);
    });

    it('returns a deeply frozen package and document', () => {
      const decoded = decodeCanvasPackage(encodeCanvasPackage(richDoc()));
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.document)).toBe(true);
      expect(Object.isFrozen(decoded.document.blocks)).toBe(true);
    });
  });

  describe('deterministic serialization', () => {
    it('produces identical bytes for repeated encoding of the same document', () => {
      const doc = richDoc();
      expect(encodeCanvasPackage(doc)).toBe(encodeCanvasPackage(doc));
    });

    it('is independent of the document key insertion order', () => {
      const doc = richDoc();
      const reversed = Object.fromEntries(
        Object.entries(doc).reverse(),
      ) as unknown as CanvasDocument;
      expect(encodeCanvasPackage(reversed)).toBe(encodeCanvasPackage(doc));
    });

    it('is idempotent across encode/decode/encode', () => {
      const doc = richDoc();
      const once = encodeCanvasPackage(doc);
      const twice = encodeCanvasPackage(decodeCanvasPackage(once).document);
      expect(twice).toBe(once);
    });
  });

  describe('envelope verification', () => {
    it('verifies package kind, package version, and schema version on decode', () => {
      const decoded = decodeCanvasPackage(encodeCanvasPackage(richDoc()));
      expect(decoded.kind).toBe(CANVAS_PACKAGE_KIND);
      expect(decoded.packageVersion).toBe(CANVAS_PACKAGE_VERSION);
      expect(decoded.schemaVersion).toBe(CANVAS_PACKAGE_SCHEMA_VERSION);
    });

    it('ties the package schema version to the canvas document schema version', () => {
      expect(CANVAS_PACKAGE_SCHEMA_VERSION).toBe(CANVAS_SCHEMA_VERSION);
    });

    it('embeds the canonical document exactly once with no duplicated content fields', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      expect(Object.keys(envelope).sort()).toEqual([
        'document',
        'kind',
        'packageVersion',
        'schemaVersion',
      ]);
      expect(envelope).not.toHaveProperty('blocks');
      expect(envelope).not.toHaveProperty('placements');
      expect(envelope).not.toHaveProperty('pageOrder');
      expect(envelope).not.toHaveProperty('presentationOrder');
    });
  });

  describe('rejection of malformed and hostile payloads', () => {
    it('rejects non-string decode input', () => {
      expectPackageError(
        () => decodeCanvasPackage(42 as unknown as string),
        'invalid-type',
        'package',
      );
      expectPackageError(
        () => decodeCanvasPackage(null as unknown as string),
        'invalid-type',
        'package',
      );
    });

    it('rejects malformed JSON with a SyntaxError cause', () => {
      const e = expectPackageError(
        () => decodeCanvasPackage('{ this is not json'),
        'malformed-json',
        'package',
      );
      expect(e.cause).toBeInstanceOf(SyntaxError);
    });

    it('rejects trailing garbage after an otherwise valid package', () => {
      const text = `${encodeCanvasPackage(richDoc())}x`;
      expectPackageError(() => decodeCanvasPackage(text), 'malformed-json', 'package');
    });

    it('rejects payloads exceeding the configured text limit', () => {
      const text = encodeCanvasPackage(richDoc());
      const e = expectPackageError(
        () => decodeCanvasPackage(text, { maxTextLength: 8 }),
        'oversized-payload',
        'package',
      );
      expect(e.message).toContain('8');
    });

    it('accepts payloads within the configured text limit', () => {
      const text = encodeCanvasPackage(richDoc());
      expect(decodeCanvasPackage(text, { maxTextLength: text.length }).document).toEqual(richDoc());
    });

    it('exposes a sane positive default text limit', () => {
      expect(Number.isSafeInteger(CANVAS_PACKAGE_MAX_TEXT_LENGTH)).toBe(true);
      expect(CANVAS_PACKAGE_MAX_TEXT_LENGTH).toBeGreaterThan(0);
    });

    it('rejects an invalid maxTextLength option', () => {
      expectPackageError(
        () => decodeCanvasPackage('{}', { maxTextLength: -1 }),
        'invalid-type',
        'options.maxTextLength',
      );
    });

    it('rejects non-object package values', () => {
      expectPackageError(() => parseCanvasPackage(null), 'invalid-type', 'package');
      expectPackageError(() => parseCanvasPackage([]), 'invalid-type', 'package');
      expectPackageError(() => parseCanvasPackage('str'), 'invalid-type', 'package');
      expectPackageError(() => parseCanvasPackage(undefined), 'invalid-type', 'package');
    });

    it('rejects unknown envelope fields', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.extra = true;
      expectPackageError(() => parseCanvasPackage(envelope), 'unknown-field', 'package.extra');
    });

    it('rejects an unknown package kind', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.kind = 'something.else';
      expectPackageError(() => parseCanvasPackage(envelope), 'unknown-kind', 'package.kind');
    });

    it('rejects a forward package version', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.packageVersion = CANVAS_PACKAGE_VERSION + 1;
      expectPackageError(
        () => parseCanvasPackage(envelope),
        'unsupported-version',
        'package.packageVersion',
      );
    });

    it('rejects any other unsupported package version', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.packageVersion = 0;
      expectPackageError(
        () => parseCanvasPackage(envelope),
        'unsupported-version',
        'package.packageVersion',
      );
    });

    it('rejects a non-integer package version', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.packageVersion = '1';
      expectPackageError(
        () => parseCanvasPackage(envelope),
        'invalid-type',
        'package.packageVersion',
      );
    });

    it('rejects an unsupported schema version', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      envelope.schemaVersion = CANVAS_PACKAGE_SCHEMA_VERSION + 1;
      expectPackageError(
        () => parseCanvasPackage(envelope),
        'unsupported-schema',
        'package.schemaVersion',
      );
    });

    it('rejects a missing document', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as Record<string, unknown>;
      delete envelope.document;
      expectPackageError(() => parseCanvasPackage(envelope), 'invalid-type', 'package.document');
    });

    it('rejects a malformed document and preserves the validation cause', () => {
      const e = expectPackageError(
        () =>
          parseCanvasPackage({
            kind: CANVAS_PACKAGE_KIND,
            packageVersion: CANVAS_PACKAGE_VERSION,
            schemaVersion: CANVAS_PACKAGE_SCHEMA_VERSION,
            document: { projectId: 'p', ownerId: 'o', createdAt: 0, updatedAt: 0 },
          }),
        'invalid-document',
        'package.document',
      );
      expect(e.cause).toBeInstanceOf(Error);
      expect((e.cause as Error).name).toBe('CanvasValidationError');
    });

    it('rejects a document carrying unknown fields', () => {
      const envelope = JSON.parse(encodeCanvasPackage(richDoc())) as {
        document: Record<string, unknown>;
      };
      envelope.document.extraField = 'x';
      expectPackageError(
        () => parseCanvasPackage(envelope),
        'invalid-document',
        'package.document',
      );
    });

    it('bounds the error message for a hostile oversized field name', () => {
      const giant = 'k'.repeat(10_000);
      const e = expectPackageError(
        () =>
          parseCanvasPackage({
            kind: CANVAS_PACKAGE_KIND,
            packageVersion: CANVAS_PACKAGE_VERSION,
            schemaVersion: CANVAS_PACKAGE_SCHEMA_VERSION,
            document: {},
            [giant]: 'x',
          }),
        'unknown-field',
      );
      expect(e.message.length).toBeLessThan(200);
    });

    it('bounds the error message for a hostile oversized kind value', () => {
      const e = expectPackageError(
        () =>
          parseCanvasPackage({
            kind: 'z'.repeat(10_000),
            packageVersion: CANVAS_PACKAGE_VERSION,
            schemaVersion: CANVAS_PACKAGE_SCHEMA_VERSION,
            document: richDoc(),
          }),
        'unknown-kind',
      );
      expect(e.message.length).toBeLessThan(200);
    });
  });

  describe('error shape', () => {
    it('reports name, code, path, and a descriptive message', () => {
      const e = expectPackageError(() => parseCanvasPackage(null), 'invalid-type', 'package');
      expect(e.message).toContain('at package');
      expect(typeof e.code).toBe('string');
      expect(typeof e.path).toBe('string');
    });
  });
});

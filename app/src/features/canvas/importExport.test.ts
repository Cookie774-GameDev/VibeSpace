import { describe, expect, it } from 'vitest';

import { unzlibSync } from 'fflate';
import {
  createCanvasBlock,
  createCanvasDocument,
  withBlockAdded,
  withPlacement,
  withPresentationNote,
  withPresentationOrder,
  type CanvasDocument,
} from './contracts';
import {
  CanvasImportExportError,
  exportCanvas,
  importCanvas,
  type CanvasImportFile,
} from './importExport';
import { createCanvasShape } from './shapes';

function documentFixture(): CanvasDocument {
  let document = createCanvasDocument({
    id: 'canvas-1',
    projectId: 'project-1',
    ownerId: 'owner-1',
    now: 1,
    title: 'Planning <board>',
    background: { kind: 'grid', color: '#123456' },
  });
  document = withBlockAdded(
    document,
    createCanvasBlock({
      id: 'heading-1',
      now: 2,
      content: { kind: 'heading', level: 1, text: 'Launch' },
    }),
    2,
  );
  document = withBlockAdded(
    document,
    createCanvasBlock({
      id: 'note-1',
      now: 3,
      content: { kind: 'note', text: 'Ship safely' },
    }),
    3,
  );
  document = withPlacement(
    document,
    { blockId: 'heading-1', x: 10, y: 20, width: 320, height: 120 },
    4,
  );
  document = withPresentationOrder(document, ['heading-1', 'note-1'], 5);
  document = withPresentationNote(document, 'heading-1', 'Open with the launch goal', 6);
  return withPresentationNote(document, 'note-1', 'Emphasize the safety checklist', 7);
}

function file(name: string, mimeType: string, data: string | Uint8Array): CanvasImportFile {
  return {
    name,
    mimeType,
    size: typeof data === 'string' ? new TextEncoder().encode(data).length : data.length,
    data,
  };
}

function pngPixel(bytes: Uint8Array, x: number, y: number): number[] {
  const compressed: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length =
      bytes[offset]! * 0x1000000 +
      (bytes[offset + 1]! << 16) +
      (bytes[offset + 2]! << 8) +
      bytes[offset + 3]!;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const compressedLength = compressed.reduce((total, part) => total + part.length, 0);
  const idat = new Uint8Array(compressedLength);
  let idatOffset = 0;
  for (const part of compressed) {
    idat.set(part, idatOffset);
    idatOffset += part.length;
  }
  const pixels = unzlibSync(idat);
  const rowSize = 1 + 1280 * 4;
  const pixelOffset = y * rowSize + 1 + x * 4;
  return Array.from(pixels.subarray(pixelOffset, pixelOffset + 4));
}

describe('canvas import and export', () => {
  it('round-trips a deterministic portable package without losing document fidelity', async () => {
    const document = documentFixture();
    const first = exportCanvas(document, { format: 'package' });
    const second = exportCanvas(document, { format: 'package' });

    expect(first.mimeType).toBe('application/vnd.vibespace.canvas+json');
    expect(first.bytes).toEqual(second.bytes);

    const imported = await importCanvas(
      file('planning.vibespace.json', first.mimeType, first.bytes),
    );
    expect(imported.kind).toBe('document');
    if (imported.kind === 'document') {
      expect(imported.document).toEqual(document);
      expect(Object.isFrozen(imported.document)).toBe(true);
    }
  });

  it('imports canonical JSON and Markdown as immutable validated documents', async () => {
    const document = documentFixture();
    const json = exportCanvas(document, { format: 'json' });
    const importedJson = await importCanvas(file('planning.json', json.mimeType, json.bytes));
    expect(importedJson.kind).toBe('document');

    const markdown = '# Roadmap\n\nFirst milestone\n\n```ts\nalert(1)\n```';
    const importedMarkdown = await importCanvas(file('roadmap.md', 'text/markdown', markdown), {
      identity: { id: 'markdown-1', projectId: 'project-1', ownerId: 'owner-1', now: 10 },
    });
    expect(importedMarkdown.kind).toBe('document');
    if (importedMarkdown.kind === 'document') {
      expect(importedMarkdown.document.title).toBe('Roadmap');
      expect(importedMarkdown.document.blocks.map((block) => block.content.kind)).toEqual([
        'heading',
        'text',
        'code',
      ]);
    }
  });

  it('imports bounded raster images, PDF files, and inert supported diagram text', async () => {
    const png = exportCanvas(documentFixture(), { format: 'png', width: 2, height: 3 }).bytes;
    const image = await importCanvas({
      ...file('pixel.png', 'image/png', png),
      width: 2,
      height: 3,
    });
    expect(image).toMatchObject({ kind: 'asset', width: 2, height: 3, mimeType: 'image/png' });

    const pdfBytes = exportCanvas(documentFixture(), { format: 'pdf' }).bytes;
    const pdf = await importCanvas(file('slides.pdf', 'application/pdf', pdfBytes));
    expect(pdf).toMatchObject({ kind: 'pdf', pageCount: 1 });

    const diagram = await importCanvas(
      file('flow.mmd', 'text/x-mermaid', 'graph TD\nA-->B\nclick A "javascript:alert(1)"'),
    );
    expect(diagram).toMatchObject({ kind: 'diagram', syntax: 'mermaid' });
    if (diagram.kind === 'diagram') {
      expect(diagram.source).not.toContain('javascript:');
    }
  });

  it('emits real PNG, SVG, PDF, Markdown and presentation-PDF artifacts', () => {
    const document = documentFixture();
    const png = exportCanvas(document, {
      format: 'png',
      width: 4,
      height: 3,
      scale: 2,
      background: '#abcdef',
    });
    expect(Array.from(png.bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png).toMatchObject({ width: 8, height: 6, background: '#abcdef' });
    expect(new TextDecoder('latin1').decode(png.bytes)).toContain('Launch');
    expect(new TextDecoder('latin1').decode(png.bytes)).toContain('Ship safely');
    const selectedPng = exportCanvas(document, {
      format: 'png',
      width: 4,
      height: 3,
      scale: 2,
      background: '#abcdef',
      scope: { kind: 'objects', blockIds: ['note-1'] },
    });
    expect(selectedPng.bytes).not.toEqual(png.bytes);

    const svg = exportCanvas(document, { format: 'svg', width: 640, height: 480 });
    expect(new TextDecoder().decode(svg.bytes)).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
    expect(new TextDecoder().decode(svg.bytes)).toContain('Planning &lt;board&gt;');

    const pdf = exportCanvas(document, { format: 'pdf' });
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 8))).toContain('%PDF-1.');

    const markdown = exportCanvas(document, { format: 'markdown' });
    expect(new TextDecoder().decode(markdown.bytes)).toContain('# Launch');

    const presentation = exportCanvas(document, { format: 'presentation-pdf' });
    expect(new TextDecoder().decode(presentation.bytes)).toContain('/Count 2');
  });

  it('paginates long standard PDF exports instead of clipping items below the page', () => {
    let document = createCanvasDocument({
      id: 'long-pdf-export',
      projectId: 'project-1',
      ownerId: 'owner-1',
      now: 1,
      title: 'Long PDF export',
    });
    for (let index = 0; index < 40; index += 1) {
      document = withBlockAdded(
        document,
        createCanvasBlock({
          id: `pdf-line-${index + 1}`,
          now: index + 2,
          content: {
            kind: 'note',
            text: index === 0 ? `Visible item 1 ${'x'.repeat(120)}` : `Visible item ${index + 1}`,
          },
        }),
        index + 2,
      );
    }

    const pdfText = new TextDecoder().decode(exportCanvas(document, { format: 'pdf' }).bytes);

    expect(pdfText).toMatch(/\/Count 2\b/u);
    expect(pdfText).toContain('(Visible item 40) Tj');
    expect(pdfText).toContain(`(${'x'.repeat(96)}) Tj`);
    expect(pdfText).toContain(`(${'x'.repeat(24)}) Tj`);
  });

  it('fits the whole Canvas placement inside a padded PNG export frame', () => {
    let document = createCanvasDocument({
      id: 'visual-export-layout',
      projectId: 'project-1',
      ownerId: 'owner-1',
      now: 1,
      title: 'Bounded export',
    });
    document = withBlockAdded(
      document,
      createCanvasBlock({
        id: 'visual-export-note',
        now: 2,
        content: { kind: 'note', text: 'Ship safely' },
      }),
      2,
    );
    document = withPlacement(
      document,
      { blockId: 'visual-export-note', x: 250, y: 300, width: 280, height: 180 },
      3,
    );

    const artifact = exportCanvas(document, {
      format: 'png',
      width: 1280,
      height: 720,
      background: '#abcdef',
    });

    expect(pngPixel(artifact.bytes, 2, 1)).toEqual([0xab, 0xcd, 0xef, 255]);
    expect(pngPixel(artifact.bytes, 640, 360)).toEqual([255, 255, 255, 255]);
  });

  it('exports shape labels without dropping the real shape payload', () => {
    let document = createCanvasDocument({
      id: 'shape-export',
      projectId: 'project-1',
      ownerId: 'owner-1',
      now: 1,
      title: 'Shape export',
    });
    document = withBlockAdded(
      document,
      createCanvasBlock({
        id: 'shape-1',
        now: 2,
        content: {
          kind: 'shape',
          shape: createCanvasShape({
            id: 'shape-1',
            kind: 'diamond',
            fill: '#2f80ed',
            text: 'Architecture decision',
          }),
        },
      }),
      2,
    );
    document = withPlacement(
      document,
      { blockId: 'shape-1', x: 10, y: 20, width: 180, height: 120 },
      3,
    );

    expect(new TextDecoder().decode(exportCanvas(document, { format: 'markdown' }).bytes)).toBe(
      '[Shape: diamond] Architecture decision',
    );
    const svg = new TextDecoder().decode(
      exportCanvas(document, { format: 'svg', width: 640, height: 480 }).bytes,
    );
    expect(svg).toContain('Architecture decision');
    expect(svg).toContain('<polygon');
    expect(svg).toContain('data-shape-kind="diamond"');
    expect(svg).toContain('fill="#2f80ed"');
    const json = JSON.parse(
      new TextDecoder().decode(exportCanvas(document, { format: 'json' }).bytes),
    ) as CanvasDocument;
    expect(json.blocks[0]?.content).toMatchObject({
      kind: 'shape',
      shape: { kind: 'diamond', fill: { color: '#2f80ed' } },
    });
  });

  it('re-imports its PNG bytes with preserved dimensions', async () => {
    const png = exportCanvas(documentFixture(), {
      format: 'png',
      width: 7,
      height: 5,
      background: '#fedcba',
    });
    const imported = await importCanvas(file('render.png', 'image/png', png.bytes));
    expect(imported).toMatchObject({ kind: 'asset', width: 7, height: 5 });
  });

  it('limits exports to selected objects while retaining deterministic scope metadata', () => {
    const document = documentFixture();
    const artifact = exportCanvas(document, {
      format: 'json',
      scope: { kind: 'objects', blockIds: ['note-1'] },
    });
    const parsed = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
      blocks: Array<{ id: string }>;
      pageOrder: string[];
    };
    expect(parsed.blocks.map((block) => block.id)).toEqual(['note-1']);
    expect(parsed.pageOrder).toEqual(['note-1']);
  });

  it('returns detached byte views that cannot mutate imported or exported artifacts', async () => {
    const exported = exportCanvas(documentFixture(), { format: 'png', width: 7, height: 5 });
    const exportedView = exported.bytes;
    exportedView[0] = 0;
    expect(exported.bytes[0]).toBe(137);

    const source = exported.bytes;
    const imported = await importCanvas(file('render.png', 'image/png', source));
    source[0] = 0;
    expect(imported.kind).toBe('asset');
    if (imported.kind === 'asset') {
      const importedView = imported.bytes;
      importedView[0] = 0;
      expect(imported.bytes[0]).toBe(137);
    }
  });

  it('fails closed on mismatched signatures, unsupported types, decompression bombs, and limits', async () => {
    await expect(
      importCanvas(file('fake.png', 'image/png', new TextEncoder().encode('<script>bad</script>'))),
    ).rejects.toMatchObject({ code: 'signature-mismatch' });
    const validPng = exportCanvas(documentFixture(), { format: 'png', width: 7, height: 5 }).bytes;
    await expect(
      importCanvas({ ...file('mismatch.png', 'image/png', validPng), width: 8, height: 5 }),
    ).rejects.toMatchObject({ code: 'invalid-dimension' });
    await expect(
      importCanvas(file('payload.svg', 'image/svg+xml', '<svg><script>bad</script></svg>')),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
    await expect(
      importCanvas(file('large.json', 'application/json', '{}'), { maxBytes: 1 }),
    ).rejects.toMatchObject({ code: 'oversized' });
    await expect(
      importCanvas(
        file(
          'bomb.vibespace.json',
          'application/vnd.vibespace.canvas+json',
          JSON.stringify({ compressedSize: 1, uncompressedSize: 10_000 }),
        ),
        { maxCompressionRatio: 10 },
      ),
    ).rejects.toBeInstanceOf(CanvasImportExportError);
    await expect(importCanvas(file('broken.json', 'application/json', '{'))).rejects.toMatchObject({
      code: 'malformed-file',
    });
    await expect(
      importCanvas(
        file(
          'many-pages.pdf',
          'application/pdf',
          exportCanvas(documentFixture(), {
            format: 'presentation-pdf',
          }).bytes,
        ),
        { maxPdfPages: 1 },
      ),
    ).rejects.toMatchObject({ code: 'oversized' });
  });

  it('rejects truncated raster containers and header-only or forged PDF structures', async () => {
    const validPng = exportCanvas(documentFixture(), { format: 'png', width: 7, height: 5 }).bytes;
    await expect(
      importCanvas(file('truncated.png', 'image/png', validPng.slice(0, -8))),
    ).rejects.toBeInstanceOf(CanvasImportExportError);
    await expect(
      importCanvas(file('truncated.jpg', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))),
    ).rejects.toBeInstanceOf(CanvasImportExportError);
    await expect(
      importCanvas(
        file(
          'truncated.gif',
          'image/gif',
          new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0]),
        ),
      ),
    ).rejects.toBeInstanceOf(CanvasImportExportError);
    await expect(
      importCanvas(
        file(
          'truncated.webp',
          'image/webp',
          new Uint8Array([82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 4, 0, 0, 0]),
        ),
      ),
    ).rejects.toBeInstanceOf(CanvasImportExportError);
    await expect(
      importCanvas(
        file('header-only.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7\n%%EOF\n')),
      ),
    ).rejects.toMatchObject({ code: 'malformed-file' });
    await expect(
      importCanvas(
        file(
          'forged-pages.pdf',
          'application/pdf',
          new TextEncoder().encode('%PDF-1.7\n/Type /Page\nstartxref\n9\n%%EOF\n'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'malformed-file' });
  });
});

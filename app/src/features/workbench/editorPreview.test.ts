import { describe, expect, it } from 'vitest';
import {
  buildDevicePreviewDocument,
  prefersDevicePreview,
  renderSafeMarkdownPreview,
  supportsEditorPreview,
} from './editorPreview';

describe('Workbench editor preview', () => {
  it('enables preview for any language', () => {
    expect(supportsEditorPreview('md')).toBe(true);
    expect(supportsEditorPreview('html')).toBe(true);
    expect(supportsEditorPreview('ts')).toBe(true);
    expect(supportsEditorPreview('css')).toBe(true);
  });

  it('marks web types as device previews', () => {
    expect(prefersDevicePreview('html')).toBe(true);
    expect(prefersDevicePreview('css')).toBe(true);
    expect(prefersDevicePreview('ts')).toBe(false);
  });

  it('escapes HTML and does not mirror raw script tags in markdown', () => {
    const html = renderSafeMarkdownPreview('# Title\n\n<script>alert(1)</script>\n\n**bold**');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('builds html and css device documents', () => {
    const htmlDoc = buildDevicePreviewDocument('html', '<h1>Hi</h1>');
    expect(htmlDoc).toContain('<h1>Hi</h1>');
    expect(htmlDoc.toLowerCase()).toContain('<!doctype html>');

    const cssDoc = buildDevicePreviewDocument('css', 'body { color: red; }');
    expect(cssDoc).toContain('body { color: red; }');
    expect(cssDoc).toContain('CSS preview');
  });

  it('runs JavaScript in the sandbox document and reports HTML/JS errors inside it', () => {
    const htmlDoc = buildDevicePreviewDocument(
      'html',
      '<!doctype html><html><head><script>throw Error("broken")</script></head><body>Hi</body></html>',
    );
    expect(htmlDoc.indexOf('vibespace-preview-error')).toBeLessThan(
      htmlDoc.indexOf('throw Error("broken")'),
    );
    expect(htmlDoc).toContain('unhandledrejection');

    const jsDoc = buildDevicePreviewDocument(
      'js',
      'document.querySelector("#preview-root").textContent = "Updated";',
    );
    expect(jsDoc).toContain('<main id="preview-root"></main>');
    expect(jsDoc).toContain('textContent = "Updated"');
    expect(jsDoc).toContain('vibespace-preview-error');
  });
});

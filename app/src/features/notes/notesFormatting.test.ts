import { describe, expect, it } from 'vitest';
import { formatNoteSelection, renderNotesMarkdown, toggleNoteChecklist } from './notesFormatting';
describe('Notes writing tools', () => {
  it('formats all selected lines as checklists, bullets and numbered steps', () => {
    expect(formatNoteSelection('alpha\nbeta', 0, 10, 'checklist').text).toBe(
      '- [ ] alpha\n- [ ] beta',
    );
    expect(formatNoteSelection('alpha\nbeta', 0, 10, 'bullet').text).toBe('- alpha\n- beta');
    expect(formatNoteSelection('alpha\nbeta', 0, 10, 'numbered').text).toBe('1. alpha\n2. beta');
  });
  it('inserts useful heading, quote, link, bold, italic, and fenced code without losing surrounding text', () => {
    expect(formatNoteSelection('hello world', 6, 11, 'bold').text).toBe('hello **world**');
    expect(formatNoteSelection('hello world', 6, 11, 'italic').text).toBe('hello *world*');
    expect(formatNoteSelection('Title', 0, 5, 'heading').text).toBe('## Title');
    expect(formatNoteSelection('quote', 0, 5, 'quote').text).toBe('> quote');
    expect(formatNoteSelection('example', 0, 7, 'link').text).toBe(
      '[example](https://example.com)',
    );
    expect(formatNoteSelection('let x = 1;', 0, 10, 'code').text).toBe('```\nlet x = 1;\n```');
  });
  it('toggles a task by original source line and leaves fenced examples unchanged', () => {
    const body = '## Tasks\n- [ ] Buy tea\n- [x] Read\n```\n- [ ] example\n```';
    expect(toggleNoteChecklist(body, 1)).toContain('- [x] Buy tea');
    expect(toggleNoteChecklist(body, 2)).toContain('- [ ] Read');
    expect(toggleNoteChecklist(body, 4)).toBe(body);
  });
  it('previews interactive tasks, quotes and safe links while escaping hostile HTML and URLs', () => {
    const html = renderNotesMarkdown(
      '- [ ] Buy tea\n- [x] Read\n\n> A quote\n\n[Link](https://example.com)\n\n<script>alert(1)</script>',
    );
    expect(html).toContain('data-note-line="0"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('href="https://example.com/"');
    expect(html).not.toContain('<script>');
    expect(renderNotesMarkdown('[bad](javascript:alert(1))')).not.toContain('href=');
  });
});

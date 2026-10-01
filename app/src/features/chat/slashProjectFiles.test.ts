import { describe, expect, it } from 'vitest';
import {
  extractInlineUtilitySlashCommands,
  getInlineSlashContext,
  isSafeAbsoluteAttachmentPath,
  relativeDisplayPath,
} from './slashProjectFiles';

describe('getInlineSlashContext', () => {
  it('detects slash at the start, middle, and end of a message', () => {
    expect(getInlineSlashContext('/file', 5)).toEqual({ start: 0, query: 'file' });
    expect(getInlineSlashContext('please /file', 12)).toEqual({ start: 7, query: 'file' });
    expect(getInlineSlashContext('note (/clearfiles', 17)?.query).toBe('clearfiles');
    expect(getInlineSlashContext('hello world /pl', 15)).toEqual({ start: 12, query: 'pl' });
  });

  it('does not trigger mid-word', () => {
    expect(getInlineSlashContext('https://example.com', 12)).toBeNull();
  });
});

describe('extractInlineUtilitySlashCommands', () => {
  it('pulls clearfiles and file tokens from mid-message prose', () => {
    const result = extractInlineUtilitySlashCommands(
      'Please /clearfiles and then attach /file readme.md thanks',
    );
    expect(result.utilities.map((u) => u.cmd)).toEqual(['clearfiles', 'file']);
    expect(result.utilities[1]?.rest).toMatch(/readme\.md/i);
    expect(result.cleaned.toLowerCase()).toContain('please');
    expect(result.cleaned.toLowerCase()).toContain('thanks');
    expect(result.cleaned).not.toMatch(/\/clearfiles/i);
  });

  it('ignores multitask-style task commands in prose extraction', () => {
    const result = extractInlineUtilitySlashCommands('/multitask build the thing');
    expect(result.utilities).toEqual([]);
  });
});

describe('relativeDisplayPath', () => {
  it('strips the project root prefix for display', () => {
    expect(
      relativeDisplayPath('C:\\Users\\viper\\proj', 'C:\\Users\\viper\\proj\\src\\App.tsx'),
    ).toBe('src\\App.tsx');
  });
});

describe('isSafeAbsoluteAttachmentPath', () => {
  it('accepts bounded Windows, UNC, and POSIX absolute paths', () => {
    expect(isSafeAbsoluteAttachmentPath('C:\\work tree\\notes.md')).toBe(true);
    expect(isSafeAbsoluteAttachmentPath('\\\\server\\share\\notes.md')).toBe(true);
    expect(isSafeAbsoluteAttachmentPath('/workspace/notes.md')).toBe(true);
  });

  it('rejects relative, traversal, URI, control-character, and oversized paths', () => {
    expect(isSafeAbsoluteAttachmentPath('notes.md')).toBe(false);
    expect(isSafeAbsoluteAttachmentPath('..\\secrets.txt')).toBe(false);
    expect(isSafeAbsoluteAttachmentPath('C:\\work\\..\\secrets.txt')).toBe(false);
    expect(isSafeAbsoluteAttachmentPath('file:///C:/work/notes.md')).toBe(false);
    expect(isSafeAbsoluteAttachmentPath('C:\\work\\bad\nname.md')).toBe(false);
    expect(isSafeAbsoluteAttachmentPath(`C:\\${'x'.repeat(4_096)}`)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildSttCommittedValue,
  buildSttPreviewValue,
  captureSttTextSnapshot,
  separatorForBefore,
  captureSttFieldSnapshot,
  previewSttInField,
  revertSttPreview,
} from './sttInterimEditor';

describe('sttInterimEditor', () => {
  it('builds live preview with spacing', () => {
    const snap = captureSttTextSnapshot('Hello', 5, 5);
    expect(buildSttPreviewValue(snap, 'world')).toBe('Hello world');
  });

  it('commits final text from snapshot', () => {
    const snap = captureSttTextSnapshot('Hi', 2, 2);
    expect(buildSttCommittedValue(snap, 'there')).toBe('Hi there');
  });

  it('returns null for empty finals', () => {
    const snap = captureSttTextSnapshot('Hi', 2, 2);
    expect(buildSttCommittedValue(snap, '   ')).toBeNull();
  });

  it('separatorForBefore avoids double spaces', () => {
    expect(separatorForBefore('Hi ')).toBe('');
    expect(separatorForBefore('Hi')).toBe(' ');
  });
});

describe('dictation cancellation preserves owned text', () => {
  it('restores selected text and the original selection after a cancelled preview', () => {
    const input = document.createElement('textarea');
    input.value = 'alpha old words omega';
    input.setSelectionRange(6, 15);
    const snapshot = captureSttFieldSnapshot(input);
    previewSttInField(input, snapshot, 'new words');
    expect(input.value).toBe('alpha new words omega');
    revertSttPreview(input, snapshot);
    expect(input.value).toBe('alpha old words omega');
    expect([input.selectionStart, input.selectionEnd]).toEqual([6, 15]);
  });

  it('does not delete the selection for empty/whitespace partial transcripts', () => {
    const snapshot = captureSttTextSnapshot('alpha old words omega', 6, 15);
    expect(buildSttPreviewValue(snapshot, '   ')).toBe('alpha old words omega');
  });
});

import { describe, expect, it } from 'vitest';
import { extractAbsoluteFilePaths } from './Composer';

describe('composer file path detection', () => {
  it('extracts a Windows path with spaces from a natural-language request', () => {
    expect(
      extractAbsoluteFilePaths(
        'C:\\Users\\dev\\Documents\\project\\Scripts\\Editor\\context_map.json please summarize this',
      ),
    ).toEqual([
      'C:\\Users\\dev\\Documents\\project\\Scripts\\Editor\\context_map.json',
    ]);
  });

  it('deduplicates repeated file paths', () => {
    const path = 'C:\\project\\AnimalOutputGenerator.cs';
    expect(extractAbsoluteFilePaths(`${path} summarize ${path}`)).toEqual([path]);
  });
});

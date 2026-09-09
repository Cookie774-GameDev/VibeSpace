import { describe, expect, it } from 'vitest';
import { findJarvisDisplayLinks } from './referenceParser';

describe('bare links in formatted factual answers', () => {
  it.each([
    '**Release date:** 2026-10-14',
    '**Current region:** eu-west-2',
    '__Retention:__ 45 days',
    '*Owner:* Mara Chen',
  ])('does not redact a field label: %s', (text) => {
    expect(findJarvisDisplayLinks(text)).toEqual([]);
  });

  it('still detects real links and unsafe scheme payloads next to bold labels', () => {
    expect(findJarvisDisplayLinks(
      '**Source:** https://example.com/reference javascript:alert(1) custom:**payload',
    ).map(({ target }) => target)).toEqual([
      'https://example.com/reference', 'javascript:alert(1)', 'custom:**payload',
    ]);
  });
});

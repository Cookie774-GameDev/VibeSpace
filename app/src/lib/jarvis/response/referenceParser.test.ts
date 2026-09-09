import { describe, expect, it } from 'vitest';
import { findJarvisDisplayLinks } from './referenceParser';

describe('bare links in formatted factual answers', () => {
  it('preserves inline Maven coordinates while checking explicit links to the same text', () => {
    const coordinate = 'com.example.log4j:log4j-examples:jar:1.0-SNAPSHOT';
    expect(findJarvisDisplayLinks(`Root artifact: \`${coordinate}\``)).toEqual([]);
    expect(findJarvisDisplayLinks(`[artifact](${coordinate})`)).toHaveLength(1);
    expect(findJarvisDisplayLinks('`javascript:alert(1)`')).toHaveLength(1);
  });
  it.each([
    '**Release date:** 2026-10-14',
    '**Current region:** eu-west-2',
    '__Retention:__ 45 days',
    '*Owner:* Mara Chen',
  ])('does not redact a field label: %s', (text) => {
    expect(findJarvisDisplayLinks(text)).toEqual([]);
  });

  it('still detects real links and unsafe scheme payloads next to bold labels', () => {
    expect(
      findJarvisDisplayLinks(
        '**Source:** https://example.com/reference javascript:alert(1) custom:**payload',
      ).map(({ target }) => target),
    ).toEqual(['https://example.com/reference', 'javascript:alert(1)', 'custom:**payload']);
  });
});

it('preserves canonical Context identifiers as inert text while checking links', () => {
  const hash = 'a'.repeat(64);
  for (const id of [
    `ptr:rlm:${hash}:0:263`,
    `ptr:rlm:${hash}:0:263:expand:6144:6144`,
    `rlm-source:${hash}`,
    `sha256:${hash}`,
  ]) {
    expect(findJarvisDisplayLinks(`Source identifier: \`${id}\``)).toEqual([]);
    expect(findJarvisDisplayLinks(`[source](${id})`)).toHaveLength(1);
  }
  expect(findJarvisDisplayLinks('javascript:alert(1)')).toHaveLength(1);
});

it('keeps a Context handle type label inert without trusting navigation links', () => {
  expect(findJarvisDisplayLinks('ptr:rlm evidence ID:')).toEqual([]);
  expect(findJarvisDisplayLinks('[handle](ptr:rlm)')).toHaveLength(1);
  expect(findJarvisDisplayLinks('ptr:unexpected')).toHaveLength(1);
});

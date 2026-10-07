import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessagePart } from './MessagePart';
import type { Part } from '@/types/chat';

const source = (uri: string): Part => ({
  kind: 'jarvis_source_ref',
  source: {
    id: 'issued-opaque-handle',
    kind: 'context_node',
    label: 'Context evidence handle',
    uri,
    trust: 'app_verified',
    sensitivity: 'private',
  },
});
afterEach(cleanup);
describe('canonical Context source chip routing', () => {
  it.each([
    'vibespace:context/evidence/issued-opaque-handle',
    'vibespace:context/evidence/historical-missing-backing',
  ])('has no external URI target for %s', (uri) => {
    const view = render(<MessagePart part={source(uri)} allParts={[]} />);
    expect(screen.queryByRole('link', { name: 'Context evidence handle' })).toBeNull();
    const chip = screen.getByRole('button', { name: 'Context evidence handle' });
    expect(chip.getAttribute('type')).toBe('button');
    expect(view.container.querySelector('[target="_blank"]')).toBeNull();
    expect(chip.className).toContain('inline-flex');
  });
  it('preserves ordinary source links', () => {
    render(<MessagePart part={source('https://example.invalid/reference')} allParts={[]} />);
    expect(screen.getByRole('link', { name: 'Context evidence handle' }).getAttribute('href')).toBe(
      'https://example.invalid/reference',
    );
  });
});

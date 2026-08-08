import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmojiMark } from './EmojiMark';

afterEach(cleanup);

describe('EmojiMark', () => {
  it('preserves existing unicode skill emojis', () => {
    render(<EmojiMark token="🧭" label="Existing skill emoji" />);
    expect(screen.getByLabelText('Existing skill emoji').textContent).toContain('🧭');
  });

  it('renders a stable VibeSpace definition and falls back for missing tokens', () => {
    const { rerender } = render(<EmojiMark token="vibe:aurora-builder" label="Agent icon" />);
    expect(screen.getByLabelText('Agent icon').getAttribute('data-emoji-id')).toBe(
      'vibe:aurora-builder',
    );

    rerender(<EmojiMark token="upload:missing-asset" label="Agent icon" />);
    expect(screen.getByLabelText('Agent icon').getAttribute('data-emoji-id')).toBe(
      'vibe:aurora-spark',
    );
  });
});

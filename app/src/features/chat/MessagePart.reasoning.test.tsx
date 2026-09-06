import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessagePart } from './MessagePart';

describe('provider-exposed thinking', () => {
  it('starts collapsed and retains expansion while exposed text streams', () => {
    const { rerender } = render(<MessagePart allParts={[]} part={{ kind: 'reasoning', text: 'Checking the files.' }} />);
    const toggle = screen.getByRole('button', { name: 'Thinking' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Checking the files.')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Checking the files.')).toBeTruthy();
    rerender(<MessagePart allParts={[]} part={{ kind: 'reasoning', text: 'Checking the files. Found two changes.' }} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Checking the files. Found two changes.')).toBeTruthy();
  });

  it('explains unavailable details for an explicit empty reasoning signal', () => {
    render(<MessagePart allParts={[]} part={{ kind: 'reasoning', text: '' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(screen.getByText('Thinking details are unavailable for this response.')).toBeTruthy();
  });
});

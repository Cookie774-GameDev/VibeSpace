import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResponseDetails } from './ResponseDetails';

describe('saved response receipt', () => {
  it('shows the authoritative total including cached input rather than an incomplete sum', () => {
    render(<ResponseDetails usage={{execution: {mode: 'token-saver'}, provider: 'mock', model: 'fixture/model', input_tokens: 626, output_tokens: 228, total_tokens: 41814, cache_read_tokens: 40960}} />);
    expect(screen.getByText('Reported 41,814')).toBeTruthy();
    expect(screen.getByText('40,960')).toBeTruthy();
  });
  it('keeps the saved mode and route and distinguishes estimated from unavailable usage', () => {
    const receipt = { execution: { mode: 'token-saver' as const, effort: 'low' }, provider: 'mock' as const, model: 'fixture/receipt-model', input_tokens: 12, output_tokens: 3 };
    const { container, rerender } = render(<ResponseDetails usage={{ ...receipt, provenance: 'estimated' }} />);
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.getByText('Token Saver')).toBeTruthy();
    expect(screen.getByText(receipt.model)).toBeTruthy();
    expect(screen.getByText('low')).toBeTruthy();
    expect(screen.getByText('Estimated 15')).toBeTruthy();
    rerender(<ResponseDetails usage={{ ...receipt, input_tokens: 0, output_tokens: 0, provenance: 'unavailable' }} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText('Reported 0')).toBeNull();
  });

  it('does not invent an execution receipt for older messages', () => {
    const { container } = render(<ResponseDetails usage={{ input_tokens: 3, output_tokens: 2 }} />);
    expect(container.textContent).toBe('');
  });
});

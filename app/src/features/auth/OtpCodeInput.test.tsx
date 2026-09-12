import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OtpCodeInput } from './OtpCodeInput';

describe('OtpCodeInput accessibility contract', () => {
  it('provides stable unique identity, position labels, and standard autocomplete tokens', () => {
    render(<OtpCodeInput value="" onChange={vi.fn()} />);

    const inputs = Array.from({ length: 6 }, (_, index) =>
      screen.getByLabelText(`Digit ${index + 1} of 6`),
    );
    expect(new Set(inputs.map((input) => input.id)).size).toBe(6);
    expect(new Set(inputs.map((input) => input.getAttribute('name'))).size).toBe(6);
    inputs.forEach((input, index) => {
      expect(input.id).toBe(`auth-otp-digit-${index + 1}`);
      expect(input.getAttribute('name')).toBe(`otp-digit-${index + 1}`);
      expect(input.getAttribute('autocomplete')).toBe(index === 0 ? 'one-time-code' : 'off');
    });
    expect(screen.getByRole('group', { name: /six-digit verification code/i })).toBeTruthy();
  });

  it('preserves normalization and the six-digit cap', () => {
    const onChange = vi.fn();
    render(<OtpCodeInput value="" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Digit 1 of 6'), {
      target: { value: '12a34567' },
    });

    expect(onChange).toHaveBeenCalledWith('123456');
  });
});

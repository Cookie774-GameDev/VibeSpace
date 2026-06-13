import { useCallback, useEffect, useId, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { normalizeOtpCode } from './authValidation';

const OTP_LENGTH = 6;

export interface OtpCodeInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-invalid'?: boolean;
}

/**
 * Six-digit verification code entry with per-digit boxes, auto-advance,
 * backspace navigation, and full paste support.
 */
export function OtpCodeInput({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  'aria-invalid': ariaInvalid,
}: OtpCodeInputProps) {
  const labelId = useId();
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? '');

  const focusIndex = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(OTP_LENGTH - 1, index));
    refs.current[clamped]?.focus();
    refs.current[clamped]?.select();
  }, []);

  useEffect(() => {
    if (autoFocus && !disabled) focusIndex(0);
  }, [autoFocus, disabled, focusIndex]);

  function applyCode(next: string) {
    onChange(normalizeOtpCode(next));
  }

  function handleChange(index: number, raw: string) {
    const chunk = normalizeOtpCode(raw);
    if (!chunk) {
      const chars = value.padEnd(OTP_LENGTH, ' ').split('');
      chars[index] = '';
      applyCode(chars.join('').trimEnd());
      return;
    }

    if (chunk.length > 1) {
      applyCode(chunk);
      focusIndex(Math.min(chunk.length, OTP_LENGTH) - 1);
      return;
    }

    const chars = value.padEnd(OTP_LENGTH, ' ').split('');
    chars[index] = chunk;
    applyCode(chars.join('').trimEnd());
    if (index < OTP_LENGTH - 1) focusIndex(index + 1);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      focusIndex(index - 1);
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusIndex(index - 1);
    }
    if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusIndex(index + 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const pasted = normalizeOtpCode(event.clipboardData.getData('text'));
    if (!pasted) return;
    applyCode(pasted);
    focusIndex(Math.min(pasted.length, OTP_LENGTH) - 1);
  }

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="sr-only">
        Six-digit verification code
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-invalid={ariaInvalid}
        className="flex items-center justify-center gap-2 sm:gap-2.5"
      >
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={index === 0 ? OTP_LENGTH : 1}
            value={digit}
            disabled={disabled}
            aria-label={`Digit ${index + 1} of ${OTP_LENGTH}`}
            className={cn(
              'h-12 w-10 sm:h-14 sm:w-11 rounded-lg border bg-elevated text-center text-xl sm:text-2xl font-semibold tabular-nums tracking-widest text-foreground',
              'border-border shadow-sm transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/50 focus-visible:border-accent-cyan/60 focus-visible:scale-[1.03]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              digit && 'border-accent-cyan/35 bg-accent-cyan/5',
              ariaInvalid && 'border-destructive/50 focus-visible:ring-destructive/40',
            )}
            onChange={(e) => handleChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.currentTarget.select()}
          />
        ))}
      </div>
    </div>
  );
}

import { describe, expect, it } from 'vitest';
import {
  isCompleteOtpCode,
  normalizeOtpCode,
  validateEmail,
  validatePassword,
} from './authValidation';

describe('authValidation', () => {
  it('rejects empty and malformed emails', () => {
    expect(validateEmail('')).toMatch(/email/i);
    expect(validateEmail('not-an-email')).toMatch(/valid email/i);
    expect(validateEmail('you@example.com')).toBeNull();
  });

  it('enforces signup password rules', () => {
    expect(validatePassword('', 'signup')).toMatch(/password/i);
    expect(validatePassword('short1', 'signup')).toMatch(/8 characters/i);
    expect(validatePassword('allletters', 'signup')).toMatch(/number/i);
    expect(validatePassword('12345678', 'signup')).toMatch(/letter/i);
    expect(validatePassword('Jarvis42!', 'signup')).toBeNull();
  });

  it('only requires a password for sign-in', () => {
    expect(validatePassword('', 'signin')).toMatch(/password/i);
    expect(validatePassword('x', 'signin')).toBeNull();
  });

  it('normalizes pasted OTP codes', () => {
    expect(normalizeOtpCode('12 34-56')).toBe('123456');
    expect(normalizeOtpCode('1234567890')).toBe('123456');
    expect(isCompleteOtpCode('123456')).toBe(true);
    expect(isCompleteOtpCode('12345')).toBe(false);
  });
});

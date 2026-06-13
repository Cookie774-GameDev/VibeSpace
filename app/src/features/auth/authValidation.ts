const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return 'Enter your email to continue.';
  if (!EMAIL_RE.test(trimmed)) return 'Enter a valid email address.';
  return null;
}

export function validatePassword(password: string, mode: 'signin' | 'signup'): string | null {
  if (!password) return 'Enter a password.';
  if (mode === 'signup' && password.length < 8) {
    return 'Use at least 8 characters for your password.';
  }
  if (mode === 'signup' && !/[a-zA-Z]/.test(password)) {
    return 'Include at least one letter in your password.';
  }
  if (mode === 'signup' && !/\d/.test(password)) {
    return 'Include at least one number in your password.';
  }
  return null;
}

/** Strip non-digits and cap at six characters for email OTP entry. */
export function normalizeOtpCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function isCompleteOtpCode(code: string): boolean {
  return normalizeOtpCode(code).length === 6;
}

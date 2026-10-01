/**
 * Map Supabase Auth errors into short, user-facing copy.
 * Never surface raw stack traces or internal codes alone.
 */

export function formatAuthError(
  err: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  const raw =
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
      ? (err as { message: string }).message
      : err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : '';

  const message = raw.trim();
  if (!message) return fallback;
  const lower = message.toLowerCase();

  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Incorrect email or password.';
  }
  if (lower === 'authentication could not be verified. try again.') {
    return 'Authentication could not be verified. Try again.';
  }
  if (lower.includes('email not confirmed') || lower.includes('not confirmed')) {
    return 'Confirm your email first. Open Create account or use Resend code, then enter the 6-digit code we send.';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'Unable to complete sign-up. Try signing in or use Email code.';
  }
  if (lower.includes('otp') && (lower.includes('expired') || lower.includes('invalid'))) {
    return 'That code is invalid or expired. Request a new one and try again.';
  }
  if (lower.includes('token has expired') || lower.includes('otp_expired')) {
    return 'That code expired. Tap Resend code for a fresh one.';
  }
  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('over_email_send_rate_limit')
  ) {
    return 'Too many emails sent too quickly. Wait a minute, check spam, then try again.';
  }
  if (lower.includes('signup is disabled') || lower.includes('signups not allowed')) {
    return 'New sign-ups are temporarily disabled. Contact support if you need access.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Network error reaching VibeSpace Cloud. Check your connection and try again.';
  }
  if (lower.includes('user not found') || lower.includes('unable to validate email')) {
    return 'Unable to continue. Check the email and try again.';
  }

  // Provider copy is not an authenticated UI contract and can disclose account state.
  return fallback;
}

/**
 * Supabase returns a fake user with empty identities when signUp is called for
 * an email that already exists (email enumeration protection). No email is sent.
 */
export function isLikelyExistingAccountSignUp(data: {
  user?: { identities?: unknown[] | null } | null;
  session?: unknown;
}): boolean {
  if (data.session) return false;
  const identities = data.user?.identities;
  return Array.isArray(identities) && identities.length === 0;
}

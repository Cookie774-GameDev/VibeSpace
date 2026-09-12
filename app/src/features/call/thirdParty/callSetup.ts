const E164 = /^\+[1-9]\d{7,14}$/;
const EMERGENCY_NUMBERS = new Set(['+911', '+112', '+999', '+000', '+110', '+119']);

export function normalizeE164Phone(value: string): string | null {
  const normalized = `+${value.replace(/\D/g, '')}`;
  if (
    !value.trim().startsWith('+') ||
    !E164.test(normalized) ||
    EMERGENCY_NUMBERS.has(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function validateCallRecipient(name: string, phone: string): string | null {
  if (!name.trim()) return 'Enter the recipient’s name.';
  if (!normalizeE164Phone(phone)) {
    return 'Enter a valid non-emergency phone number with its country code, such as +1 312 555 0192.';
  }
  return null;
}

export function validateCallBrief(purpose: string, maximumMinutes: number): string | null {
  if (purpose.trim().length < 3) return 'Describe what this call should accomplish.';
  if (!Number.isFinite(maximumMinutes) || maximumMinutes < 1 || maximumMinutes > 15) {
    return 'Maximum duration must be between 1 and 15 minutes.';
  }
  return null;
}

export function callCreditImpact(credits: number): {
  credits: number;
  providerCostUsd: number;
  copy: string;
} {
  const safeCredits = Math.max(0, Math.ceil(Number.isFinite(credits) ? credits : 0));
  const providerCostUsd = safeCredits / 1_000;
  return {
    credits: safeCredits,
    providerCostUsd,
    copy:
      `Up to ${safeCredits.toLocaleString()} shared credits may be reserved ` +
      `(up to $${providerCostUsd.toFixed(2)} of company-paid provider usage). ` +
      'Only actual usage is settled; unused credits return to your pool.',
  };
}

export const THIRD_PARTY_CALL_GOALS = Object.freeze([
  'business_information',
  'reservation_request',
  'appointment_availability',
  'quote_request',
  'availability_check',
  'relay_message',
  'custom_information_request',
] as const);

export type ThirdPartyCallGoal = (typeof THIRD_PARTY_CALL_GOALS)[number];
export type CallDestinationType = 'owner' | 'saved_contact' | 'business' | 'one_time_number';

export interface ThirdPartyCallDraft {
  destinationType: Exclude<CallDestinationType, 'owner'>;
  destinationPhoneE164: string;
  destinationDisplayName: string;
  goal: ThirdPartyCallGoal;
  purpose: string;
  userInstructions: string;
  approvedScript: string;
  openingDisclosure: string;
  maximumDurationSeconds: number;
  maximumCreditReservation: number;
  allowedActions: string[];
}

const EMERGENCY_NUMBERS = new Set(['000', '08', '110', '112', '118', '119', '911', '999']);
const DESTINATION_TYPES = new Set(['saved_contact', 'business', 'one_time_number']);
const GOALS = new Set<string>(THIRD_PARTY_CALL_GOALS);
const ALLOWED_ACTIONS = new Set([
  'ask_questions',
  'collect_public_information',
  'request_availability',
  'relay_approved_message',
]);
const MAX_TEXT = 2_000;

function boundedText(value: unknown, min = 1, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

export function normalizeE164(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (EMERGENCY_NUMBERS.has(digits)) return null;
  let normalized: string;
  if (trimmed.startsWith('+')) {
    normalized = `+${digits}`;
  } else if (digits.length === 10) {
    normalized = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    normalized = `+${digits}`;
  } else {
    return null;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;
  return normalized;
}

export function buildOpeningDisclosure(displayName: unknown, purpose: unknown): string {
  const name =
    typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName.trim().slice(0, 120)
      : 'the person I am assisting';
  const reason =
    typeof purpose === 'string' && purpose.trim().length > 0
      ? purpose
          .trim()
          .replace(/[.\s]+$/u, '')
          .slice(0, 400)
      : 'ask a brief question';
  return `Hello, I am the VibeSPACE AI assistant calling on behalf of ${name}. I am calling to ${reason}.`;
}

export function validateThirdPartyCallDraft(
  raw: Record<string, unknown>,
): { ok: true; value: ThirdPartyCallDraft } | { ok: false; error: string } {
  const destinationType = raw.destinationType;
  if (typeof destinationType !== 'string' || !DESTINATION_TYPES.has(destinationType)) {
    return { ok: false, error: 'invalid_destination_type' };
  }
  const suppliedPhone = raw.destinationPhone ?? raw.destinationPhoneE164;
  const destinationPhoneE164 = normalizeE164(suppliedPhone);
  if (!destinationPhoneE164) return { ok: false, error: 'prohibited_destination' };
  if (!boundedText(raw.destinationDisplayName, 1, 160)) {
    return { ok: false, error: 'invalid_destination_name' };
  }
  if (typeof raw.goal !== 'string' || !GOALS.has(raw.goal)) {
    return { ok: false, error: 'unsupported_goal' };
  }
  if (!boundedText(raw.purpose, 3, 600)) return { ok: false, error: 'invalid_purpose' };
  if (!boundedText(raw.userInstructions, 0, MAX_TEXT)) {
    return { ok: false, error: 'invalid_instructions' };
  }
  if (!boundedText(raw.approvedScript, 3, MAX_TEXT)) {
    return { ok: false, error: 'invalid_script' };
  }
  if (
    !boundedText(raw.openingDisclosure, 10, 600) ||
    !/\b(?:AI|artificial intelligence)\b/i.test(raw.openingDisclosure) ||
    !/\bVibeSPACE\b/i.test(raw.openingDisclosure)
  ) {
    return { ok: false, error: 'missing_ai_disclosure' };
  }
  if (
    !Number.isInteger(raw.maximumDurationSeconds) ||
    Number(raw.maximumDurationSeconds) < 30 ||
    Number(raw.maximumDurationSeconds) > 1_800
  ) {
    return { ok: false, error: 'invalid_maximum_duration' };
  }
  if (
    !Number.isInteger(raw.maximumCreditReservation) ||
    Number(raw.maximumCreditReservation) < 1 ||
    Number(raw.maximumCreditReservation) > 500_000
  ) {
    return { ok: false, error: 'invalid_credit_reservation' };
  }
  const allowedActions = Array.isArray(raw.allowedActions)
    ? raw.allowedActions.filter(
        (value): value is string =>
          typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value),
      )
    : [];
  if (allowedActions.length > 32 || allowedActions.some((action) => !ALLOWED_ACTIONS.has(action))) {
    return { ok: false, error: 'invalid_allowed_actions' };
  }

  return {
    ok: true,
    value: {
      destinationType: destinationType as ThirdPartyCallDraft['destinationType'],
      destinationPhoneE164,
      destinationDisplayName: String(raw.destinationDisplayName).trim(),
      goal: raw.goal as ThirdPartyCallGoal,
      purpose: String(raw.purpose).trim(),
      userInstructions: String(raw.userInstructions).trim(),
      approvedScript: String(raw.approvedScript).trim(),
      openingDisclosure: String(raw.openingDisclosure).trim(),
      maximumDurationSeconds: Number(raw.maximumDurationSeconds),
      maximumCreditReservation: Number(raw.maximumCreditReservation),
      allowedActions: [...new Set(allowedActions)].sort(),
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export async function approvalFingerprint(material: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(material)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 512) return null;
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyTelnyxSignature({
  publicKeyBase64,
  signatureBase64,
  timestamp,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1_000),
  toleranceSeconds = 300,
}: {
  publicKeyBase64: string;
  signatureBase64: string;
  timestamp: string;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  if (!/^\d{10}$/.test(timestamp) || rawBody.length > 1_048_576) return false;
  const signedAt = Number(timestamp);
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowSeconds - signedAt) > toleranceSeconds) {
    return false;
  }
  const publicKey = decodeBase64(publicKeyBase64);
  const signature = decodeBase64(signatureBase64);
  if (!publicKey || publicKey.byteLength !== 32 || !signature || signature.byteLength !== 64) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    const payload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify('Ed25519', key, signature, payload);
  } catch {
    return false;
  }
}

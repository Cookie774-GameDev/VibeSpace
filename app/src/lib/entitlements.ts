/**
 * Entitlements — single source of truth for paid-tier capabilities.
 *
 * Today (v0.1.3): every install is on the `free` tier. Stripe billing
 * isn't wired, so paid tiers are documented but unenforceable. This
 * module exists so:
 *
 *   1. The Plans settings tab has authoritative copy/quotas to render
 *      (no scattered magic numbers in the UI).
 *   2. When Stripe lands, the auth store flips `plan` to `starter` /
 *      `pro` / `ultra` and consumers ask `canUseModel(...)` etc.
 *      without rewriting every call site.
 *
 * Pricing economics (the napkin math the rates are derived from):
 *
 *   - Stripe fees ~3% + sales tax/VAT ~10% blended + income tax ~25%
 *     means revenue → kept ≈ 0.97 × 0.90 × 0.75 ≈ 65%.
 *   - We target ≥ 50% net margin on the kept portion, so cost-of-goods
 *     should be ≤ ~33% of sticker price. Roughly 3× markup.
 *   - Quotas below are tuned so a typical full-burn month for a tier
 *     stays inside that 33% envelope; over-burn is rate-limited rather
 *     than charged because users hate surprise bills.
 *
 * Provider reference prices used (per-million tokens, late 2024):
 *   Gemini 2.5 Flash Lite : $0.10 in / $0.40 out
 *   Gemini 2.5 Flash      : $0.30 in / $2.50 out
 *   Gemini 2.5 Pro        : $1.25 in / $5.00 out
 *   Claude 3.5 Sonnet     : $3.00 in / $15.00 out
 *   Claude 3.5 Opus       : $15   in / $75    out
 *   GPT-4o                : $2.50 in / $10    out
 *   LiveKit voice         : ~$0.001 / participant-minute
 */

import {
  callVoiceBucketLine,
  DEEPGRAM_PROMO_LABEL,
  PHONE_MINUTES_BY_PLAN,
  UNLIMITED_LOCAL_KOKORO_LINE,
} from '@/lib/callVoiceMarketing';

export type PlanId = 'free' | 'starter' | 'pro' | 'ultra';

export interface AdminIdentity {
  email?: string | null;
  cloudEmail?: string | null;
  localUserId?: string | null;
}

/**
 * One canonical capability set per tier. Keep the shape stable — UI
 * code reads these fields directly to render comparison tables.
 */
export interface PlanDef {
  id: PlanId;
  /** Display label used as card title. */
  label: string;
  /** Sticker price in USD. `0` for the free tier. */
  priceUsd: number;
  /** Short tagline shown under the title. */
  tagline: string;
  /**
   * Human-readable feature lines for the Plans card. We render these
   * as a simple bulleted list — no rich content.
   */
  features: ReadonlyArray<string>;

  /* ------- Quotas / capabilities (consumed by entitlement helpers) ------- */

  /**
   * Models the user is allowed to call when running on Jarvis-hosted
   * inference (i.e. *without* their own provider key). BYOK keys are
   * always allowed in every tier — that's the Jarvis ethos.
   */
  hostedModels: ReadonlyArray<string>;
  /** Voice/call minutes included per month. `Infinity` = no cap. */
  voiceMinutesPerMonth: number;
  /** Whether Jarvis Call (outbound phone) is allowed. */
  jarvisCall: boolean;
  /** Whether cloud sync (chats, memories, custom tools) is included. */
  cloudSync: boolean;
  /** Whether the user can publish custom tools to their account. */
  toolPublishing: boolean;
  /** Whether the user is in the priority routing pool. */
  priorityRouting: boolean;
}

/* --------------------------------------------------------------------------
 * Tier definitions
 * --------------------------------------------------------------------------*/

const FREE: PlanDef = {
  id: 'free',
  label: 'Spark',
  priceUsd: 0,
  tagline: 'Your launchpad · bring your own keys',
  features: [
    'Free Gemini 2.5 Flash Lite via Google AI Studio (no card)',
    'Every BYOK provider works: Groq, Anthropic, OpenAI, OpenRouter, Together',
    UNLIMITED_LOCAL_KOKORO_LINE,
    'Custom tools (local), terminal swarm, wellness break',
    'Mod+Shift+A actions palette, full chat history, project Context',
    'Local-first — your data lives on this device',
  ],
  hostedModels: [],
  voiceMinutesPerMonth: 0,
  jarvisCall: false,
  cloudSync: false,
  toolPublishing: false,
  priorityRouting: false,
};

const STARTER: PlanDef = {
  id: 'starter',
  label: 'Orbit',
  priceUsd: 10,
  tagline: 'Voice & sync · zero friction',
  features: [
    'Everything in Free',
    '3,100 hosted AI message credits / mo',
    callVoiceBucketLine('starter')!,
    UNLIMITED_LOCAL_KOKORO_LINE,
    DEEPGRAM_PROMO_LABEL.starter!,
    'SMS to your phone (~100 texts/mo included)',
    'Cloud sync for chats and memories across devices',
    'Smart reminders, schedule notifications',
  ],
  hostedModels: [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
  ],
  voiceMinutesPerMonth: PHONE_MINUTES_BY_PLAN.starter,
  jarvisCall: true,
  cloudSync: true,
  toolPublishing: false,
  priorityRouting: false,
};

const PRO: PlanDef = {
  id: 'pro',
  label: 'Nova',
  priceUsd: 50,
  tagline: 'Premium firepower · every frontier model',
  features: [
    'Everything in Starter',
    '15,500 hosted AI message credits / mo',
    callVoiceBucketLine('pro')!,
    UNLIMITED_LOCAL_KOKORO_LINE,
    DEEPGRAM_PROMO_LABEL.pro!,
    'SMS to your phone (~500 texts/mo included)',
    'Publish custom tools and agents to your account',
    'Priority routing — no rate-limit pressure',
  ],
  hostedModels: [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-3-5-sonnet-latest',
    'gpt-4o',
  ],
  voiceMinutesPerMonth: PHONE_MINUTES_BY_PLAN.pro,
  jarvisCall: true,
  cloudSync: true,
  toolPublishing: true,
  priorityRouting: true,
};

const ULTRA: PlanDef = {
  id: 'ultra',
  label: 'Singularity',
  priceUsd: 100,
  tagline: 'Beyond limits · the entire universe unlocked',
  features: [
    'Everything in Pro',
    '31,000 hosted AI message credits / mo',
    callVoiceBucketLine('ultra')!,
    UNLIMITED_LOCAL_KOKORO_LINE,
    DEEPGRAM_PROMO_LABEL.ultra!,
    'SMS to your phone (~1,000 texts/mo included)',
    'Early access to new providers and models',
    'Dedicated rate-limit pool · direct support email',
  ],
  hostedModels: [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-3-5-sonnet-latest',
    'claude-3-opus-latest',
    'gpt-4o',
    'o1',
    'o1-mini',
  ],
  voiceMinutesPerMonth: PHONE_MINUTES_BY_PLAN.ultra,
  jarvisCall: true,
  cloudSync: true,
  toolPublishing: true,
  priorityRouting: true,
};

export const PLANS: Record<PlanId, PlanDef> = {
  free: FREE,
  starter: STARTER,
  pro: PRO,
  ultra: ULTRA,
};

/** Order used for rendering — Free first, then ascending price. */
export const PLAN_ORDER: ReadonlyArray<PlanId> = [
  'free',
  'starter',
  'pro',
  'ultra',
];

/* --------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

/**
 * Resolve a plan id to its definition. Falls back to Free for unknown
 * ids so a corrupt persisted store can't crash the UI.
 */
export function getPlan(id: PlanId | string | null | undefined): PlanDef {
  if (!id) return FREE;
  return PLANS[id as PlanId] ?? FREE;
}

/**
 * Whether a given hosted model id is allowed on this plan. BYOK
 * (the user supplied their own key) is always allowed — call this
 * only for hosted Jarvis inference.
 */
export function planAllowsHostedModel(plan: PlanId, modelId: string): boolean {
  return PLANS[plan].hostedModels.includes(modelId);
}

/** Whether voice/call features are allowed at all. */
export function planAllowsVoice(plan: PlanId): boolean {
  return PLANS[plan].voiceMinutesPerMonth > 0;
}

/** Voice/call minutes included per month. */
export function planVoiceQuota(plan: PlanId): number {
  return PLANS[plan].voiceMinutesPerMonth;
}

function envList(name: string): string[] {
  const value = String((import.meta.env as Record<string, unknown>)[name] ?? '');
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Admin is a computed entitlement from build/runtime configuration, not a
 * user-editable client flag. This keeps paid-feature gates from becoming a
 * trivial localStorage toggle while still allowing internal/admin builds.
 */
function blanketAdminBuildFlagEnabled(): boolean {
  const admin = String(import.meta.env.VITE_JARVIS_ADMIN ?? '').toLowerCase();
  const local = String(import.meta.env.VITE_JARVIS_LOCAL_ADMIN ?? '').toLowerCase();
  return admin === '1' || admin === 'true' || local === '1' || local === 'true';
}

export function isAdminIdentity(identity: AdminIdentity = {}): boolean {
  // Production bundles must never honor blanket admin toggles (release CI clears them).
  if (!import.meta.env.PROD && blanketAdminBuildFlagEnabled()) return true;

  const emails = envList('VITE_JARVIS_ADMIN_EMAILS');
  const ids = envList('VITE_JARVIS_ADMIN_LOCAL_IDS');
  const candidateEmails = [identity.email, identity.cloudEmail]
    .map((value) => value?.trim().toLowerCase())
    .filter(Boolean) as string[];
  const candidateId = identity.localUserId?.trim().toLowerCase();

  return (
    candidateEmails.some((email) => emails.includes(email)) ||
    Boolean(candidateId && ids.includes(candidateId))
  );
}

export function effectivePlan(plan: PlanId | string | null | undefined, admin = false): PlanId {
  if (admin) return 'ultra';
  const resolved = getPlan(plan);
  return resolved.id;
}

export function planAllowsJarvisCall(plan: PlanId, admin = false): boolean {
  return admin || PLANS[plan].jarvisCall;
}

export function planAllowsVoiceWithAdmin(plan: PlanId, admin = false): boolean {
  return admin || planAllowsVoice(plan);
}

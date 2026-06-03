import { useEffect, type ReactNode } from 'react';
import { nanoid } from 'nanoid';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Onboarding } from '@/features/onboarding';
import { RequireModelAccess } from './RequireModelAccess';

/**
 * Providers whose presence counts as "Jarvis has a real model to talk to".
 * A key for any of these satisfies the model-access gate. Google leads
 * because the free, no-card Gemini key is the path we push new users toward.
 *
 * `mock` is included so the Skip-the-gate button on RequireModelAccess can
 * register a sentinel mock key and let the user through. The mock provider
 * routes locally and produces fake replies — the chat composer still
 * surfaces the "add a Gemini key" nudge, so users always know how to swap
 * to a real model.
 */
const REAL_PROVIDER_KEYS = ['google', 'anthropic', 'openai', 'groq', 'mock'] as const;

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Gates the application shell behind two conditions:
 *
 *   1. A local user id exists (generated on first run).
 *   2. Onboarding is complete.
 *
 * Local-first: we never wait on a network round-trip here. Cloud sign-in is
 * optional and handled later via `SignInDialog`.
 *
 * The `seedIfEmpty()` helper is loaded lazily because it lives in another
 * subagent's slice of the codebase and may not be wired up yet at the time
 * AuthGate is consumed.
 */
export function AuthGate({ children }: AuthGateProps) {
  const localUserId = useAuthStore((s) => s.localUserId);
  const setLocalUser = useAuthStore((s) => s.setLocalUser);
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const onboardingComplete = useUIStore((s) => s.onboardingComplete);

  // Has the user connected a model yet? Either a real cloud provider key
  // or offline (local) mode satisfies the gate.
  const hasModelAccess =
    offlineMode || REAL_PROVIDER_KEYS.some((id) => !!apiKeys[id]);

  // 1. Generate a stable local user id on first run.
  useEffect(() => {
    if (!localUserId) {
      setLocalUser(`usr_${nanoid(16)}`);
    }
  }, [localUserId, setLocalUser]);

  // 2. Seed the local database (idempotent). Runs once we have a user id and
  // the seed module is available. Failures are non-fatal - the rest of the
  // app should still come up.
  useEffect(() => {
    if (!localUserId) return;
    let cancelled = false;
    (async () => {
      try {
        // @ts-ignore - module owned by another subagent, may not exist yet
        const mod: { seedIfEmpty?: () => Promise<void> | void } = await import(
          '@/lib/db/seed'
        );
        if (cancelled) return;
        await mod.seedIfEmpty?.();
      } catch {
        // seed module not yet wired - silent fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localUserId]);

  if (!onboardingComplete) {
    return <Onboarding />;
  }

  // Onboarding done but no model connected yet — require one before the app.
  if (!hasModelAccess) {
    return <RequireModelAccess />;
  }

  return <>{children}</>;
}

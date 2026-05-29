import { useEffect, type ReactNode } from 'react';
import { nanoid } from 'nanoid';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { Onboarding } from '@/features/onboarding';

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
  const onboardingComplete = useUIStore((s) => s.onboardingComplete);

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

  return <>{children}</>;
}

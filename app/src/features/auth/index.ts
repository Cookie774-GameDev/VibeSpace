/**
 * Auth feature barrel.
 *
 * `AuthGate` ships with the eagerly-loaded `App.tsx`, so anything we
 * re-export here lands on the boot graph. We deliberately do NOT
 * re-export `SignInDialog` from this barrel: it statically imports
 * `@/lib/supabase/client`, which would drag the ~210KB `@supabase/*`
 * SDK into the initial bundle even though the dialog itself is only
 * ever opened from the lazy-loaded settings panel. Consumers (today
 * just `features/settings/sections/Account.tsx`) import `SignInDialog`
 * by direct path so it stays inside the `settings-sections` chunk.
 */
export { AuthGate } from './AuthGate';

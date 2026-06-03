/**
 * WhatsNewHost — small wiring component that:
 *
 *   1. Reads the seen-version snapshot via `useWhatsNew()`.
 *   2. Auto-opens the modal once on boot if the build advertises a
 *      newer version than the user has dismissed (gated by
 *      `onboardingComplete` so a fresh install doesn't get
 *      "Welcome to Jarvis" + "What's new" stacked on top of each other).
 *   3. Lets the TopBar (or anywhere else) re-open the modal manually via
 *      `useUIStore.setWhatsNewOpen(true)`.
 *
 * The component itself renders the modal; the modal handles its own
 * close transitions. Marking-seen is wired to *every* close path
 * (overlay click, Escape, X button, "Got it" button) so the user can't
 * accidentally re-trigger the auto-open on the next boot by closing
 * non-canonically.
 */
import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { WhatsNewModal } from './WhatsNewModal';
import { useWhatsNew } from './useWhatsNew';

export function WhatsNewHost() {
  const open = useUIStore((s) => s.whatsNewOpen);
  const setOpen = useUIStore((s) => s.setWhatsNewOpen);
  const onboardingComplete = useUIStore((s) => s.onboardingComplete);

  const { hasUpdate, markSeen } = useWhatsNew();

  // One-shot auto-open on mount. We don't re-open if the user dismisses
  // and then the user re-opens manually — that's controlled by `open`.
  const autoOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!onboardingComplete) return; // wait until past onboarding
    if (!hasUpdate) return;
    autoOpenedRef.current = true;
    setOpen(true);
    // Note: we don't call markSeen() here — we mark on dismissal so the
    // user actually sees the modal before we forget about the bump.
  }, [hasUpdate, onboardingComplete, setOpen]);

  return (
    <WhatsNewModal
      open={open}
      onOpenChange={setOpen}
      onDismiss={markSeen}
    />
  );
}

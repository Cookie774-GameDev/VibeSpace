import * as React from 'react';
import { Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/ui';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';

/**
 * Compact voice trigger button - the affordance dropped into the TopBar.
 *
 * Behaviour (per docs/04 sec 6 + the brief):
 *  - Quick tap (< 550 ms): toggle the voice modal open / closed.
 *  - Hold (>= 550 ms): summons voice and keeps it open after release.
 *    Pointer capture keeps the release event fired even if the pointer
 *    leaves the button bounds while held.
 *  - Keyboard activation (Space / Enter while focused): toggle.
 *
 * The component is uncontrolled by default and binds to `useUIStore`. Pass
 * `active` + `onActiveChange` for a fully controlled instance (used by
 * Storybook-style demos and the VoiceModal's own minimal trigger surface).
 */

export interface VoiceTriggerProps {
  /** Controlled active state. Falls back to `useUIStore.voiceModalOpen`. */
  active?: boolean;
  /** Controlled change handler. Falls back to `useUIStore.setVoiceModalOpen`. */
  onActiveChange?: (next: boolean) => void;
  /** Tooltip side. Default: 'bottom'. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Optional class for sizing/positioning overrides. */
  className?: string;
}

const PTT_HOLD_MS = 550;

export function VoiceTrigger({ active, onActiveChange, side = 'bottom', className }: VoiceTriggerProps) {
  const storeOpen = useUIStore((s) => s.voiceModalOpen);
  const setStoreOpen = useUIStore((s) => s.setVoiceModalOpen);

  const isControlled = active !== undefined;
  const isActive = isControlled ? Boolean(active) : storeOpen;
  const setActive = React.useCallback(
    (next: boolean) => {
      if (isControlled) onActiveChange?.(next);
      else setStoreOpen(next);
    },
    [isControlled, onActiveChange, setStoreOpen],
  );

  const downTimeRef = React.useRef<number | null>(null);
  const heldRef = React.useRef(false);

  const clearPress = () => {
    downTimeRef.current = null;
    heldRef.current = false;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some headless / older webviews may reject capture - safe to ignore.
    }
    downTimeRef.current = Date.now();
    heldRef.current = false;
    window.setTimeout(() => {
      if (downTimeRef.current === null) return;
      if (Date.now() - downTimeRef.current >= PTT_HOLD_MS) {
        heldRef.current = true;
        if (!isActive) setActive(true);
      }
    }, PTT_HOLD_MS);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (downTimeRef.current === null) return;
    const wasHeld = heldRef.current;
    clearPress();
    if (wasHeld) {
      setActive(true);
    } else {
      // Quick tap - toggle.
      setActive(!isActive);
    }
  };

  const handlePointerCancel = () => {
    if (downTimeRef.current === null) return;
    const wasHeld = heldRef.current;
    clearPress();
    if (wasHeld) setActive(true);
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // detail === 0 = synthetic keyboard click (Space / Enter on focused button).
    // Pointer-driven clicks (detail >= 1) are already handled in pointerup.
    if (e.detail === 0) setActive(!isActive);
  };

  return (
    <Hint label={isActive ? 'Stop voice' : 'Talk to Jarvis'} hotkey={HOTKEYS.PUSH_TO_TALK} side={side}>
      <Button
        type="button"
        variant={isActive ? 'accent' : 'ghost'}
        size="icon"
        className={cn('relative', className)}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
        aria-pressed={isActive}
        aria-label={isActive ? 'Stop voice session' : 'Start voice session'}
      >
        <Mic />
        {isActive && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent-cyan shadow-[0_0_6px_hsl(var(--accent-cyan))]"
          />
        )}
      </Button>
    </Hint>
  );
}

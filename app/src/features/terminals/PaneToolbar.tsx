/**
 * PaneToolbar — the per-pane chrome buttons shared by Tiles and Splits.
 *
 * Rendered inside the chrome strip of every terminal pane. The full set:
 *
 *   - Font size cycle    (12 -> 14 -> 16 -> 12 ...)
 *   - Clear screen       (sends ^L so the shell redraws its prompt)
 *   - Fullscreen toggle  (hidden when there's only one pane in the page)
 *   - Close pane
 *
 * Splits-mode chrome composes this toolbar with two extra split-direction
 * buttons next to it (see `TerminalGrid.tsx`); both reuse the exported
 * `ChromeBtn` so hover treatment stays identical across modes.
 */
import * as React from 'react';
import { Maximize2, Minimize2, Type, Eraser, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { clearTerminalSession } from './terminalClear';

/**
 * Font size cycle order. Expanded range from 10 to 20 to allow richer
 * responsiveness and legibility control.
 */
export const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20] as const;
export const DEFAULT_FONT_SIZE = 13;

/** Build the T-key cycle with the settings baseline as the wrap target (replaces fixed 10px). */
export function buildFontSizeCycle(baseline: number): readonly number[] {
  const clamped = Math.max(1, Math.min(100, Math.round(baseline)));
  const withoutLegacyDefault = FONT_SIZES.filter((size) => size !== 10);
  if ((withoutLegacyDefault as readonly number[]).includes(clamped)) {
    return [clamped, ...withoutLegacyDefault.filter((size) => size !== clamped)];
  }
  return [clamped, ...withoutLegacyDefault];
}

/** Return the next font size in the cycle. Wraps back to the settings baseline. */
export function nextFontSize(current: number, baseline = DEFAULT_FONT_SIZE): number {
  const cycle = buildFontSizeCycle(baseline);
  const idx = cycle.indexOf(current);
  if (idx < 0) return cycle[1] ?? cycle[0] ?? baseline;
  return cycle[(idx + 1) % cycle.length] ?? baseline;
}

interface PaneToolbarProps {
  /**
   * The PTY session attached to this pane. Used by the Clear button to
   * write `^L` directly via `terminal_write`. `null` while spawn is in
   * flight; the button then no-ops silently.
   */
  sessionId: string | null | undefined;
  /** Pane id — used to route clear events when session ids are still syncing. */
  paneId?: string;
  /** Current font size in px (used in the tooltip + as cycle input). */
  fontSize: number;
  /** True when this pane is the page-level fullscreened one. */
  isFullscreen: boolean;
  /**
   * Whether to render the fullscreen toggle. The page hides it when
   * there's only one pane (fullscreen would be a visual no-op).
   */
  canFullscreen: boolean;
  onFontSizeCycle: () => void;
  onFullscreenToggle: () => void;
  onClose: () => void;
}

export function PaneToolbar({
  sessionId,
  paneId,
  fontSize,
  isFullscreen,
  canFullscreen,
  onFontSizeCycle,
  onFullscreenToggle,
  onClose,
}: PaneToolbarProps) {
  const [holdState, setHoldState] = React.useState<'idle' | 'holding' | 'confirm'>('idle');
  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const startHolding = (e: React.PointerEvent) => {
    if (holdState !== 'idle' || !sessionId) return;
    e.preventDefault();
    setHoldState('holding');
    holdTimerRef.current = setTimeout(() => {
      setHoldState('confirm');
      resetTimerRef.current = setTimeout(() => {
        setHoldState('idle');
      }, 3500);
    }, 1500);
  };

  const cancelHolding = () => {
    if (holdState === 'holding') {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      setHoldState('idle');
    }
  };

  React.useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleConfirmClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sessionId) return;

    clearTerminalSession(sessionId, paneId);

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setHoldState('idle');
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ChromeBtn
        title={`Font size · ${fontSize}px (cycle)`}
        onClick={onFontSizeCycle}
        aria-label={`Cycle font size (currently ${fontSize}px)`}
      >
        <Type className="h-3 w-3" />
      </ChromeBtn>

      {holdState === 'confirm' ? (
        <button
          type="button"
          onClick={handleConfirmClear}
          className="inline-flex h-5 items-center justify-center rounded border border-accent-copper bg-accent-copper/20 px-1.5 text-[9px] font-bold uppercase tracking-wider text-accent-copper transition-all hover:bg-accent-copper/30 select-none animate-pulse"
          title="Click to confirm clearing terminal"
        >
          Confirm?
        </button>
      ) : (
        <ChromeBtn
          title="Hold 1.5s to clear screen"
          onPointerDown={startHolding}
          onPointerUp={cancelHolding}
          onPointerLeave={cancelHolding}
          className="relative overflow-hidden select-none"
          aria-label="Hold 1.5s to clear screen"
        >
          <div
            className={cn(
              "absolute left-0 bottom-0 top-0 bg-accent-copper/30 pointer-events-none transition-all ease-linear",
              holdState === 'holding' ? "duration-[1500ms] w-full" : "duration-0 w-0"
            )}
          />
          <Eraser className="relative z-10 h-3 w-3" />
        </ChromeBtn>
      )}

      {canFullscreen && (
        <ChromeBtn
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen this pane'}
          onClick={onFullscreenToggle}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen this pane'}
          aria-pressed={isFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="h-3 w-3" />
          ) : (
            <Maximize2 className="h-3 w-3" />
          )}
        </ChromeBtn>
      )}
      <ChromeBtn title="Close pane" onClick={onClose} aria-label="Close pane">
        <X className="h-3 w-3" />
      </ChromeBtn>
    </div>
  );
}

/**
 * Compact icon button used inside pane chrome strips. Exported so the
 * splits renderer can use the same hover + disabled treatment for its
 * split-direction buttons (`SplitSquareHorizontal`, `SplitSquareVertical`).
 */
export interface ChromeBtnProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export function ChromeBtn({ children, className, ...rest }: ChromeBtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded',
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

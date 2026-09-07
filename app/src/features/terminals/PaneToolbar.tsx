/**
 * PaneToolbar — the per-pane chrome buttons shared by Tiles and Splits.
 *
 * Rendered inside the chrome strip of every terminal pane. The full set:
 *
 *   - Font size cycle    (12 -> 14 -> 16 -> 12 ...)
 *   - Clear screen       (hold 1.5s → Confirm)
 *   - Fullscreen toggle  (hidden when there's only one pane in the page)
 *   - Close pane         (hold 1.5s → Confirm — same pattern as Clear)
 *
 * Splits-mode chrome composes this toolbar with two extra split-direction
 * buttons next to it (see `TerminalGrid.tsx`); both reuse the exported
 * `ChromeBtn` so hover treatment stays identical across modes.
 */
import * as React from 'react';
import { Maximize2, Minimize2, Type, Eraser, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { clearTerminalSession } from './terminalClear';
import {
  HOLD_TO_CONFIRM_MS,
  createHoldToConfirmController,
  type HoldConfirmPhase,
} from './holdToConfirm';
import { openTerminalVibespacePalette } from './terminalSlashIntegration';

/**
 * Font size cycle order. Expanded range from 10 to 20 to allow richer
 * responsiveness and legibility control.
 */
export const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20] as const;
export const DEFAULT_FONT_SIZE = 9;

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

function useHoldToConfirm(canBegin?: () => boolean): {
  phase: HoldConfirmPhase;
  begin: (e: React.PointerEvent) => void;
  cancel: () => void;
  confirm: () => boolean;
} {
  const [phase, setPhase] = React.useState<HoldConfirmPhase>('idle');
  const canBeginRef = React.useRef(canBegin);
  canBeginRef.current = canBegin;

  const ctrlRef = React.useRef<ReturnType<typeof createHoldToConfirmController> | null>(null);
  if (!ctrlRef.current) {
    ctrlRef.current = createHoldToConfirmController({
      onPhaseChange: setPhase,
      canBegin: () => (canBeginRef.current ? canBeginRef.current() : true),
    });
  }

  React.useEffect(() => {
    return () => {
      ctrlRef.current?.dispose();
      // dispose resets timers and phase; retain the reusable controller through
      // StrictMode's effect cleanup/setup cycle so pointer handlers stay live.
    };
  }, []);

  const begin = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctrlRef.current?.beginHold();
  }, []);

  const cancel = React.useCallback(() => {
    ctrlRef.current?.cancelHold();
  }, []);

  const confirm = React.useCallback(() => ctrlRef.current?.confirm() ?? false, []);

  return { phase, begin, cancel, confirm };
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
  const canClear = React.useCallback(() => Boolean(sessionId), [sessionId]);
  // Close always allowed — last pane is handled by tree resolve (reset leaf).
  const canClose = React.useCallback(() => true, []);

  const clearHold = useHoldToConfirm(canClear);
  const closeHold = useHoldToConfirm(canClose);

  const handleConfirmClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!clearHold.confirm()) return;
    if (!sessionId) return;
    clearTerminalSession(sessionId, paneId);
  };

  const handleConfirmClose = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!closeHold.confirm()) return;
    onClose();
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ChromeBtn
        title="Open VibeSpace terminal palette (Ctrl/⌘+Shift+P)"
        aria-label="Open VibeSpace terminal palette"
        onClick={() => openTerminalVibespacePalette(paneId)}
      >
        <Sparkles className="h-3 w-3" />
      </ChromeBtn>

      <ChromeBtn
        title={`Font size · ${fontSize}px (cycle)`}
        onClick={onFontSizeCycle}
        aria-label={`Cycle font size (currently ${fontSize}px)`}
      >
        <Type className="h-3 w-3" />
      </ChromeBtn>

      {clearHold.phase === 'confirm' ? (
        <ConfirmChip
          label="Confirm clear"
          onClick={handleConfirmClear}
          title="Click to confirm clearing terminal"
        />
      ) : (
        <ChromeBtn
          title={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to clear screen`}
          onPointerDown={clearHold.begin}
          onPointerUp={clearHold.cancel}
          onPointerLeave={clearHold.cancel}
          onPointerCancel={clearHold.cancel}
          className="relative overflow-hidden select-none"
          aria-label={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to clear screen`}
          disabled={!sessionId}
        >
          <HoldFill active={clearHold.phase === 'holding'} />
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
          {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </ChromeBtn>
      )}

      {closeHold.phase === 'confirm' ? (
        <ConfirmChip
          label="Confirm close"
          onClick={handleConfirmClose}
          title="Click to confirm closing this terminal pane"
        />
      ) : (
        <ChromeBtn
          title={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to close pane`}
          onPointerDown={closeHold.begin}
          onPointerUp={closeHold.cancel}
          onPointerLeave={closeHold.cancel}
          onPointerCancel={closeHold.cancel}
          className="relative overflow-hidden select-none"
          aria-label={`Hold ${HOLD_TO_CONFIRM_MS / 1000}s to close pane`}
        >
          <HoldFill active={closeHold.phase === 'holding'} />
          <X className="relative z-10 h-3 w-3" />
        </ChromeBtn>
      )}
    </div>
  );
}

function HoldFill({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-0 left-0 top-0 bg-accent-copper/30 transition-all ease-linear',
        active ? 'w-full duration-[1500ms]' : 'w-0 duration-0',
      )}
    />
  );
}

function ConfirmChip({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => {
        // Prevent tile drag / right-drag handlers from swallowing the confirm.
        e.stopPropagation();
      }}
      className="inline-flex h-5 items-center justify-center rounded border border-accent-copper bg-accent-copper/20 px-1.5 text-[9px] font-bold uppercase tracking-wider text-accent-copper transition-all hover:bg-accent-copper/30 select-none animate-pulse"
      title={title}
      aria-label={label}
    >
      Confirm?
    </button>
  );
}

/**
 * Compact icon button used inside pane chrome strips. Exported so the
 * splits renderer can use the same hover + disabled treatment for its
 * split-direction buttons (`SplitSquareHorizontal`, `SplitSquareVertical`).
 */
export interface ChromeBtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export function ChromeBtn({ children, className, onPointerDown, ...rest }: ChromeBtnProps) {
  return (
    <button
      type="button"
      {...rest}
      onPointerDown={(e) => {
        // Keep chrome controls interactive even when the tile shell listens for drags.
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded',
        'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

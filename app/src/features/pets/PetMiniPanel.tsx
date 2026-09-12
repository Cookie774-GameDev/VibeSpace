/**
 * Pet mini-panel — compact desktop-wide Chat / Terminals companion.
 * Resizable + movable. Minimize/close hide the panel and restore the pet sprite.
 */
import * as React from 'react';
import { MessageSquare, Terminal, Minus, X, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  PET_PANEL_CLOSE_CONFIRM_BUTTONS,
  PET_PANEL_CLOSE_CONFIRM_MESSAGE,
  createInitialPanelLifecycle,
  panelPreservesSessions,
  reducePanelLifecycle,
  type PetPanelLifecycleState,
} from './petPanelLifecycle';
import { PetChatSurface } from './PetChatSurface';
import { PetTerminalSurface } from './PetTerminalSurface';
import { usePetPresentationStore } from './petPresentationStore';
import { hidePetPanel, minimizePetPanel } from './petTauriBridge';
import { setLivePanelUiScale } from '@/lib/ui/panelScale';
import {
  clampPetPanelSize,
  computeBottomRightAnchoredResize,
  loadPetPanelFloatGeometry,
  petPanelDensityForSize,
  petPanelUiScale,
  savePetPanelFloatGeometry,
  type PetPanelDensity,
} from './petPanelPreferences';
import { PetPanelUiProvider } from './petPanelUi';
import './petMiniPanel.css';

export type PetMiniPanelTab = 'chats' | 'terminals';

export interface PetMiniPanelProps {
  open: boolean;
  onClose: () => void;
  /** Called when user hits minimize — should restore floating pet. */
  onMinimize?: () => void;
  animLabel?: string;
  className?: string;
  windowMode?: boolean;
  resizable?: boolean;
  onLifecycleChange?: (state: PetPanelLifecycleState) => void;
}

const MIN_W = 320;
const MIN_H = 320;
const MAX_W = 1200;
const MAX_H = 1000;

const DEFAULT_FLOAT = { w: 460, h: 600, right: 28, bottom: 28 };

function initialFloatGeometry() {
  return loadPetPanelFloatGeometry() ?? DEFAULT_FLOAT;
}

export function PetMiniPanel({
  open,
  onClose,
  onMinimize,
  animLabel: _animLabel,
  className,
  windowMode = false,
  resizable = false,
  onLifecycleChange,
}: PetMiniPanelProps) {
  const savedFloat = React.useMemo(() => initialFloatGeometry(), []);
  const [tab, setTab] = React.useState<PetMiniPanelTab>('chats');
  const [density, setDensity] = React.useState<PetPanelDensity>('comfortable');
  const [contentSize, setContentSize] = React.useState({ w: savedFloat.w, h: savedFloat.h });
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ w: savedFloat.w, h: savedFloat.h });
  const [panelPos, setPanelPos] = React.useState({
    right: savedFloat.right,
    bottom: savedFloat.bottom,
  });
  // Prefer live measured size for scale; fall back to declared size while resizing.
  const uiScale = petPanelUiScale(
    contentSize.w || size.w,
    contentSize.h || size.h,
  );
  const [lifecycle, setLifecycle] = React.useState<PetPanelLifecycleState>(
    open || windowMode ? 'open' : createInitialPanelLifecycle(),
  );
  const clearUnread = usePetPresentationStore((s) => s.clearUnread);
  const setPanelLifecycle = usePetPresentationStore((s) => s.setPanelLifecycle);
  const transitionTimerRef = React.useRef(0);
  const sizeRef = React.useRef(size);
  const posRef = React.useRef(panelPos);
  sizeRef.current = size;
  posRef.current = panelPos;

  const transitionDuration = React.useCallback(() => {
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140;
    }
    return 140;
  }, []);

  React.useEffect(
    () => () => {
      window.clearTimeout(transitionTimerRef.current);
      setLivePanelUiScale(1);
    },
    [],
  );

  React.useLayoutEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const next = petPanelDensityForSize(rect.width, rect.height);
        setDensity((current) => (current === next ? current : next));
        const nextSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
        setContentSize((current) =>
          current.w === nextSize.w && current.h === nextSize.h ? current : nextSize,
        );
        setLivePanelUiScale(petPanelUiScale(nextSize.w, nextSize.h));
      });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(node);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const updateLifecycle = React.useCallback(
    (event: Parameters<typeof reducePanelLifecycle>[1]) => {
      setLifecycle((prev) => {
        const next = reducePanelLifecycle(prev, event);
        onLifecycleChange?.(next);
        setPanelLifecycle(next);
        return next;
      });
    },
    [onLifecycleChange, setPanelLifecycle],
  );

  React.useEffect(() => {
    if (open || windowMode) {
      window.clearTimeout(transitionTimerRef.current);
      updateLifecycle({ type: 'request_open' });
      transitionTimerRef.current = window.setTimeout(
        () => updateLifecycle({ type: 'opened' }),
        transitionDuration(),
      );
      clearUnread();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, windowMode]);

  React.useEffect(() => {
    if (!open && !windowMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lifecycle === 'confirmingClose') updateLifecycle({ type: 'cancel_close' });
        else updateLifecycle({ type: 'request_close' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, windowMode, lifecycle, updateLifecycle]);

  const handleMinimize = () => {
    window.clearTimeout(transitionTimerRef.current);
    updateLifecycle({ type: 'request_minimize' });
    transitionTimerRef.current = window.setTimeout(() => {
      updateLifecycle({ type: 'minimized' });
      try {
        localStorage.removeItem('vibespace-pet-panel-open');
      } catch {
        /* ignore */
      }
      void minimizePetPanel().catch(() => undefined);
      onMinimize?.();
      onClose(); // restores pet sprite via host panelOpen=false
    }, transitionDuration());
  };

  const handleCloseRequest = () => updateLifecycle({ type: 'request_close' });

  const handleConfirmClose = () => {
    window.clearTimeout(transitionTimerRef.current);
    updateLifecycle({ type: 'confirm_close' });
    transitionTimerRef.current = window.setTimeout(() => {
      updateLifecycle({ type: 'closed' });
      try {
        localStorage.removeItem('vibespace-pet-panel-open');
      } catch {
        /* ignore */
      }
      void hidePetPanel().catch(() => undefined);
      onClose();
    }, transitionDuration());
  };

  const handleCancelClose = () => updateLifecycle({ type: 'cancel_close' });

  const visible =
    windowMode ||
    open ||
    lifecycle === 'open' ||
    lifecycle === 'confirmingClose' ||
    lifecycle === 'opening' ||
    lifecycle === 'restoring';

  if (!visible && lifecycle !== 'minimized') return null;
  if (lifecycle === 'minimized' && !windowMode) return null;

  const startResize =
    (edge: 'se' | 'e' | 's' | 'sw' | 'ne' | 'n' | 'w') => (e: React.PointerEvent) => {
      if (!resizable || windowMode) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = sizeRef.current.w;
      const startH = sizeRef.current.h;
      const startRight = posRef.current.right;
      const startBottom = posRef.current.bottom;
      let last = { w: startW, h: startH, right: startRight, bottom: startBottom };
      const move = (ev: PointerEvent) => {
        const next = computeBottomRightAnchoredResize({
          edge,
          dx: ev.clientX - startX,
          dy: ev.clientY - startY,
          startW,
          startH,
          startRight,
          startBottom,
          minW: MIN_W,
          minH: MIN_H,
          maxW: MAX_W,
          maxH: MAX_H,
          minInset: 8,
        });
        last = { w: next.w, h: next.h, right: next.right, bottom: next.bottom };
        setSize({ w: next.w, h: next.h });
        setPanelPos({ right: next.right, bottom: next.bottom });
        setContentSize({ w: next.w, h: next.h });
        setLivePanelUiScale(petPanelUiScale(next.w, next.h));
      };
      const up = (ev: PointerEvent) => {
        target.releasePointerCapture?.(ev.pointerId);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        // Persist custom size so reopen restores the same footprint.
        const clamped = clampPetPanelSize(last.w, last.h);
        savePetPanelFloatGeometry({
          w: clamped.w,
          h: clamped.h,
          right: last.right,
          bottom: last.bottom,
        });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };

  const onHeaderDrag = (e: React.PointerEvent) => {
    if (windowMode || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startRight = posRef.current.right;
    const startBottom = posRef.current.bottom;
    const move = (ev: PointerEvent) => {
      setPanelPos({
        right: Math.max(8, startRight - (ev.clientX - startX)),
        bottom: Math.max(8, startBottom - (ev.clientY - startY)),
      });
    };
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture?.(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      savePetPanelFloatGeometry({
        w: sizeRef.current.w,
        h: sizeRef.current.h,
        right: posRef.current.right,
        bottom: posRef.current.bottom,
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // PetHost mounts outside AppShell, and the dedicated Tauri pet-mini-panel
  // window has no shell either — chat children use Tooltip/Hint and
  // crash without a provider ("Tooltip must be used within TooltipProvider").
  return (
    <TooltipProvider delayDuration={400}>
      <div
        ref={panelRef}
        className={cn(
          'pet-mini-panel-shell',
          windowMode
            ? 'fixed inset-0 z-50 flex flex-col bg-background'
            : cn(
                'fixed z-[81] flex flex-col overflow-hidden',
                'rounded-2xl border border-accent-copper/25',
                'bg-gradient-to-b from-panel via-panel to-background',
                'shadow-[0_24px_80px_-12px_rgba(0,0,0,0.65),0_0_0_1px_rgba(255,255,255,0.04)_inset]',
                'ring-1 ring-white/5',
              ),
          className,
        )}
        style={
          windowMode
            ? ({
                ['--pet-ui-scale' as string]: String(uiScale),
              } as React.CSSProperties)
            : ({
                right: panelPos.right,
                bottom: panelPos.bottom,
                width: size.w,
                height: size.h,
                maxWidth: '96vw',
                maxHeight: '92vh',
                ['--pet-ui-scale' as string]: String(uiScale),
              } as React.CSSProperties)
        }
        role="dialog"
        aria-modal="true"
        aria-label="Pet mini panel"
        data-pet-mini-panel="true"
        data-pet-panel-lifecycle={lifecycle}
        data-pet-panel-density={density}
        data-pet-ui-scale={uiScale.toFixed(2)}
        data-pet-preserves-sessions={panelPreservesSessions(lifecycle) ? 'true' : 'false'}
      >
        <PetPanelUiProvider density={density} width={contentSize.w} height={contentSize.h}>
        {/* Accent top edge */}
        {!windowMode && (
          <div
            className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-accent-copper to-transparent opacity-80 [html[data-theme=monochrome]_&]:hidden"
            aria-hidden
          />
        )}

        <div
          className="pet-panel-top border-b border-border/80"
          data-testid="pet-panel-header"
          data-collapsed="false"
        >
          <header
            className={cn(
              'pet-panel-header-row relative flex items-center gap-1.5 px-2 py-1.5',
              !windowMode && 'cursor-move',
            )}
            onPointerDown={onHeaderDrag}
          >
            {!windowMode && (
              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
            )}
            <nav className="pet-panel-nav flex min-w-0 gap-1" aria-label="Compact panel sections">
              {(
                [
                  ['chats', MessageSquare, 'Chat'],
                  ['terminals', Terminal, 'Terminals'],
                ] as const
              ).map(([id, Icon, label]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    data-testid={`pet-tab-${id}`}
                    aria-label={label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'pet-panel-nav-button inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-colors',
                      active
                        ? 'bg-accent-copper/15 text-accent-copper ring-1 ring-accent-copper/25'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="pet-panel-nav-label">{label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="pet-panel-drag-region" data-tauri-drag-region aria-hidden />
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleMinimize}
                aria-label="Minimize pet panel"
                data-testid="pet-panel-minimize"
                className="text-muted-foreground hover:text-foreground"
                title="Minimize — pet comes back"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleCloseRequest}
                aria-label="Close pet panel"
                data-testid="pet-panel-close"
                className="text-muted-foreground hover:text-destructive"
                title="Close — pet comes back"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </header>
        </div>

        <div className="pet-panel-workspace relative flex-1 min-h-0 overflow-hidden p-1">
          <div className="pet-panel-surface-frame h-full min-h-0 overflow-hidden rounded-lg border border-border/50">
            {tab === 'chats' ? (
              <PetChatSurface className="h-full p-1" />
            ) : (
              <PetTerminalSurface className="h-full p-1" />
            )}
          </div>
        </div>

        {/* Resize handles */}
        {resizable && !windowMode && (
          <>
            <div
              className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
              onPointerDown={startResize('se')}
              aria-label="Resize"
            />
            <div
              className="absolute bottom-0 left-0 right-4 h-1.5 cursor-s-resize"
              onPointerDown={startResize('s')}
            />
            <div
              className="absolute bottom-4 left-0 top-10 w-1.5 cursor-w-resize"
              onPointerDown={startResize('w')}
            />
            <div
              className="absolute bottom-4 right-0 top-10 w-1.5 cursor-e-resize"
              onPointerDown={startResize('e')}
            />
            <div
              className="absolute left-4 right-4 top-0 h-1 cursor-n-resize"
              onPointerDown={startResize('n')}
            />
            <div className="pointer-events-none absolute bottom-1 right-1 h-2.5 w-2.5 rounded-sm border-b-2 border-r-2 border-accent-copper/50" />
          </>
        )}

        {lifecycle === 'confirmingClose' && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm [html[data-theme=monochrome]_&]:backdrop-blur-none"
            data-testid="pet-close-confirm"
            role="alertdialog"
            aria-label="Confirm close mini panel"
          >
            <div className="max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-2xl flex flex-col gap-4">
              <p className="text-sm leading-relaxed text-foreground">
                {PET_PANEL_CLOSE_CONFIRM_MESSAGE}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={handleCancelClose}>
                  {PET_PANEL_CLOSE_CONFIRM_BUTTONS.cancel}
                </Button>
                <Button
                  variant="default"
                  onClick={handleConfirmClose}
                  data-testid="pet-close-confirm-btn"
                  className="bg-accent-copper hover:bg-accent-copper/90"
                >
                  {PET_PANEL_CLOSE_CONFIRM_BUTTONS.confirm}
                </Button>
              </div>
            </div>
          </div>
        )}
        </PetPanelUiProvider>
      </div>
    </TooltipProvider>
  );
}

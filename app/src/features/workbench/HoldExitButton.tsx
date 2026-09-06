import * as React from 'react';
import { X } from 'lucide-react';

const HOLD_MS = 700;

interface HoldExitButtonProps {
  onConfirmExit: () => void;
}

/**
 * Red hold-to-arm exit control: hold X, then click Confirm to leave Workbench.
 */
export function HoldExitButton({ onConfirmExit }: HoldExitButtonProps) {
  const [progress, setProgress] = React.useState(0);
  const [armed, setArmed] = React.useState(false);
  const rafRef = React.useRef<number | null>(null);
  const startRef = React.useRef<number | null>(null);

  const clearHold = React.useCallback(() => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    startRef.current = null;
    setProgress(0);
  }, []);

  const tick = React.useCallback(
    (now: number) => {
      if (startRef.current == null) return;
      const ratio = Math.min(1, (now - startRef.current) / HOLD_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        setArmed(true);
        clearHold();
        return;
      }
      rafRef.current = window.requestAnimationFrame(tick);
    },
    [clearHold],
  );

  const startHold = () => {
    if (armed || startRef.current != null) return;
    startRef.current = performance.now();
    rafRef.current = window.requestAnimationFrame(tick);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    startHold();
  };

  const onPointerUp = () => {
    if (!armed) clearHold();
  };

  React.useEffect(() => () => clearHold(), [clearHold]);

  return (
    <div className="workbench-exit-cluster">
      {armed ? (
        <button
          type="button"
          className="workbench-exit-confirm"
          onClick={() => {
            setArmed(false);
            onConfirmExit();
          }}
        >
          Confirm exit
        </button>
      ) : null}
      <button
        type="button"
        className="workbench-exit-hold"
        aria-label={armed ? 'Exit armed — click Confirm exit' : 'Hold to arm Workbench exit'}
        title="Hold to arm exit, then Confirm"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          if (!event.repeat) startHold();
        }}
        onKeyUp={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          onPointerUp();
        }}
        onBlur={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span
          className="workbench-exit-hold-fill"
          style={{ transform: `scaleX(${progress})` }}
          aria-hidden="true"
        />
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

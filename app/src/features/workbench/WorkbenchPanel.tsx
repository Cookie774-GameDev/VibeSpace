import * as React from 'react';
import { Copy, GripHorizontal, Minus, X } from 'lucide-react';
import { BrowserPanel } from './BrowserPanel';
import { ReferencePanel } from './ReferencePanel';
import { TerminalPanel } from './TerminalPanel';
import { detachNativeAppSurface } from './nativeApps';
import type { WorkbenchPanel as WorkbenchPanelModel } from './types';

interface WorkbenchPanelProps {
  panel: WorkbenchPanelModel;
  selected: boolean;
  zoom: number;
  onSelect: (additive: boolean) => void;
  onBringToFront: () => void;
  onUpdate: (patch: Partial<WorkbenchPanelModel>) => void;
  onRuntimeUpdate: (patch: Partial<WorkbenchPanelModel>) => void;
  onDuplicate: () => void;
  onClose: () => void;
}

function WorkbenchPanelComponent({
  panel,
  selected,
  zoom,
  onSelect,
  onBringToFront,
  onUpdate,
  onRuntimeUpdate,
  onDuplicate,
  onClose,
}: WorkbenchPanelProps) {
  const [closing, setClosing] = React.useState(false);
  const [closeError, setCloseError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
  });
  const onUpdateRef = React.useRef(onUpdate);
  const onRuntimeUpdateRef = React.useRef(onRuntimeUpdate);
  onUpdateRef.current = onUpdate;
  onRuntimeUpdateRef.current = onRuntimeUpdate;

  // Stable identities so child panels (Files/Jarvis/Editor) never re-subscribe
  // effects solely because the canvas re-rendered with new inline lambdas.
  const update = React.useCallback((patch: Partial<WorkbenchPanelModel>) => {
    onUpdateRef.current(patch);
  }, []);
  const updateRuntime = React.useCallback((patch: Partial<WorkbenchPanelModel>) => {
    onRuntimeUpdateRef.current(patch);
  }, []);

  React.useEffect(() => {
    setDraft({ x: panel.x, y: panel.y, width: panel.width, height: panel.height });
  }, [panel.height, panel.width, panel.x, panel.y]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button,input,textarea')) return;
    event.preventDefault();
    onSelect(event.shiftKey);
    onBringToFront();
    const start = { clientX: event.clientX, clientY: event.clientY, x: draft.x, y: draft.y };
    const move = (moveEvent: PointerEvent) => {
      setDraft((current) => ({
        ...current,
        x: Math.round(start.x + (moveEvent.clientX - start.clientX) / zoom),
        y: Math.round(start.y + (moveEvent.clientY - start.clientY) / zoom),
      }));
    };
    const up = (upEvent: PointerEvent) => {
      const x = Math.round(start.x + (upEvent.clientX - start.clientX) / zoom);
      const y = Math.round(start.y + (upEvent.clientY - start.clientY) / zoom);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onUpdate({ x, y });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const closePanel = async () => {
    if (closing) return;
    if (panel.kind !== 'native-app' && panel.kind !== 'ade') {
      onClose();
      return;
    }
    setClosing(true);
    setCloseError(null);
    try {
      await detachNativeAppSurface(panel.id);
      onClose();
    } catch (cause) {
      setCloseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClosing(false);
    }
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      width: draft.width,
      height: draft.height,
    };
    const move = (moveEvent: PointerEvent) => {
      setDraft((current) => ({
        ...current,
        width: Math.max(240, Math.round(start.width + (moveEvent.clientX - start.clientX) / zoom)),
        height: Math.max(
          160,
          Math.round(start.height + (moveEvent.clientY - start.clientY) / zoom),
        ),
      }));
    };
    const up = (upEvent: PointerEvent) => {
      const width = Math.max(
        240,
        Math.round(start.width + (upEvent.clientX - start.clientX) / zoom),
      );
      const height = Math.max(
        160,
        Math.round(start.height + (upEvent.clientY - start.clientY) / zoom),
      );
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onUpdate({ width, height });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <section
      className="workbench-panel"
      data-kind={panel.kind}
      data-panel-id={panel.id}
      data-selected={selected ? 'true' : 'false'}
      data-minimized={panel.minimized ? 'true' : 'false'}
      aria-label={`${panel.title} panel`}
      style={{
        left: draft.x,
        top: draft.y,
        width: draft.width,
        height: panel.minimized ? 42 : draft.height,
        zIndex: panel.z,
      }}
      onPointerDown={(event) => {
        onSelect(event.shiftKey);
        onBringToFront();
      }}
    >
      <header className="workbench-panel-header" onPointerDown={beginDrag}>
        <span
          className={`workbench-panel-status workbench-panel-status--${panel.status}`}
          role="status"
        >
          <span className="sr-only">Status: {panel.status}</span>
        </span>
        <GripHorizontal aria-hidden="true" />
        <strong>{panel.title}</strong>
        <span className="workbench-panel-kind">{panel.kind}</span>
        <button type="button" aria-label={`Duplicate ${panel.title}`} onClick={onDuplicate}>
          <Copy />
        </button>
        <button
          type="button"
          aria-label={`${panel.minimized ? 'Restore' : 'Minimize'} ${panel.title}`}
          onClick={() => onUpdate({ minimized: !panel.minimized })}
        >
          <Minus />
        </button>
        <button
          type="button"
          aria-label={`Close ${panel.title}`}
          disabled={closing}
          onClick={() => void closePanel()}
        >
          <X />
        </button>
      </header>
      {closeError ? <p role="alert">{closeError}</p> : null}
      <div
        className="workbench-panel-body"
        aria-hidden={panel.minimized}
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {panel.kind === 'terminal' ? (
          <TerminalPanel panel={panel} onUpdate={updateRuntime} />
        ) : panel.kind === 'browser' ? (
          <BrowserPanel panel={panel} onUpdate={update} />
        ) : (
          <ReferencePanel panel={panel} onUpdate={updateRuntime} />
        )}
      </div>
      <button
        type="button"
        className="workbench-panel-resize"
        aria-label={`Resize ${panel.title}`}
        title="Resize with arrow keys; hold Shift for one-pixel steps"
        onPointerDown={beginResize}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const step = event.shiftKey ? 1 : 10;
          const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
          const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
          if (!dx && !dy) return;
          event.preventDefault();
          event.stopPropagation();
          onBringToFront();
          onUpdate({
            width: Math.max(240, draft.width + dx),
            height: Math.max(160, draft.height + dy),
          });
        }}
      />
    </section>
  );
}

function workbenchPanelPropsEqual(
  previous: WorkbenchPanelProps,
  next: WorkbenchPanelProps,
): boolean {
  // Native browser surfaces reconcile their OS-level bounds after each canvas
  // layout commit, including translation-only camera movement.
  if (
    previous.panel.kind === 'browser' ||
    next.panel.kind === 'browser' ||
    previous.panel.kind === 'native-app' ||
    next.panel.kind === 'native-app' ||
    previous.panel.kind === 'ade' ||
    next.panel.kind === 'ade'
  )
    return false;
  return (
    previous.panel === next.panel &&
    previous.selected === next.selected &&
    previous.zoom === next.zoom &&
    previous.onSelect === next.onSelect &&
    previous.onBringToFront === next.onBringToFront &&
    previous.onUpdate === next.onUpdate &&
    previous.onRuntimeUpdate === next.onRuntimeUpdate &&
    previous.onDuplicate === next.onDuplicate &&
    previous.onClose === next.onClose
  );
}

export const WorkbenchPanel = React.memo(WorkbenchPanelComponent, workbenchPanelPropsEqual);
WorkbenchPanel.displayName = 'WorkbenchPanel';

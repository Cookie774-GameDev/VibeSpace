import * as React from 'react';
import { useWorkbenchStore } from './store';
import { WORKBENCH_PANEL_KINDS, type WorkbenchPanelKind } from './types';
import { WORKBENCH_DRAG_MIME } from './PanelPalette';
import { WorkbenchPanel } from './WorkbenchPanel';
import {
  buildMinimapModel,
  panCameraToWorldPoint,
  worldPointFromMinimapClick,
} from './workbenchMinimap';

const kindSet = new Set<string>(WORKBENCH_PANEL_KINDS);

export function WorkbenchCanvas() {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const panels = useWorkbenchStore((state) => state.panels);
  const view = useWorkbenchStore((state) => state.view);
  const canvasSize = useWorkbenchStore((state) => state.canvasSize);
  const selectedIds = useWorkbenchStore((state) => state.selectedIds);
  const addPanel = useWorkbenchStore((state) => state.addPanel);
  const updatePanel = useWorkbenchStore((state) => state.updatePanel);
  const removePanel = useWorkbenchStore((state) => state.removePanel);
  const duplicatePanel = useWorkbenchStore((state) => state.duplicatePanel);
  const selectPanel = useWorkbenchStore((state) => state.selectPanel);
  const clearSelection = useWorkbenchStore((state) => state.clearSelection);
  const bringToFront = useWorkbenchStore((state) => state.bringToFront);
  const setView = useWorkbenchStore((state) => state.setView);
  const setCanvasSize = useWorkbenchStore((state) => state.setCanvasSize);
  const fitView = useWorkbenchStore((state) => state.fitView);
  const undo = useWorkbenchStore((state) => state.undo);
  const redo = useWorkbenchStore((state) => state.redo);
  const minimapRef = React.useRef<HTMLDivElement>(null);

  const minimap = React.useMemo(
    () =>
      buildMinimapModel(
        panels.map((p) => ({
          id: p.id,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          minimized: p.minimized,
        })),
        view,
        {
          width: canvasSize.width || 1000,
          height: canvasSize.height || 700,
        },
      ),
    [panels, view, canvasSize.width, canvasSize.height],
  );

  const panMinimapToClient = React.useCallback(
    (clientX: number, clientY: number) => {
      const el = minimapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fractionX = (clientX - rect.left) / rect.width;
      const fractionY = (clientY - rect.top) / rect.height;
      const world = worldPointFromMinimapClick(fractionX, fractionY, minimap.bounds);
      const next = panCameraToWorldPoint(world.x, world.y, view, {
        width: canvasSize.width || rect.width,
        height: canvasSize.height || 700,
      });
      setView(next);
    },
    [minimap.bounds, view, canvasSize.width, canvasSize.height, setView],
  );
  const panning = React.useRef<null | { clientX: number; clientY: number; x: number; y: number }>(
    null,
  );
  const monochromeRaster =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'monochrome';

  // Keep store mutators in refs so per-panel handlers stay identity-stable
  // across canvas re-renders (prevents Files/Jarvis effect thrash).
  const updatePanelRef = React.useRef(updatePanel);
  const removePanelRef = React.useRef(removePanel);
  const duplicatePanelRef = React.useRef(duplicatePanel);
  const selectPanelRef = React.useRef(selectPanel);
  const bringToFrontRef = React.useRef(bringToFront);
  updatePanelRef.current = updatePanel;
  removePanelRef.current = removePanel;
  duplicatePanelRef.current = duplicatePanel;
  selectPanelRef.current = selectPanel;
  bringToFrontRef.current = bringToFront;

  const handlersById = React.useRef(
    new Map<
      string,
      {
        onSelect: (additive: boolean) => void;
        onBringToFront: () => void;
        onUpdate: (patch: Parameters<typeof updatePanel>[1]) => void;
        onRuntimeUpdate: (patch: Parameters<typeof updatePanel>[1]) => void;
        onDuplicate: () => void;
        onClose: () => void;
      }
    >(),
  );

  const getHandlers = React.useCallback((id: string) => {
    let handlers = handlersById.current.get(id);
    if (!handlers) {
      handlers = {
        onSelect: (additive: boolean) => selectPanelRef.current(id, additive),
        onBringToFront: () => bringToFrontRef.current(id),
        onUpdate: (patch) => updatePanelRef.current(id, patch),
        onRuntimeUpdate: (patch) => updatePanelRef.current(id, patch, { recordHistory: false }),
        onDuplicate: () => duplicatePanelRef.current(id),
        onClose: () => removePanelRef.current(id),
      };
      handlersById.current.set(id, handlers);
    }
    return handlers;
  }, []);

  React.useEffect(() => {
    const live = new Set(panels.map((panel) => panel.id));
    for (const id of handlersById.current.keys()) {
      if (!live.has(id)) handlersById.current.delete(id);
    }
  }, [panels]);

  // Keep store canvas size in sync so the home/recenter button can fit without
  // rearranging nodes.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const publish = () => {
      setCanvasSize({ width: root.clientWidth, height: root.clientHeight });
    };
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => publish()) : null;
    ro?.observe(root);
    window.addEventListener('resize', publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [setCanvasSize]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setView({ zoom: view.zoom + 0.1 });
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      setView({ zoom: view.zoom - 0.1 });
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      fitView();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      selectedIds.forEach(removePanel);
      return;
    }
    const direction =
      event.key === 'ArrowLeft'
        ? { x: -1, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: 1, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -1 }
            : event.key === 'ArrowDown'
              ? { x: 0, y: 1 }
              : null;
    if (direction && selectedIds.length) {
      event.preventDefault();
      const distance = event.shiftKey ? 20 : 4;
      for (const id of selectedIds) {
        const panel = panels.find((entry) => entry.id === id);
        if (panel)
          updatePanel(id, {
            x: panel.x + direction.x * distance,
            y: panel.y + direction.y * distance,
          });
      }
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.workbench-panel')) return;
    clearSelection();
    if (event.button !== 0 && event.button !== 1) return;
    panning.current = { clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y };
    const move = (moveEvent: PointerEvent) => {
      const start = panning.current;
      if (!start) return;
      setView({
        x: start.x + moveEvent.clientX - start.clientX,
        y: start.y + moveEvent.clientY - start.clientY,
      });
    };
    const up = () => {
      panning.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div
      ref={rootRef}
      className="workbench-canvas"
      data-testid="workbench-canvas"
      tabIndex={0}
      role="application"
      aria-label="Spatial Workbench canvas"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onWheel={(event) => {
        // Never pan/zoom the canvas when the user is scrolling inside a panel
        // (Jarvis chat history, files tree, embedded pages, etc.).
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(
            '.workbench-panel-body, .workbench-panel-header input, .workbench-panel-header textarea, .workbench-panel-header select',
          )
        ) {
          return;
        }
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          setView({ zoom: view.zoom - event.deltaY * 0.0012 });
        } else {
          setView({ x: view.x - event.deltaX, y: view.y - event.deltaY });
        }
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(WORKBENCH_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData(WORKBENCH_DRAG_MIME);
        if (!raw) return;
        event.preventDefault();
        try {
          const payload = JSON.parse(raw) as { version?: unknown; kind?: unknown };
          if (
            payload.version !== 1 ||
            typeof payload.kind !== 'string' ||
            !kindSet.has(payload.kind)
          )
            return;
          const rect = rootRef.current?.getBoundingClientRect();
          if (!rect) return;
          addPanel(payload.kind as WorkbenchPanelKind, {
            x: Math.round((event.clientX - rect.left - view.x) / view.zoom),
            y: Math.round((event.clientY - rect.top - view.y) / view.zoom),
          });
        } catch {
          // Typed drag data is ignored if malformed. It is never executed.
        }
      }}
    >
      <div
        className="workbench-grid"
        aria-hidden="true"
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${32 * view.zoom}px ${32 * view.zoom}px`,
        }}
      />
      <div
        className="workbench-stage [html[data-theme=monochrome]_&]:will-change-auto"
        style={{
          transform: monochromeRaster
            ? `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`
            : `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
        }}
      >
        {panels.map((panel) => {
          const handlers = getHandlers(panel.id);
          return (
            <WorkbenchPanel
              key={panel.id}
              panel={panel}
              selected={selectedIds.includes(panel.id)}
              zoom={view.zoom}
              onSelect={handlers.onSelect}
              onBringToFront={handlers.onBringToFront}
              onUpdate={handlers.onUpdate}
              onRuntimeUpdate={handlers.onRuntimeUpdate}
              onDuplicate={handlers.onDuplicate}
              onClose={handlers.onClose}
            />
          );
        })}
      </div>
      {/* Interactive minimap: click to jump camera, double-click to fit all work.
          Camera-only — never moves or spawns panels. */}
      <div
        ref={minimapRef}
        className="workbench-minimap"
        role="region"
        aria-label="Workbench minimap"
        data-testid="workbench-minimap"
        title="Click to jump · Double-click to show all work (same as Recenter)"
        onPointerDown={(event) => {
          // Don't start canvas pan when using the minimap.
          event.stopPropagation();
          if (event.button !== 0) return;
          panMinimapToClient(event.clientX, event.clientY);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // Recenter camera on all panels — work stays exactly where you left it.
          fitView();
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="workbench-minimap-stage">
          {minimap.placements.map((item) => (
            <button
              key={item.id}
              type="button"
              className="workbench-minimap-panel"
              style={item.style}
              aria-label={`Focus panel from minimap`}
              title="Jump to this panel"
              onClick={(event) => {
                event.stopPropagation();
                const panel = panels.find((p) => p.id === item.id);
                if (!panel) return;
                const next = panCameraToWorldPoint(
                  panel.x + panel.width / 2,
                  panel.y + (panel.minimized ? 21 : panel.height / 2),
                  view,
                  {
                    width: canvasSize.width || 1000,
                    height: canvasSize.height || 700,
                  },
                );
                setView(next);
                selectPanel(item.id, false);
                bringToFront(item.id);
              }}
            />
          ))}
          <div
            className="workbench-minimap-viewport"
            aria-hidden
            style={minimap.viewportStyle}
          />
        </div>
        <button
          type="button"
          className="workbench-minimap-home"
          aria-label="Show all work"
          title="Show all work — recenters the camera only"
          onClick={(event) => {
            event.stopPropagation();
            fitView();
          }}
        >
          All
        </button>
      </div>
      <div className="workbench-canvas-readout" aria-live="polite">
        {Math.round(view.zoom * 100)}% · {panels.length} panels
      </div>
    </div>
  );
}

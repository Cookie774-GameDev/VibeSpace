import * as React from 'react';
import { Copy, Trash2, RotateCw, ArrowDownToLine, Move } from 'lucide-react';
import type { WorkbenchPanel } from './types';
import { creativeStyle, type CreativeStyle } from './creative';
import { useWorkbenchStore } from './store';
import './creative.css';
import './creative-interaction.css';

interface Props {
  panel: WorkbenchPanel;
  selected: boolean;
  zoom: number;
  onSelect: (additive: boolean) => void;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
  onDuplicate: () => void;
  onClose: () => void;
}
export function CreativeItem({
  panel,
  selected,
  zoom,
  onSelect,
  onUpdate,
  onDuplicate,
  onClose,
}: Props) {
  const style = creativeStyle(panel.settings.creative);
  const [draft, setDraft] = React.useState({
    x: panel.x,
    y: panel.y,
    width: panel.width,
    height: panel.height,
  });
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(panel.settings.note ?? '');
  const [drawing, setDrawing] = React.useState<number[][] | null>(null);
  const gesture = React.useRef<{
    x: number;
    y: number;
    mode: 'move' | 'resize' | 'rotate';
    start: typeof draft;
  } | null>(null);
  React.useEffect(
    () => setDraft({ x: panel.x, y: panel.y, width: panel.width, height: panel.height }),
    [panel.x, panel.y, panel.width, panel.height],
  );
  React.useEffect(() => setText(panel.settings.note ?? ''), [panel.settings.note]);
  const change = (patch: Partial<CreativeStyle>) =>
    onUpdate({ settings: { creative: creativeStyle({ ...style, ...patch }) } });
  const [rot, setRot] = React.useState<number | null>(null);
  const rotState = React.useRef<{ cx: number; cy: number; start: number; startAngle: number } | null>(null);
  const beginRotate = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(e.shiftKey);
    const el = (e.currentTarget as HTMLElement).closest('.wb-creative-item');
    const r = el ? el.getBoundingClientRect() : null;
    const cx = r ? r.left + r.width / 2 : e.clientX;
    const cy = r ? r.top + r.height / 2 : e.clientY;
    const startAngle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
    rotState.current = { cx, cy, start: style.rotate, startAngle };
    setRot(style.rotate);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const rotateProps = {
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const s = rotState.current;
      if (!s) return;
      // Angle of pointer relative to item centre; +90 so the handle (top) reads 0 deg.
      const ang = (Math.atan2(e.clientY - s.cy, e.clientX - s.cx) * 180) / Math.PI + 90;
      const base = (Math.atan2(s.cy - s.cy, 1) * 180) / Math.PI; // 0 reference (unused, kept for clarity)
      void base;
      let deg = Math.round(s.start + ang - s.startAngle);
      deg = ((deg % 360) + 360) % 360;
      setRot(deg);
    },
    onPointerUp: () => {
      if (rotState.current && rot !== null) change({ rotate: rot });
      rotState.current = null;
      setRot(null);
    },
    onPointerCancel: () => {
      rotState.current = null;
      setRot(null);
    },
  };
  const begin = (e: React.PointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect(e.shiftKey);
    gesture.current = { x: e.clientX, y: e.clientY, mode, start: draft };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const next = (e: React.PointerEvent) => {
    const g = gesture.current!;
    const dx = (e.clientX - g.x) / zoom,
      dy = (e.clientY - g.y) / zoom;
    return g.mode === 'move'
      ? { ...g.start, x: Math.round(g.start.x + dx), y: Math.round(g.start.y + dy) }
      : {
          ...g.start,
          width: Math.max(40, Math.min(2000, g.start.width + dx)),
          height: Math.max(40, Math.min(1400, g.start.height + dy)),
        };
  };
  const gestureProps = {
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (gesture.current) setDraft(next(e));
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (gesture.current) {
        onUpdate(next(e));
        gesture.current = null;
      }
    },
    onPointerCancel: () => {
      gesture.current = null;
      setDraft({ x: panel.x, y: panel.y, width: panel.width, height: panel.height });
    },
  };
  const isText = style.kind === 'text' || style.kind === 'title';
  const points = drawing ?? style.points;
  const strokeProps = {
    stroke: style.color,
    strokeWidth: style.stroke,
    fill: style.fill,
    strokeDasharray: style.dash === 'dashed' ? '10 7' : style.dash === 'dotted' ? '2 6' : undefined,
    vectorEffect: 'non-scaling-stroke' as const,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  };
  const point = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1000, ((e.clientX - r.left) / r.width) * 1000)),
      Math.max(0, Math.min(1000, ((e.clientY - r.top) / r.height) * 1000)),
    ];
  };
  return (
    <section
      className="workbench-panel wb-creative-item"
      data-kind="creative"
      data-creative-kind={style.kind}
      data-panel-id={panel.id}
      data-selected={selected}
      aria-label={`Creative ${style.kind}`}
      style={{
        left: draft.x,
        top: draft.y,
        width: draft.width,
        height: draft.height,
        zIndex: panel.z,
        transform: `rotate(${rot ?? style.rotate}deg)`,
        transformOrigin: '50% 50%',
      }}
    >
      <div
        className="wb-creative-art"
        style={{ opacity: style.opacity }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(e.shiftKey);
        }}
        onDoubleClick={() => {
          if (isText) setEditing(true);
        }}
      >
        {isText ? (
          editing ? (
            <textarea
              autoFocus
              aria-label="Creative text"
              value={text}
              maxLength={20000}
              style={{ color: style.color, fontSize: style.fontSize }}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                onUpdate({ settings: { note: text } });
                setEditing(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') {
                  setText(panel.settings.note ?? '');
                  setEditing(false);
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          ) : (
            <div
              className="wb-creative-text"
              style={{
                color: style.color,
                fontSize: style.fontSize,
                fontWeight: style.kind === 'title' ? 700 : 400,
                fontFamily:
                  style.font === 'serif'
                    ? 'Georgia, serif'
                    : style.font === 'hand'
                      ? '"Segoe Print", cursive'
                      : 'inherit',
              }}
              onPointerDown={(e) => begin(e, 'move')}
              {...gestureProps}
            >
              {text || 'Double-click to write'}
            </div>
          )
        ) : (
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            className={style.kind === 'draw' ? 'wb-creative-draw' : ''}
            onPointerDown={(e) => {
              if (style.kind !== 'draw' || !selected) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrawing([point(e)]);
            }}
            onPointerMove={(e) => {
              if (drawing && drawing.length < 2000) setDrawing([...drawing, point(e)]);
            }}
            onPointerUp={(e) => {
              if (drawing) {
                change({ points: [...drawing, point(e)].slice(0, 2000) });
                setDrawing(null);
              }
            }}
            onPointerCancel={() => setDrawing(null)}
          >
            {style.kind === 'ellipse' ? (
              <ellipse cx="500" cy="500" rx="490" ry="490" {...strokeProps} />
            ) : style.kind === 'diamond' ? (
              <polygon points="500,10 990,500 500,990 10,500" {...strokeProps} />
            ) : style.kind === 'line' || style.kind === 'arrow' ? (
              <path
                d={
                  style.kind === 'arrow'
                    ? 'M10 500 H980 M840 360 L980 500 L840 640'
                    : 'M10 500 H990'
                }
                {...strokeProps}
                fill="none"
              />
            ) : style.kind === 'draw' ? (
              <polyline
                points={points.map((p) => p.join(',')).join(' ')}
                {...strokeProps}
                fill="none"
              />
            ) : (
              <rect
                x="5"
                y="5"
                width="990"
                height="990"
                rx={style.kind === 'frame' ? 8 : 35}
                {...strokeProps}
              />
            )}
          </svg>
        )}
      </div>
      <button
        className="wb-creative-grip"
        aria-label="Select and move creative item"
        title="Select / drag to move"
        style={{ '--grip-width': `${12 / zoom}px` } as React.CSSProperties}
        onPointerDown={(e) => begin(e, 'move')}
        {...gestureProps}
        onClick={(e) => { if (e.detail === 0) onSelect(e.shiftKey); }}
      >
      </button>
      {selected && (
        <>
          <div
            className="wb-creative-frame"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <button
              className="wb-creative-rotate"
              aria-label="Rotate creative item"
              title="Drag to rotate"
              onPointerDown={beginRotate}
              {...rotateProps}
            >
              <RotateCw size={13} />
            </button>
            <div className="wb-creative-swatches" role="group" aria-label="Creative color">
              {['#e8c99b', '#e8855b', '#8fb87e', '#7fb3d5', '#c39bd3', '#f2f2f2', '#1a1a1a'].map(
                (c) => (
                  <button
                    key={c}
                    type="button"
                    className="wb-creative-swatch"
                    data-active={style.color === c}
                    style={{ background: c }}
                    aria-label={`Set color ${c}`}
                    onClick={() => change({ color: c })}
                  />
                ),
              )}
              <input
                type="color"
                className="wb-creative-picker"
                aria-label="Creative custom color"
                value={style.color}
                onChange={(e) => change({ color: e.target.value })}
              />
            </div>
            <div className="wb-creative-actions">
              <button
                className="wb-creative-move"
                aria-label="Move creative item"
                title="Drag to move · Arrow keys to nudge"
                onPointerDown={(e) => begin(e, 'move')}
                {...gestureProps}
                onKeyDown={(e) => {
                  const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                  const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
                  if (!dx && !dy) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const step = e.shiftKey ? 10 : 1;
                  onUpdate({ x: panel.x + dx * step, y: panel.y + dy * step });
                }}
              >
                <Move size={13} />
              </button>
              <button aria-label="Duplicate creative item" title="Duplicate" onClick={onDuplicate}>
                <Copy size={13} />
              </button>
              <button
                aria-label="Send creative item to back"
                title="Send to back"
                onClick={() =>
                  onUpdate({
                    z: Math.min(0, ...useWorkbenchStore.getState().panels.map((p) => p.z)) - 1,
                  })
                }
              >
                <ArrowDownToLine size={13} />
              </button>
              <button aria-label="Delete creative item" title="Delete" onClick={onClose}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          <button
            className="wb-creative-resize"
            aria-label="Resize creative item"
            onPointerDown={(e) => begin(e, 'resize')}
            {...gestureProps}
            onKeyDown={(e) => {
              const dx = e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : 0,
                dy = e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0;
              if (dx || dy) {
                e.preventDefault();
                e.stopPropagation();
                onUpdate({
                  width: Math.max(40, Math.min(2000, panel.width + dx)),
                  height: Math.max(40, Math.min(1400, panel.height + dy)),
                });
              }
            }}
          />
        </>
      )}
    </section>
  );
}

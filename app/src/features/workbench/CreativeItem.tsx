import * as React from 'react';
import { Copy, Trash2, Grip, ArrowDownToLine } from 'lucide-react';
import type { WorkbenchPanel } from './types';
import { creativeStyle, type CreativeStyle } from './creative';
import { useWorkbenchStore } from './store';
import './creative.css';

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
    mode: 'move' | 'resize';
    start: typeof draft;
  } | null>(null);
  React.useEffect(
    () => setDraft({ x: panel.x, y: panel.y, width: panel.width, height: panel.height }),
    [panel.x, panel.y, panel.width, panel.height],
  );
  React.useEffect(() => setText(panel.settings.note ?? ''), [panel.settings.note]);
  const change = (patch: Partial<CreativeStyle>) =>
    onUpdate({ settings: { creative: creativeStyle({ ...style, ...patch }) } });
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
      {selected && (
        <>
          <div
            className="wb-creative-controls"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="wb-creative-control-head">
              <button
                aria-label="Move creative item"
                title="Drag to move"
                onPointerDown={(e) => begin(e, 'move')}
                {...gestureProps}
              >
                <Grip size={16} />
              </button>
              <strong>{style.kind === 'draw' ? 'Freehand · drag to draw' : style.kind}</strong>
              <button aria-label="Duplicate creative item" onClick={onDuplicate}>
                <Copy size={15} />
              </button>
              <button
                aria-label="Send creative item to back"
                onClick={() =>
                  onUpdate({
                    z: Math.min(0, ...useWorkbenchStore.getState().panels.map((p) => p.z)) - 1,
                  })
                }
              >
                <ArrowDownToLine size={15} />
              </button>
              <button aria-label="Delete creative item" onClick={onClose}>
                <Trash2 size={15} />
              </button>
            </div>
            <div className="wb-creative-style-row">
              <label>
                Color
                <input
                  type="color"
                  aria-label="Creative color"
                  value={style.color}
                  onChange={(e) => change({ color: e.target.value })}
                />
              </label>
              {!isText && (
                <>
                  <label>
                    Fill
                    <input
                      type="color"
                      aria-label="Creative fill"
                      value={style.fill === 'none' ? '#e8c99b' : style.fill}
                      onChange={(e) => change({ fill: e.target.value })}
                    />
                  </label>
                  <button onClick={() => change({ fill: 'none' })}>No fill</button>
                  <label>
                    Stroke
                    <input
                      type="number"
                      aria-label="Creative stroke"
                      min={1}
                      max={12}
                      value={style.stroke}
                      onChange={(e) => change({ stroke: Number(e.target.value) })}
                    />
                  </label>
                  <select
                    aria-label="Creative line style"
                    value={style.dash}
                    onChange={(e) => change({ dash: e.target.value as CreativeStyle['dash'] })}
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </>
              )}
              {isText && (
                <>
                  <button onClick={() => setEditing(true)}>Edit text</button>
                  <label>
                    Size
                    <input
                      type="number"
                      aria-label="Creative font size"
                      min={12}
                      max={160}
                      value={style.fontSize}
                      onChange={(e) => change({ fontSize: Number(e.target.value) })}
                    />
                  </label>
                  <select
                    aria-label="Creative font"
                    value={style.font}
                    onChange={(e) => change({ font: e.target.value as CreativeStyle['font'] })}
                  >
                    <option value="sans">Sans</option>
                    <option value="serif">Serif</option>
                    <option value="hand">Handwritten</option>
                  </select>
                </>
              )}
              <label>
                Opacity
                <input
                  type="range"
                  aria-label="Creative opacity"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={style.opacity}
                  onChange={(e) => change({ opacity: Number(e.target.value) })}
                />
              </label>
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

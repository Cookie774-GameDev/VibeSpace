import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Circle,
  Eraser,
  Expand,
  Minimize2,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Redo2,
  Square,
  Triangle,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import {
  MAX_SKETCH_ITEMS,
  SKETCH_HEIGHT,
  SKETCH_WIDTH,
  moveSketchItem,
  readSketchDraft,
  resizeSketchItem,
  sketchBounds,
  sketchPath,
  sketchSvg,
  writeSketchDraft,
  type SketchBounds,
  type SketchItem,
  type SketchPoint,
  type SketchShape,
} from './sketchModel';
import './SketchPanel.css';

type Tool = 'select' | 'brush' | 'text' | 'shape' | 'eraser';
type History = { past: SketchItem[][]; present: SketchItem[]; future: SketchItem[][] };
type Gesture = {
  kind: 'draw' | 'move' | 'resize';
  start: SketchPoint;
  original: SketchItem;
  corner?: string;
};
type TextEdit = SketchPoint & { value: string };

const COLORS = [
  '#fffaf2',
  '#19242d',
  '#7d8995',
  '#a34c2c',
  '#e33f46',
  '#f38132',
  '#efa91f',
  '#31a56a',
  '#169d9c',
  '#247bc7',
  '#5b50cf',
  '#9b3de0',
  '#dc3185',
];
const SHAPES: { id: SketchShape; label: string; Icon: typeof Square }[] = [
  { id: 'line', label: 'Line', Icon: Minus },
  { id: 'rectangle', label: 'Rectangle', Icon: Square },
  { id: 'ellipse', label: 'Ellipse', Icon: Circle },
  { id: 'triangle', label: 'Triangle', Icon: Triangle },
  { id: 'arrow', label: 'Arrow', Icon: MoveUpRight },
];
const blankHistory = (present: SketchItem[] = []): History => ({ past: [], present, future: [] });
const uid = () =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `sketch-${Date.now()}-${Math.random()}`;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function renderSketchItem(item: SketchItem) {
  const stroke = {
    fill: 'none',
    stroke: item.color,
    strokeWidth: item.size,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (item.kind === 'stroke') return <path d={sketchPath(item.points)} {...stroke} />;
  if (item.kind === 'text')
    return (
      <text
        x={item.x}
        y={item.y}
        fill={item.color}
        fontSize={item.size}
        fontFamily="Georgia, serif"
        fontWeight="600"
      >
        {item.text}
      </text>
    );
  const { x, y, width, height } = sketchBounds(item);
  switch (item.shape) {
    case 'line':
      return <path d={`M ${x} ${y} L ${x + width} ${y + height}`} {...stroke} />;
    case 'rectangle':
      return <rect x={x} y={y} width={width} height={height} rx={3} {...stroke} />;
    case 'ellipse':
      return (
        <ellipse
          cx={x + width / 2}
          cy={y + height / 2}
          rx={width / 2}
          ry={height / 2}
          {...stroke}
        />
      );
    case 'triangle':
      return (
        <path
          d={`M ${x + width / 2} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`}
          {...stroke}
        />
      );
    case 'arrow':
      return (
        <path
          d={`M ${x} ${y + height} L ${x + width} ${y} M ${x + width} ${y} L ${x + width * 0.56} ${y + height * 0.1} M ${x + width} ${y} L ${x + width * 0.88} ${y + height * 0.45}`}
          {...stroke}
        />
      );
  }
}

function toPng(items: SketchItem[], background: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () =>
      reject(new Error('Could not render this sketch. Your draft is still here.'));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SKETCH_WIDTH;
      canvas.height = SKETCH_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context)
        return reject(new Error('Image export is unavailable. Your draft is still here.'));
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob)
          return reject(new Error('Could not save this sketch. Your draft is still here.'));
        resolve(
          new File(
            [blob],
            `sketch-${new Date().toISOString().replace(/[:.]/g, '-')}-${uid().slice(0, 8)}.png`,
            { type: 'image/png' },
          ),
        );
      }, 'image/png');
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sketchSvg(items, background))}`;
  });
}

export function SketchPanel({
  scope,
  onClose,
  onSave,
}: {
  scope: string;
  onClose: () => void;
  onSave: (file: File) => Promise<void>;
}) {
  const [history, setHistory] = useState<History>(() => blankHistory(readSketchDraft(scope)));
  const [tool, setTool] = useState<Tool>('brush');
  const [shape, setShape] = useState<SketchShape>('triangle');
  const [color, setColor] = useState('#19242d');
  const [size, setSize] = useState(7);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SketchItem | null>(null);
  const previewRef = useRef<SketchItem | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const updatePreview = (item: SketchItem | null) => {
    previewRef.current = item;
    setPreview(item);
  };

  useEffect(() => {
    panelRef.current?.focus();
  }, []);
  useEffect(() => {
    if (textEdit) textRef.current?.focus();
  }, [textEdit?.x, textEdit?.y]);

  const persist = (items: SketchItem[]) => setStorageWarning(!writeSketchDraft(scope, items));
  const commit = (items: SketchItem[]) => {
    setHistory((previous) => ({
      past: [...previous.past, previous.present].slice(-60),
      present: items.slice(0, MAX_SKETCH_ITEMS),
      future: [],
    }));
    persist(items);
    setError('');
  };
  const undo = () =>
    setHistory((previous) => {
      const present = previous.past.at(-1);
      if (!present) return previous;
      persist(present);
      setSelectedId(null);
      return {
        past: previous.past.slice(0, -1),
        present,
        future: [previous.present, ...previous.future].slice(0, 60),
      };
    });
  const redo = () =>
    setHistory((previous) => {
      const present = previous.future[0];
      if (!present) return previous;
      persist(present);
      setSelectedId(null);
      return {
        past: [...previous.past, previous.present].slice(-60),
        present,
        future: previous.future.slice(1),
      };
    });
  const point = (event: PointerEvent<SVGSVGElement>): SketchPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - bounds.left) / bounds.width) * SKETCH_WIDTH, 0, SKETCH_WIDTH),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * SKETCH_HEIGHT, 0, SKETCH_HEIGHT),
    };
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || saving || textEdit) return;
    const target = event.target instanceof Element ? event.target : null;
    const itemId = target?.closest('[data-sketch-item]')?.getAttribute('data-sketch-item');
    const handle = target?.getAttribute('data-sketch-handle');
    const at = point(event);
    if (tool === 'eraser') {
      if (itemId) {
        commit(history.present.filter((item) => item.id !== itemId));
        if (selectedId === itemId) setSelectedId(null);
      }
      return;
    }
    if (handle && selectedId) {
      const original = history.present.find((item) => item.id === selectedId);
      if (original) gesture.current = { kind: 'resize', start: at, original, corner: handle };
    } else if (tool === 'select') {
      setSelectedId(itemId ?? null);
      const original = history.present.find((item) => item.id === itemId);
      if (original) gesture.current = { kind: 'move', start: at, original };
    } else if (tool === 'text') {
      event.preventDefault();
      setSelectedId(null);
      setTextEdit({ ...at, value: '' });
    } else {
      if (history.present.length >= MAX_SKETCH_ITEMS) {
        setError('This sketch has reached its object limit. Save it to start another.');
        return;
      }
      const original: SketchItem =
        tool === 'brush'
          ? { id: uid(), kind: 'stroke', points: [at], color, size }
          : { id: uid(), kind: 'shape', shape, x: at.x, y: at.y, width: 0, height: 0, color, size };
      gesture.current = { kind: 'draw', start: at, original };
      updatePreview(original);
      setSelectedId(null);
    }
    if (gesture.current) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    if (!active) return;
    const at = point(event);
    if (active.kind === 'draw') {
      if (active.original.kind === 'stroke') {
        const current =
          previewRef.current?.kind === 'stroke' ? previewRef.current : active.original;
        const last = current.points.at(-1)!;
        if (Math.hypot(at.x - last.x, at.y - last.y) >= 1.5)
          updatePreview({ ...current, points: [...current.points, at].slice(-10_000) });
      } else if (active.original.kind === 'shape') {
        updatePreview({
          ...active.original,
          x: Math.min(active.start.x, at.x),
          y: Math.min(active.start.y, at.y),
          width: Math.abs(at.x - active.start.x),
          height: Math.abs(at.y - active.start.y),
        });
      }
    } else if (active.kind === 'move') {
      updatePreview(moveSketchItem(active.original, at.x - active.start.x, at.y - active.start.y));
    } else {
      const bounds = sketchBounds(active.original);
      const left = active.corner?.includes('w') ? bounds.x + at.x - active.start.x : bounds.x;
      const top = active.corner?.includes('n') ? bounds.y + at.y - active.start.y : bounds.y;
      const right = active.corner?.includes('e')
        ? bounds.x + bounds.width + at.x - active.start.x
        : bounds.x + bounds.width;
      const bottom = active.corner?.includes('s')
        ? bounds.y + bounds.height + at.y - active.start.y
        : bounds.y + bounds.height;
      const next: SketchBounds = {
        x: Math.min(left, right - 8),
        y: Math.min(top, bottom - 8),
        width: Math.max(8, right - left),
        height: Math.max(8, bottom - top),
      };
      updatePreview(resizeSketchItem(active.original, next));
    }
  };
  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const item = previewRef.current ?? active.original;
    updatePreview(null);
    if (active.kind === 'draw') {
      if (item.kind === 'shape' && Math.max(item.width, item.height) < 6) return;
      commit([...history.present, item]);
      if (item.kind === 'shape') setSelectedId(item.id);
    } else if (JSON.stringify(item) !== JSON.stringify(active.original)) {
      commit(history.present.map((existing) => (existing.id === item.id ? item : existing)));
    }
  };
  const commitText = () => {
    if (!textEdit) return;
    const value = textEdit.value.trim().slice(0, 500);
    if (value)
      commit([
        ...history.present,
        {
          id: uid(),
          kind: 'text',
          x: textEdit.x,
          y: textEdit.y,
          text: value,
          color,
          size: Math.max(18, size * 4),
        },
      ]);
    setTextEdit(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (selectedId && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      commit(history.present.filter((item) => item.id !== selectedId));
      setSelectedId(null);
    } else if (
      selectedId &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault();
      const item = history.present.find((candidate) => candidate.id === selectedId);
      if (item) {
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        commit(
          history.present.map((candidate) =>
            candidate.id === item.id ? moveSketchItem(item, dx, dy) : candidate,
          ),
        );
      }
    }
  };
  const save = async () => {
    if (saving || !history.present.length) return;
    setSaving(true);
    setError('');
    try {
      const background =
        getComputedStyle(panelRef.current!).getPropertyValue('--sketch-paper').trim() || '#fffaf2';
      const file = await toPng(history.present, background);
      await onSave(file);
      writeSketchDraft(scope, []);
      setHistory(blankHistory());
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not attach the sketch. Your draft is still here.',
      );
    } finally {
      setSaving(false);
    }
  };
  const visibleItems = history.present.map((item) => (preview?.id === item.id ? preview : item));
  if (preview && !history.present.some((item) => item.id === preview.id))
    visibleItems.push(preview);
  const selected = visibleItems.find((item) => item.id === selectedId);
  const selection = selected ? sketchBounds(selected) : null;

  return createPortal(
    <div
      className={`sketch-layer ${expanded ? 'sketch-layer--expanded' : ''}`}
      data-sketch-layer="true"
    >
      {expanded && (
        <button
          type="button"
          className="sketch-backdrop"
          aria-label="Collapse sketch"
          onClick={() => setExpanded(false)}
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sketch panel"
        tabIndex={-1}
        className="sketch-panel"
        onKeyDown={onKeyDown}
      >
        <header className="sketch-header">
          <div className="sketch-header-title">
            <span className="sketch-header-mark">✳</span>
            <div>
              <strong>Sketchbook</strong>
              <small>Draw an idea into this chat</small>
            </div>
          </div>
          <div className="sketch-header-actions">
            <span className="sketch-object-count">
              {history.present.length} {history.present.length === 1 ? 'mark' : 'marks'}
            </span>
            <button
              type="button"
              aria-label={expanded ? 'Collapse sketch' : 'Expand sketch'}
              title={expanded ? 'Collapse sketch' : 'Expand sketch'}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <Minimize2 /> : <Expand />}
            </button>
            <button
              type="button"
              aria-label="Close sketch"
              title="Keep draft and close"
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </header>
        <div className="sketch-workspace">
          <div className="sketch-topbar" role="toolbar" aria-label="Sketch tools">
            {(
              [
                ['select', MousePointer2, 'Select'],
                ['brush', PenLine, 'Brush'],
                ['text', Type, 'Text'],
                ['shape', Square, 'Shapes'],
                ['eraser', Eraser, 'Eraser'],
              ] as const
            ).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                aria-label={label}
                aria-pressed={tool === id}
                title={label}
                onClick={() => {
                  setTool(id);
                  setSelectedId(null);
                }}
              >
                <Icon />
              </button>
            ))}
            <span className="sketch-tool-divider" aria-hidden="true" />
            <button
              type="button"
              aria-label="Undo"
              title="Undo · Ctrl+Z"
              disabled={!history.past.length}
              onClick={undo}
            >
              <Undo2 />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title="Redo · Ctrl+Shift+Z"
              disabled={!history.future.length}
              onClick={redo}
            >
              <Redo2 />
            </button>
          </div>
          {tool === 'shape' && (
            <div className="sketch-shapes" role="toolbar" aria-label="Shape choices">
              {SHAPES.map(({ id, label, Icon }) => (
                <button
                  type="button"
                  key={id}
                  aria-label={label}
                  aria-pressed={shape === id}
                  title={label}
                  onClick={() => setShape(id)}
                >
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="sketch-stage">
            <div className="sketch-size" aria-label="Stroke size">
              <span>SIZE</span>
              <input
                type="range"
                min="2"
                max="36"
                value={size}
                aria-label="Stroke size"
                onChange={(event) => setSize(Number(event.target.value))}
              />
              <output>{size}</output>
            </div>
            <div className="sketch-paper-wrap">
              <svg
                ref={svgRef}
                className={`sketch-paper sketch-paper--${tool}`}
                viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
                role="img"
                aria-label="Sketch canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                {visibleItems.map((item) => {
                  const bounds = sketchBounds(item);
                  return (
                    <g key={item.id} data-sketch-item={item.id}>
                      <rect
                        x={bounds.x - 8}
                        y={bounds.y - 8}
                        width={bounds.width + 16}
                        height={bounds.height + 16}
                        fill="transparent"
                        stroke="none"
                      />
                      {renderSketchItem(item)}
                    </g>
                  );
                })}
                {selection && (
                  <g className="sketch-selection" aria-hidden="true">
                    <rect
                      x={selection.x - 7}
                      y={selection.y - 7}
                      width={selection.width + 14}
                      height={selection.height + 14}
                      fill="none"
                      strokeDasharray="7 5"
                    />
                    {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                      <rect
                        key={corner}
                        data-sketch-handle={corner}
                        x={
                          corner.includes('w')
                            ? selection.x - 12
                            : selection.x + selection.width + 2
                        }
                        y={
                          corner.includes('n')
                            ? selection.y - 12
                            : selection.y + selection.height + 2
                        }
                        width="10"
                        height="10"
                        rx="2"
                      />
                    ))}
                  </g>
                )}
              </svg>
              {textEdit && (
                <input
                  ref={textRef}
                  className="sketch-text-input"
                  aria-label="Sketch text"
                  maxLength={500}
                  style={{
                    left: `${(textEdit.x / SKETCH_WIDTH) * 100}%`,
                    top: `${(textEdit.y / SKETCH_HEIGHT) * 100}%`,
                    color,
                  }}
                  value={textEdit.value}
                  onChange={(event) => setTextEdit({ ...textEdit, value: event.target.value })}
                  onBlur={commitText}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitText();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setTextEdit(null);
                    }
                  }}
                  placeholder="Type something…"
                />
              )}
            </div>
          </div>
          <footer className="sketch-footer">
            <div className="sketch-palette" role="group" aria-label="Sketch colors">
              <label className="sketch-custom-color" title="Custom color">
                <span aria-hidden="true">◉</span>
                <input
                  type="color"
                  aria-label="Custom color"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                />
              </label>
              {COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={`Color ${swatch}`}
                  aria-pressed={color.toLowerCase() === swatch}
                  title={swatch}
                  style={{ '--swatch': swatch } as CSSProperties}
                  onClick={() => setColor(swatch)}
                />
              ))}
            </div>
            <button
              type="button"
              className="sketch-save"
              aria-label="Save sketch to chat"
              title="Save as image attachment"
              disabled={saving || !history.present.length}
              onClick={() => void save()}
            >
              <Check />
              <span>{saving ? 'Saving…' : 'Save to chat'}</span>
            </button>
          </footer>
        </div>
        {(error || storageWarning) && (
          <p className="sketch-status" role="status">
            {error || 'Draft storage is unavailable. Keep this panel open until you save.'}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

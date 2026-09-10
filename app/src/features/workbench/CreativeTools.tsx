import * as React from 'react';
import {
  Paintbrush,
  Type,
  Heading1,
  Frame,
  Square,
  Circle,
  Diamond,
  Minus,
  ArrowUpRight,
  Pencil,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { creativeStyle, type CreativeKind } from './creative';
import { useWorkbenchStore } from './store';
import './creative.css';

const tools = [
  ['text', 'Text', Type],
  ['title', 'Title', Heading1],
  ['frame', 'Border / frame', Frame],
  ['rectangle', 'Rectangle', Square],
  ['ellipse', 'Ellipse', Circle],
  ['diamond', 'Diamond', Diamond],
  ['line', 'Line', Minus],
  ['arrow', 'Arrow', ArrowUpRight],
  ['draw', 'Freehand', Pencil],
] as const;

export function CreativeTools() {
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const closeSoon = () => {
    cancel();
    timer.current = setTimeout(() => setAnchor(null), 200);
  };
  const open = () => {
    cancel();
    setAnchor(trigger.current?.getBoundingClientRect() ?? null);
  };
  function add(kind: CreativeKind) {
    const state = useWorkbenchStore.getState();
    state.addPanel(
      'creative',
      {
        x: (state.canvasSize.width / 2 - state.view.x) / state.view.zoom - 180,
        y: (state.canvasSize.height / 2 - state.view.y) / state.view.zoom - 90,
      },
      {
        creative: creativeStyle({ kind }),
        note: kind === 'title' ? 'Your title' : kind === 'text' ? 'Your text' : '',
      },
    );
    setAnchor(null);
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="Creative"
        aria-expanded={!!anchor}
        aria-haspopup="menu"
        onMouseEnter={open}
        onMouseLeave={closeSoon}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setAnchor(null);
        }}
      >
        <Paintbrush aria-hidden="true" />
        <span>Creative</span>
      </button>
      {anchor &&
        createPortal(
          <div
            className="wb-creative-menu"
            role="menu"
            aria-label="Creative tools"
            onMouseEnter={cancel}
            onMouseLeave={closeSoon}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAnchor(null);
                trigger.current?.focus();
              }
            }}
            style={{
              left: Math.min(anchor.right + 10, window.innerWidth - 236),
              top: Math.min(anchor.top, window.innerHeight - 390),
            }}
          >
            <p>CREATIVE STUDIO</p>
            <small>Make space for your ideas</small>
            <div>
              {tools.map(([kind, label, Icon]) => (
                <button key={kind} type="button" role="menuitem" onClick={() => add(kind)}>
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

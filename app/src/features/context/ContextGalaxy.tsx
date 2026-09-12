import * as React from 'react';
import { Box, LocateFixed, Minus, Orbit, Plus, Rows3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  buildGalaxyLayout,
  DEFAULT_GALAXY_CAMERA,
  projectGalaxyPoint,
  reduceGalaxyCamera,
  selectGalaxyLod,
  type GalaxyCamera,
  type GalaxyEdge,
  type GalaxyInputNode,
} from './contextGalaxyLayout';

export interface ContextGalaxyNode extends GalaxyInputNode {
  label: string;
  description: string;
}

export interface ContextGalaxyProps {
  nodes: readonly ContextGalaxyNode[];
  edges: readonly GalaxyEdge[];
  selectedId: string | null;
  activityNodeIds: readonly string[];
  onSelect(id: string): void;
  compact?: boolean;
  reducedMotion?: boolean;
  webglAvailable?: boolean;
  className?: string;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  camera: GalaxyCamera;
  pan: boolean;
}

function detectWebGl2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  } catch {
    return false;
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createGalaxyProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
      in vec2 a_position;
      in float a_size;
      in vec4 a_color;
      out vec4 v_color;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        gl_PointSize = a_size;
        v_color = a_color;
      }`,
  );
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
      precision mediump float;
      in vec4 v_color;
      out vec4 out_color;
      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        if (length(point) > 1.0 && v_color.a > 0.55) discard;
        out_color = v_color;
      }`,
  );
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

interface GalaxyWebGlResources {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
}

const galaxyWebGlResources = new WeakMap<HTMLCanvasElement, GalaxyWebGlResources>();

function getGalaxyWebGlResources(canvas: HTMLCanvasElement): GalaxyWebGlResources | null {
  const cached = galaxyWebGlResources.get(canvas);
  if (cached && !cached.gl.isContextLost()) return cached;
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  if (!gl) return null;
  const program = createGalaxyProgram(gl);
  const buffer = gl.createBuffer();
  if (!program || !buffer) {
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    return null;
  }
  const resources = { gl, program, buffer };
  galaxyWebGlResources.set(canvas, resources);
  return resources;
}

function drawWebGlGalaxy(input: {
  canvas: HTMLCanvasElement;
  nodes: ReturnType<typeof buildGalaxyLayout>['nodes'];
  edges: readonly GalaxyEdge[];
  camera: GalaxyCamera;
  activityIds: ReadonlySet<string>;
  selectedId: string | null;
  pulse: number;
}): boolean {
  const resources = getGalaxyWebGlResources(input.canvas);
  if (!resources) return false;
  const { gl, program, buffer } = resources;
  const rect = input.canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (input.canvas.width !== width || input.canvas.height !== height) {
    input.canvas.width = width;
    input.canvas.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(program);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const sizeLocation = gl.getAttribLocation(program, 'a_size');
  const colorLocation = gl.getAttribLocation(program, 'a_color');
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const projected = new Map(
    input.nodes.map((node) => [node.id, projectGalaxyPoint(node, input.camera, width, height)]),
  );
  const edgeData: number[] = [];
  for (const edge of input.edges) {
    const from = projected.get(edge.from);
    const to = projected.get(edge.to);
    if (!from?.visible || !to?.visible) continue;
    const active = input.activityIds.has(edge.from) || input.activityIds.has(edge.to);
    const edgeColor = active
      ? [0.35, 0.9, 1, 0.62 + input.pulse * 0.3]
      : [0.37, 0.18, 0.32, 1];
    for (const point of [from, to]) {
      edgeData.push(
        (point.x / width) * 2 - 1,
        1 - (point.y / height) * 2,
        active ? 1.5 : 1,
        ...edgeColor,
      );
    }
  }
  const draw = (data: number[], primitive: number) => {
    if (data.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    const stride = 7 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(sizeLocation);
    gl.vertexAttribPointer(
      sizeLocation,
      1,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(
      colorLocation,
      4,
      gl.FLOAT,
      false,
      stride,
      3 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.drawArrays(primitive, 0, data.length / 7);
  };
  draw(edgeData, gl.LINES);
  const nodeData: number[] = [];
  for (const node of input.nodes) {
    const point = projected.get(node.id);
    if (!point?.visible || !byId.has(node.id)) continue;
    const active = input.activityIds.has(node.id);
    const selected = input.selectedId === node.id;
    const size =
      Math.max(5, Math.min(34, node.radius * point.scale * 2.2)) +
      (active ? input.pulse * 5 : 0) +
      (selected ? 4 : 0);
    const color = selected
      ? [1, 0.71, 0.28, 1]
      : active
        ? [0.35, 0.9, 1, 1]
        : node.depth === 0
          ? [0.95, 0.58, 0.25, 0.96]
          : [0.72, 0.77, 0.88, 0.86];
    nodeData.push((point.x / width) * 2 - 1, 1 - (point.y / height) * 2, size, ...color);
  }
  draw(nodeData, gl.POINTS);
  return true;
}

export function ContextGalaxy({
  nodes,
  edges,
  selectedId,
  activityNodeIds,
  onSelect,
  compact = false,
  reducedMotion = false,
  webglAvailable,
  className,
}: ContextGalaxyProps) {
  const available = React.useMemo(() => webglAvailable ?? detectWebGl2(), [webglAvailable]);
  const [renderMode, setRenderMode] = React.useState<'3d' | '2d'>(available ? '3d' : '2d');
  const [camera, setCamera] = React.useState<GalaxyCamera>({
    ...DEFAULT_GALAXY_CAMERA,
    distance: compact ? 1_850 : DEFAULT_GALAXY_CAMERA.distance,
  });
  const [size, setSize] = React.useState({ width: 800, height: compact ? 240 : 600 });
  const [webGlFailed, setWebGlFailed] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const regionRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const activityIds = React.useMemo(() => new Set(activityNodeIds.slice(0, 32)), [activityNodeIds]);
  const galaxy = React.useMemo(() => buildGalaxyLayout(nodes), [nodes]);
  const lod = React.useMemo(
    () =>
      selectGalaxyLod({
        nodes: galaxy.nodes,
        edges,
        camera,
        selectedId,
        activityIds,
        compact,
      }),
    [activityIds, camera, compact, edges, galaxy.nodes, selectedId],
  );
  const nodeContent = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? (nodeContent.get(selectedId) ?? null) : null;
  const projectedLabels = React.useMemo(
    () =>
      lod.nodes
        .map((node) => ({
          node,
          point: projectGalaxyPoint(node, camera, size.width, size.height),
          content: nodeContent.get(node.id),
        }))
        .filter(
          ({ node, point }) =>
            point.visible &&
            (node.id === selectedId || activityIds.has(node.id) || (!compact && node.depth <= 1)),
        )
        .sort((left, right) => left.point.depth - right.point.depth)
        .slice(0, compact ? 6 : 28),
    [activityIds, camera, compact, lod.nodes, nodeContent, selectedId, size],
  );

  React.useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, entry?.contentRect.width ?? 1);
      const height = Math.max(1, entry?.contentRect.height ?? 1);
      setSize({ width, height });
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (renderMode !== '3d' || !canvasRef.current || webGlFailed) return;
    let frame = 0;
    let stopped = false;
    const started = performance.now();
    const paint = (now: number) => {
      if (stopped || !canvasRef.current) return;
      const activeWindow = !reducedMotion && activityIds.size > 0 && now - started <= 1_500;
      const pulse = activeWindow ? (Math.sin((now - started) / 120) + 1) / 2 : 0;
      const ok = drawWebGlGalaxy({
        canvas: canvasRef.current,
        nodes: lod.nodes,
        edges: lod.edges,
        camera,
        activityIds,
        selectedId,
        pulse,
      });
      if (!ok) {
        setWebGlFailed(true);
        setRenderMode('2d');
        return;
      }
      if (activeWindow) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [
    activityIds,
    camera,
    lod.edges,
    lod.nodes,
    reducedMotion,
    renderMode,
    selectedId,
    webGlFailed,
  ]);

  const updateCamera = (action: Parameters<typeof reduceGalaxyCamera>[1]) =>
    setCamera((current) => reduceGalaxyCamera(current, action));

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (renderMode !== '3d') return;
    const pan = event.shiftKey || event.button === 1 || event.button === 2;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera,
      pan,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    setCamera(
      drag.pan
        ? reduceGalaxyCamera(drag.camera, {
            type: 'pan',
            deltaX: -dx * (drag.camera.distance / Math.max(300, size.width)),
            deltaY: dy * (drag.camera.distance / Math.max(300, size.height)),
          })
        : reduceGalaxyCamera(drag.camera, {
            type: 'orbit',
            deltaYaw: dx * 0.006,
            deltaPitch: dy * 0.006,
          }),
    );
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (
      !drag.pan &&
      Math.abs(event.clientX - drag.x) <= 5 &&
      Math.abs(event.clientY - drag.y) <= 5
    ) {
      const rect = event.currentTarget.getBoundingClientRect();
      const pointerX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * size.width;
      const pointerY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * size.height;
      let nearest: { id: string; distance: number } | null = null;
      for (const node of lod.nodes) {
        const point = projectGalaxyPoint(node, camera, size.width, size.height);
        if (!point.visible) continue;
        const distance = Math.hypot(point.x - pointerX, point.y - pointerY);
        const hitRadius = Math.max(14, node.radius * point.scale * 1.8);
        if (distance <= hitRadius && (!nearest || distance < nearest.distance)) {
          nearest = { id: node.id, distance };
        }
      }
      if (nearest) onSelect(nearest.id);
    }
  };
  const moveSelection = (delta: number) => {
    if (nodes.length === 0) return;
    const current = Math.max(
      0,
      nodes.findIndex((node) => node.id === selectedId),
    );
    onSelect(nodes[(current + delta + nodes.length) % nodes.length]!.id);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      updateCamera({ type: 'zoom', factor: 0.85 });
    } else if (event.key === '-') {
      event.preventDefault();
      updateCamera({ type: 'zoom', factor: 1.15 });
    } else if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      updateCamera({ type: 'reset' });
    }
  };

  const effectiveMode = available && !webGlFailed ? renderMode : '2d';
  return (
    <div
      ref={regionRef}
      role="region"
      aria-label={compact ? 'Compact Context galaxy' : 'Context galaxy'}
      tabIndex={0}
      data-context-galaxy-mode={compact ? 'compact' : 'full'}
      data-context-renderer={effectiveMode}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={(event) => {
        event.stopPropagation();
        if (effectiveMode !== '3d') return;
        event.preventDefault();
        updateCamera({ type: 'zoom', factor: event.deltaY > 0 ? 1.12 : 0.88 });
      }}
      className={cn(
        'relative isolate w-full overflow-hidden bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        compact
          ? 'h-56 border-t border-border/50'
          : 'h-full min-h-[28rem] rounded-xl border border-border/50',
        className,
      )}
    >
      <div className="absolute left-2 top-2 z-20 flex flex-wrap gap-1">
        <button
          type="button"
          aria-label="Use 3D galaxy"
          aria-pressed={effectiveMode === '3d'}
          disabled={!available || webGlFailed}
          onClick={() => setRenderMode('3d')}
          className="inline-flex min-h-8 items-center gap-1 rounded-md bg-background/85 px-2 text-xs text-foreground disabled:opacity-45"
        >
          <Box className="h-3.5 w-3.5" /> 3D
        </button>
        <button
          type="button"
          aria-label="Use 2D fallback"
          aria-pressed={effectiveMode === '2d'}
          onClick={() => setRenderMode('2d')}
          className="inline-flex min-h-8 items-center gap-1 rounded-md bg-background/85 px-2 text-xs text-foreground"
        >
          <Rows3 className="h-3.5 w-3.5" /> 2D
        </button>
        <button
          type="button"
          aria-label="Center galaxy"
          onClick={() => updateCamera({ type: 'reset' })}
          className="inline-flex min-h-8 items-center gap-1 rounded-md bg-background/85 px-2 text-xs text-foreground"
        >
          <LocateFixed className="h-3.5 w-3.5" /> Center
        </button>
        {!compact && effectiveMode === '3d' ? (
          <>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => updateCamera({ type: 'zoom', factor: 0.85 })}
              className="grid h-8 w-8 place-items-center rounded-md bg-background/85"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => updateCamera({ type: 'zoom', factor: 1.15 })}
              className="grid h-8 w-8 place-items-center rounded-md bg-background/85"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
      </div>

      {effectiveMode === '3d' ? (
        <>
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            data-animation-enabled={String(!reducedMotion && activityIds.size > 0)}
            className="h-full w-full touch-none"
          />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {projectedLabels.map(({ node, point, content }) => (
              <span
                key={node.id}
                className={cn(
                  'absolute max-w-40 -translate-x-1/2 translate-y-2 truncate rounded bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground',
                  node.id === selectedId && 'text-foreground',
                )}
                style={{ left: point.x, top: point.y }}
              >
                {content?.label ?? node.id}
              </span>
            ))}
          </div>
        </>
      ) : (
        <svg
          data-testid="context-galaxy-2d"
          role="img"
          aria-label="Two-dimensional Context map fallback"
          viewBox="-800 -520 1600 1040"
          className="h-full w-full"
        >
          {lod.edges.map((edge) => {
            const from = galaxy.byId.get(edge.from);
            const to = galaxy.byId.get(edge.to);
            const active = activityIds.has(edge.from) || activityIds.has(edge.to);
            return from && to ? (
              <line
                key={edge.id}
                data-context-edge={edge.id}
                data-context-activity={String(active)}
                x1={from.x}
                y1={from.z}
                x2={to.x}
                y2={to.z}
                stroke={active ? 'hsl(var(--accent-copper))' : 'hsl(var(--border))'}
                strokeWidth={active ? 3 : 2}
                strokeDasharray={active ? '8 7' : undefined}
                className={cn(active && !reducedMotion && 'animate-pulse')}
              />
            ) : null;
          })}
          {lod.nodes.map((node) => (
            <circle
              key={node.id}
              cx={node.x}
              cy={node.z}
              r={Math.max(8, node.radius)}
              fill={
                node.id === selectedId
                  ? 'hsl(var(--accent-copper))'
                  : 'hsl(var(--muted-foreground))'
              }
              opacity={activityIds.has(node.id) ? 1 : 0.72}
            />
          ))}
        </svg>
      )}

      {lod.clusteredCount > 0 ? (
        <p className="absolute bottom-2 left-2 rounded bg-background/80 px-2 py-1 text-[10px] text-muted-foreground">
          {lod.clusteredCount.toLocaleString()} distant nodes clustered. Zoom in to reveal more.
        </p>
      ) : null}
      <div className="absolute bottom-2 right-2 z-20 max-w-[55%] rounded-md bg-background/85 p-2 text-right">
        <div className="flex items-center justify-end gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          <Orbit className="h-3 w-3" /> {effectiveMode === '3d' ? 'Drag to orbit' : '2D fallback'}
        </div>
        {selected ? (
          <>
            <strong className="block truncate text-xs text-foreground">{selected.label}</strong>
            {!compact ? (
              <span className="block line-clamp-2 text-[10px] text-muted-foreground">
                {selected.description}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="sr-only">
        <p aria-live="polite">
          {selected ? `Selected ${selected.label}. ${selected.description}` : 'No node selected.'}
        </p>
        <ul aria-label="Context galaxy nodes">
          {nodes.slice(0, compact ? 40 : 120).map((node) => (
            <li key={node.id}>
              <button
                type="button"
                data-context-activity={String(activityIds.has(node.id))}
                aria-current={node.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(node.id)}
              >
                {node.label}: {node.description}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

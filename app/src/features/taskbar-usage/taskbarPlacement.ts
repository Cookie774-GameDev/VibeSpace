import type { TaskbarEdge, TaskbarUsagePlacement } from './providerUsageTypes';

export interface PhysicalPoint {
  x: number;
  y: number;
}

export interface PhysicalDimensions {
  width: number;
  height: number;
}

export interface MonitorWorkArea {
  name: string;
  position: PhysicalPoint;
  size: PhysicalDimensions;
  workArea: {
    position: PhysicalPoint;
    size: PhysicalDimensions;
  };
}

export interface ResolvedTaskbarPlacement extends TaskbarUsagePlacement {
  x: number;
  y: number;
}

function taskbarInsets(monitor: MonitorWorkArea): Record<TaskbarEdge, number> {
  const monitorRight = monitor.position.x + monitor.size.width;
  const monitorBottom = monitor.position.y + monitor.size.height;
  const workRight = monitor.workArea.position.x + monitor.workArea.size.width;
  const workBottom = monitor.workArea.position.y + monitor.workArea.size.height;
  return {
    left: Math.max(0, monitor.workArea.position.x - monitor.position.x),
    top: Math.max(0, monitor.workArea.position.y - monitor.position.y),
    right: Math.max(0, monitorRight - workRight),
    bottom: Math.max(0, monitorBottom - workBottom),
  };
}

export function inferTaskbarEdge(monitor: MonitorWorkArea): TaskbarEdge {
  const insets = taskbarInsets(monitor);
  const ranked = (Object.entries(insets) as Array<[TaskbarEdge, number]>).sort(
    (left, right) => right[1] - left[1],
  );
  return ranked[0]?.[1] > 0 ? ranked[0][0] : 'bottom';
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(0, Math.round(value)), Math.max(0, maximum));
}

export function resolveTaskbarPlacement(input: {
  monitors: readonly MonitorWorkArea[];
  saved: TaskbarUsagePlacement | null;
  windowSize: PhysicalDimensions;
}): ResolvedTaskbarPlacement {
  if (input.monitors.length === 0) {
    return { monitorName: '', edge: 'bottom', offset: 0, x: 0, y: 0 };
  }
  const monitor =
    input.monitors.find(({ name }) => name === input.saved?.monitorName) ?? input.monitors[0];
  const savedMonitorFound = monitor.name === input.saved?.monitorName;
  const edge = savedMonitorFound && input.saved ? input.saved.edge : inferTaskbarEdge(monitor);
  const horizontal = edge === 'top' || edge === 'bottom';
  const maximumOffset = horizontal
    ? monitor.workArea.size.width - input.windowSize.width
    : monitor.workArea.size.height - input.windowSize.height;
  const offset = clamp(input.saved?.offset ?? 40, maximumOffset);
  const work = monitor.workArea;
  const x =
    edge === 'left'
      ? work.position.x
      : edge === 'right'
        ? work.position.x + work.size.width - input.windowSize.width
        : work.position.x + offset;
  const y =
    edge === 'top'
      ? work.position.y
      : edge === 'bottom'
        ? work.position.y + work.size.height - input.windowSize.height
        : work.position.y + offset;
  return { monitorName: monitor.name, edge, offset, x, y };
}

export function placementFromWindowPosition(input: {
  monitor: MonitorWorkArea;
  position: PhysicalPoint;
  windowSize: PhysicalDimensions;
}): ResolvedTaskbarPlacement {
  const edge = inferTaskbarEdge(input.monitor);
  const offset =
    edge === 'top' || edge === 'bottom'
      ? input.position.x - input.monitor.workArea.position.x
      : input.position.y - input.monitor.workArea.position.y;
  return resolveTaskbarPlacement({
    monitors: [input.monitor],
    saved: { monitorName: input.monitor.name, edge, offset },
    windowSize: input.windowSize,
  });
}

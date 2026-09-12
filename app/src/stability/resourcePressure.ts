import { stabilityDiagnostics } from './stabilityDiagnostics';

export const RESOURCE_PRESSURE_EVENT = 'jarvis:resource-pressure';
const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

export interface HeapSample {
  usedBytes: number;
  limitBytes: number;
}

interface ResourcePressureControllerOptions {
  threshold?: number;
  cooldownMs?: number;
}

export function createResourcePressureController(options: ResourcePressureControllerOptions = {}) {
  const threshold = options.threshold ?? 0.8;
  const cooldownMs = options.cooldownMs ?? 30_000;
  let lastTriggeredAt: number | null = null;

  return {
    evaluate(sample: HeapSample | null, now: number): boolean {
      if (!sample || sample.limitBytes <= 0 || sample.usedBytes < 0) return false;
      if (sample.usedBytes / sample.limitBytes < threshold) return false;
      if (lastTriggeredAt !== null && now - lastTriggeredAt < cooldownMs) return false;
      lastTriggeredAt = now;
      return true;
    },
  };
}

function readChromiumHeapSample(): HeapSample | null {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
    }
  ).memory;
  if (typeof memory?.usedJSHeapSize !== 'number' || typeof memory.jsHeapSizeLimit !== 'number') {
    return null;
  }
  return { usedBytes: memory.usedJSHeapSize, limitBytes: memory.jsHeapSizeLimit };
}

export function startResourcePressureMonitor(): () => void {
  const controller = createResourcePressureController();
  const sample = () => {
    const heap = readChromiumHeapSample();
    const now = Date.now();
    if (!controller.evaluate(heap, now) || !heap) return;
    stabilityDiagnostics.record({
      type: 'resource-pressure',
      at: now,
      usedBytes: heap.usedBytes,
      limitBytes: heap.limitBytes,
    });
    window.dispatchEvent(new CustomEvent(RESOURCE_PRESSURE_EVENT, { detail: heap }));
  };
  const timer = window.setInterval(sample, RESOURCE_SAMPLE_INTERVAL_MS);
  return () => window.clearInterval(timer);
}

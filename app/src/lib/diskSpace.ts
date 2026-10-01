/**
 * Lightweight free-space probe for write-heavy actions (Ollama pulls, etc.).
 *
 * - Fresh probe on every force call (download/repair/write triggers).
 * - Optional 5-minute background refresh for UI consumers.
 * - Prefer native Tauri free-space when available; browser storage.estimate is
 *   only an origin-quota hint and must not be treated as authoritative OS free
 *   disk for tools that write outside the web origin (Ollama).
 */

export type DiskSpaceProbe = Readonly<{
  availableBytes: number | null;
  /** true when the number is OS free space; false when browser origin estimate */
  authoritative: boolean;
  probedAt: number;
  source: 'native' | 'browser_estimate' | 'unavailable';
}>;

const FIVE_MIN_MS = 5 * 60 * 1000;

let cache: DiskSpaceProbe | null = null;
let inflight: Promise<DiskSpaceProbe> | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

function parseSizeLabelToBytes(size: string | undefined | null): number | null {
  if (!size) return null;
  const match = size.trim().match(/^([\d.]+)\s*(kb|mb|gb|tb)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2]!.toLowerCase();
  const mult =
    unit === 'kb' ? 1_000 : unit === 'mb' ? 1_000_000 : unit === 'gb' ? 1_000_000_000 : 1_000_000_000_000;
  return Math.round(n * mult);
}

/** Public helper for catalog size strings like "1.3 GB". */
export function sizeLabelToBytes(size: string | undefined | null): number | null {
  return parseSizeLabelToBytes(size);
}

async function probeNative(): Promise<number | null> {
  try {
    const isTauri =
      typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (!isTauri) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke<number>('get_available_disk_bytes');
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  } catch {
    /* command missing or failed — fall through */
  }
  return null;
}

async function probeBrowserEstimate(): Promise<number | null> {
  try {
    if (typeof navigator === 'undefined' || !('storage' in navigator)) return null;
    const estimate = await navigator.storage.estimate();
    if (estimate.quota != null && estimate.usage != null) {
      return Math.max(0, estimate.quota - estimate.usage);
    }
    if (estimate.quota != null) return estimate.quota;
  } catch {
    /* ignore */
  }
  return null;
}

async function probeOnce(): Promise<DiskSpaceProbe> {
  const now = Date.now();
  const native = await probeNative();
  if (native != null) {
    return {
      availableBytes: native,
      authoritative: true,
      probedAt: now,
      source: 'native',
    };
  }
  const browser = await probeBrowserEstimate();
  if (browser != null) {
    return {
      availableBytes: browser,
      authoritative: false,
      probedAt: now,
      source: 'browser_estimate',
    };
  }
  return {
    availableBytes: null,
    authoritative: false,
    probedAt: now,
    source: 'unavailable',
  };
}

/**
 * Read free space. Uses cache unless force or older than 5 minutes.
 * Write actions must pass force: true.
 */
export async function getAvailableDiskBytes(opts?: {
  force?: boolean;
}): Promise<DiskSpaceProbe> {
  const force = opts?.force === true;
  const now = Date.now();
  if (!force && cache && now - cache.probedAt < FIVE_MIN_MS) {
    return cache;
  }
  if (inflight) return inflight;
  inflight = probeOnce()
    .then((result) => {
      cache = result;
      notify();
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Whether a write of `requiredBytes` is safe.
 * - Native free-space: hard check with 15% headroom.
 * - Browser estimate only: soft — do not hard-block (origin quota ≠ Ollama disk).
 * - Unknown: allow (fail open) so a stale/unavailable probe never blocks hours later.
 */
export async function hasEnoughDiskSpaceForWrite(
  requiredBytes: number,
  opts?: { force?: boolean },
): Promise<{
  ok: boolean;
  availableBytes: number | null;
  authoritative: boolean;
  source: DiskSpaceProbe['source'];
  requiredBytes: number;
}> {
  const required =
    Number.isFinite(requiredBytes) && requiredBytes > 0 ? requiredBytes : 2_000_000_000;
  const probe = await getAvailableDiskBytes({ force: opts?.force !== false });
  const available = probe.availableBytes;

  if (available == null) {
    return {
      ok: true,
      availableBytes: null,
      authoritative: false,
      source: probe.source,
      requiredBytes: required,
    };
  }

  const headroom = required * 1.15;
  if (probe.authoritative) {
    return {
      ok: available >= headroom,
      availableBytes: available,
      authoritative: true,
      source: probe.source,
      requiredBytes: required,
    };
  }

  // Browser origin estimate is not OS free space for Ollama. Only block when
  // the estimate is clearly tiny relative to the model (under half of need).
  const clearlyTooSmall = available < required * 0.5;
  return {
    ok: !clearlyTooSmall,
    availableBytes: available,
    authoritative: false,
    source: probe.source,
    requiredBytes: required,
  };
}

export function formatBytesShort(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** Start background refresh every 5 minutes (idempotent). */
export function startDiskSpaceAutoCheck(intervalMs = FIVE_MIN_MS): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (intervalId != null) {
    return () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }
  void getAvailableDiskBytes({ force: true });
  intervalId = setInterval(() => {
    void getAvailableDiskBytes({ force: true });
  }, intervalMs);
  return () => {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

export function subscribeDiskSpace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCachedDiskSpace(): DiskSpaceProbe | null {
  return cache;
}

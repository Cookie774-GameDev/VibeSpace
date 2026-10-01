/**
 * User-facing clock format preference.
 *
 * - `local` — locale-default presentation (12-hour where the locale uses it)
 * - `military` — always 24-hour (HH:mm)
 *
 * Stored timestamps are never rewritten; format only at display boundaries.
 * Timezone is always the OS/local system zone unless a call site overrides.
 */

export type ClockFormat = 'local' | 'military';

export const CLOCK_FORMATS: readonly ClockFormat[] = ['local', 'military'] as const;

export const DEFAULT_CLOCK_FORMAT: ClockFormat = 'local';

/** Ambient idle threshold presets in minutes (Settings → Ambient). */
export const AMBIENT_IDLE_PRESETS_MIN: readonly { label: string; value: number }[] = [
  { label: '1 min', value: 1 },
  { label: '3 min', value: 3 },
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '60 min', value: 60 },
  { label: '90 min', value: 90 },
] as const;

export function isClockFormat(value: unknown): value is ClockFormat {
  return value === 'local' || value === 'military';
}

export function normalizeClockFormat(value: unknown): ClockFormat {
  return isClockFormat(value) ? value : DEFAULT_CLOCK_FORMAT;
}

/**
 * `hour12` for Intl: military forces 24h; local leaves locale default.
 */
export function hour12ForFormat(format: ClockFormat): boolean | undefined {
  return format === 'military' ? false : undefined;
}

export type UserTimeOptions = {
  format?: ClockFormat;
  /** Include seconds in the time portion. */
  seconds?: boolean;
  /** Override locale (tests / rare call sites). Default: runtime locale. */
  locale?: string | string[];
  /** Optional extra Intl fields merged after format defaults. */
  extra?: Intl.DateTimeFormatOptions;
};

/** Build Intl options for a wall-clock time under the user preference. */
export function timeFormatOptions(
  format: ClockFormat,
  options?: Pick<UserTimeOptions, 'seconds' | 'extra'>,
): Intl.DateTimeFormatOptions {
  const hour12 = hour12ForFormat(format);
  return {
    hour: format === 'military' ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(options?.seconds ? { second: '2-digit' as const } : {}),
    ...(hour12 === undefined ? {} : { hour12 }),
    ...options?.extra,
  };
}

/** Format a unix-ms (or Date) as local wall-clock time only. */
export function formatUserTime(ts: number | Date, options?: UserTimeOptions): string {
  const format = options?.format ?? resolveClockFormat();
  const d = typeof ts === 'number' ? new Date(ts) : ts;
  return d.toLocaleTimeString(options?.locale, timeFormatOptions(format, options));
}

/** Format date + time for schedules, history, activity, notifications. */
export function formatUserDateTime(
  ts: number | Date,
  options?: UserTimeOptions & {
    weekday?: 'short' | 'long' | 'narrow';
    month?: 'short' | 'long' | 'numeric' | '2-digit';
    day?: 'numeric' | '2-digit';
    year?: 'numeric' | '2-digit';
  },
): string {
  const format = options?.format ?? resolveClockFormat();
  const d = typeof ts === 'number' ? new Date(ts) : ts;
  return d.toLocaleString(options?.locale, {
    weekday: options?.weekday,
    month: options?.month ?? 'short',
    day: options?.day ?? 'numeric',
    year: options?.year,
    ...timeFormatOptions(format, { seconds: options?.seconds, extra: options?.extra }),
  });
}

/**
 * Ambient home large clock parts. Military keeps tabular HH:MM;
 * local uses locale-aware hour/minute (+ period when 12-hour).
 */
export function formatAmbientClockParts(
  d: Date,
  format: ClockFormat,
): { h: string; m: string; period: string | null; date: string } {
  const date = d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  if (format === 'military') {
    return {
      h: d.getHours().toString().padStart(2, '0'),
      m: d.getMinutes().toString().padStart(2, '0'),
      period: null,
      date,
    };
  }

  // Locale-driven local/standard: parse via Intl parts so AM/PM stays separate
  // for the ambient layout without hardcoding en-US.
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(() => {
      const hour12 = hour12ForFormat('local');
      return hour12 === undefined ? {} : { hour12 };
    })(),
  }).formatToParts(d);

  let h = '';
  let m = '';
  let period: string | null = null;
  for (const part of parts) {
    if (part.type === 'hour') h = part.value;
    else if (part.type === 'minute') m = part.value.padStart(2, '0');
    else if (part.type === 'dayPeriod') period = part.value;
  }
  if (!h || !m) {
    const fallback = d.toLocaleTimeString(undefined, timeFormatOptions('local'));
    return { h: fallback, m: '', period: null, date };
  }
  return { h, m, period, date };
}

// ── Store bridge (set from ui store; pure module stays free of init cycles) ──

type ClockFormatReader = () => ClockFormat;
let clockFormatReader: ClockFormatReader | null = null;

/** Called once from the UI store module after the store is defined. */
export function bindClockFormatReader(reader: ClockFormatReader): void {
  clockFormatReader = reader;
}

export function resolveClockFormat(): ClockFormat {
  try {
    return normalizeClockFormat(clockFormatReader?.());
  } catch {
    return DEFAULT_CLOCK_FORMAT;
  }
}

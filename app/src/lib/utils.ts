import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose Tailwind classes safely with clsx + tailwind-merge.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Cheap deterministic hash for strings (djb2). Used to derive
 * agent colors from agent name slugs.
 */
export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Derive a stable HSL hue (0-359) from a string, useful for
 * "color per agent" UI without configuration.
 */
export function hueFromString(s: string): number {
  return hashString(s) % 360;
}

/**
 * Derive a CSS color string in the project's saturation/lightness convention.
 */
export function colorFromString(s: string, saturation = 70, lightness = 60): string {
  return `hsl(${hueFromString(s)}, ${saturation}%, ${lightness}%)`;
}

/**
 * Format a unix-ms timestamp relative to now ("2m ago", "in 3h", "yesterday").
 * Cheap and correct enough for inline display.
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  const ms = 1;
  const sec = 1000 * ms;
  const min = 60 * sec;
  const hour = 60 * min;
  const day = 24 * hour;

  const future = diff > 0;
  const prefix = future ? 'in ' : '';
  const suffix = future ? '' : ' ago';

  if (abs < 45 * sec) return future ? 'in a moment' : 'just now';
  if (abs < 90 * sec) return `${prefix}1 min${suffix}`;
  if (abs < 45 * min) return `${prefix}${Math.round(abs / min)} min${suffix}`;
  if (abs < 90 * min) return `${prefix}1 hr${suffix}`;
  if (abs < 22 * hour) return `${prefix}${Math.round(abs / hour)} hr${suffix}`;
  if (abs < 36 * hour) return future ? 'tomorrow' : 'yesterday';
  if (abs < 26 * day) return `${prefix}${Math.round(abs / day)} days${suffix}`;

  return new Date(ts).toLocaleDateString();
}

/**
 * Format a clock time like "9:43 AM"
 */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format an absolute date like "Fri, May 28"
 */
export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Format token count: 1234 -> "1.2k", 1234567 -> "1.2M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Format USD cost with at-most 4 decimals, dropping trailing zeros.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return '<$0.001';
  return '$' + usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2);
}

/**
 * Sleep for ms. Used in mock provider streams.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Detect Mac platform - used to swap Cmd/Ctrl in keybinding hints.
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent || '');

/**
 * Render a keybinding hint like "Cmd+K" / "Ctrl+K" depending on platform.
 */
export function renderHotkey(hotkey: string): string {
  return hotkey.replace(/(?:Cmd|Mod)/gi, isMac ? '\u2318' : 'Ctrl').replace(/Shift/gi, '\u21E7').replace(/\+/g, ' ');
}

/**
 * Bound a number between min and max.
 */
export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Detect Tauri runtime. Useful to gate features that only work in the desktop shell.
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

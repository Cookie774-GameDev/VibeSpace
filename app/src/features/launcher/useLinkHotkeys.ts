/**
 * Wires per-link global hotkeys for the active workspace.
 *
 * Every {@link QuickLink} with a non-empty `hotkey` field becomes a global
 * launch shortcut: pressing the combo anywhere in the app fires
 * {@link launchLink} on that link. We mount one window-level keydown
 * listener and route inside it, instead of looping {@link useHotkey} which
 * would violate the Rules of Hooks when the link list changes shape.
 *
 * Modifier combos (Mod/Ctrl/Cmd + …) fire even when an input is focused, so
 * users can launch from inside the chat composer. Bare keys (e.g. just
 * `F1`) are suppressed inside text inputs so they don't eat keystrokes.
 *
 * Mounted once at the app root from {@link GlobalHotkeysHost} so the
 * shortcuts work outside the launcher dialog too.
 */
import { useEffect } from 'react';
import { matchesHotkey } from '@/lib/hotkeys';
import { useAuthStore } from '@/stores/auth';
import type { WorkspaceId } from '@/types/common';
import { useQuickLinks } from './hooks';
import { launchLink } from './launch';

const MODIFIER_NAMES = new Set(['mod', 'cmd', 'ctrl', 'shift', 'alt', 'option']);
const MODIFIER_RX = /\b(mod|cmd|ctrl|shift|alt|option)\b/i;

/**
 * Loose validator for the hotkey field on a {@link QuickLink}. We only
 * reject obvious mistakes (empty parts, trailing modifier) so power users
 * can still type unusual single-key bindings like `F1` or `/`. An empty
 * string is treated as "no binding" and is always valid.
 */
export function isValidHotkey(combo: string): boolean {
  const trimmed = combo.trim();
  if (!trimmed) return true;
  const parts = trimmed.split('+').map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return false;
  const last = parts[parts.length - 1].toLowerCase();
  // Last part must be the actual key, not a bare modifier.
  if (MODIFIER_NAMES.has(last)) return false;
  // Everything before the last part must be a modifier.
  for (let i = 0; i < parts.length - 1; i++) {
    if (!MODIFIER_NAMES.has(parts[i].toLowerCase())) return false;
  }
  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function useLinkHotkeys(): void {
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const links = useQuickLinks(workspaceId);

  useEffect(() => {
    const bound = links.filter((l) => !!l.hotkey && l.hotkey.trim().length > 0);
    if (bound.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      const inEditable = isEditableTarget(e.target);
      for (const link of bound) {
        const combo = link.hotkey!;
        // Bare-key hotkeys would steal keystrokes inside text inputs.
        if (inEditable && !MODIFIER_RX.test(combo)) continue;
        if (matchesHotkey(e, combo)) {
          e.preventDefault();
          void launchLink(link);
          break;
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [links]);
}

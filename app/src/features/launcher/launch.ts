/**
 * Quick-link launch dispatcher.
 *
 * Different `LinkKind`s open through different mechanisms:
 *   - web / youtube / spotify / soundcloud  → window.open (external browser)
 *     unless `behavior === 'in_app_player'` (V3 — opens an in-app player pane)
 *   - app                                    → window.open (Tauri runtime can
 *     intercept `tauri://` schemes; web fallback opens in a new tab)
 *   - file                                   → window.open with `file://`
 *     (Tauri only; no-op in pure browser dev)
 *   - jarvis-action                          → emits a `jarvis:link-action`
 *     CustomEvent that features can listen for. We bake-in handlers for the
 *     common shapes (open settings tab, ambient mode, schedule, palette).
 *
 * Always bumps `last_used_at` so the AmbientHome's "stale links" hint can
 * surface forgotten links over time.
 */
import { quickLinkRepo } from '@/lib/db';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import type { QuickLink } from '@/types/quick-link';

export interface LaunchResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run a link. Resolves once the launch effect has been kicked off (window
 * opens are fire-and-forget; jarvis-actions complete synchronously).
 */
export async function launchLink(link: QuickLink): Promise<LaunchResult> {
  // Best-effort: bump last_used_at first so the UI updates even if the open fails.
  try {
    await quickLinkRepo.touchLastUsed(link.id);
  } catch {
    /* not fatal */
  }

  switch (link.kind) {
    case 'web':
    case 'youtube':
    case 'youtube-playlist':
    case 'spotify':
    case 'soundcloud':
    case 'app':
    case 'file': {
      try {
        // V2 always opens externally. V3 will branch on `behavior` to drop
        // into the in-app player or pip window.
        window.open(link.url, '_blank', 'noopener,noreferrer');
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unknown launch error';
        toast.error(`Could not open ${link.label}`, reason);
        return { ok: false, reason };
      }
    }

    case 'jarvis-action': {
      // Built-in jarvis:// actions for shipping V2.
      // Anything else fires a CustomEvent so feature code can subscribe.
      const action = link.url.replace(/^jarvis:\/\//, '').toLowerCase();
      const ui = useUIStore.getState();
      switch (action) {
        case 'settings':
          ui.setSettingsOpen(true);
          return { ok: true };
        case 'palette':
          ui.setPaletteOpen(true);
          return { ok: true };
        case 'schedule':
          ui.setScheduleOpen(true);
          return { ok: true };
        case 'ambient':
          if (!ui.ambient) ui.setAmbient(true);
          ui.setAmbientActive(true);
          return { ok: true };
        case 'fullscreen':
          ui.toggleChatFullscreen();
          return { ok: true };
        case 'voice':
          ui.toggleVoice();
          return { ok: true };
        default: {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('jarvis:link-action', { detail: { action, link } }),
            );
          }
          return { ok: true };
        }
      }
    }
  }
}

/** Keyword presets — quick-add common links from the launcher empty state. */
export const QUICK_PRESETS: Array<Pick<QuickLink, 'label' | 'url' | 'kind' | 'icon' | 'color_hue' | 'behavior'>> = [
  { label: 'YouTube', url: 'https://youtube.com', kind: 'youtube', icon: '\u25B6', color_hue: 0, behavior: 'external_browser' },
  { label: 'Spotify', url: 'https://open.spotify.com', kind: 'spotify', icon: '\u266B', color_hue: 140, behavior: 'external_browser' },
  { label: 'GitHub', url: 'https://github.com', kind: 'web', icon: '\u26EF', color_hue: 230, behavior: 'external_browser' },
  { label: 'ChatGPT', url: 'https://chat.openai.com', kind: 'web', icon: '\u2728', color_hue: 160, behavior: 'external_browser' },
  { label: 'Claude', url: 'https://claude.ai', kind: 'web', icon: '\u25C6', color_hue: 30, behavior: 'external_browser' },
  { label: 'Schedule', url: 'jarvis://schedule', kind: 'jarvis-action', icon: '\u25EB', color_hue: 280, behavior: 'side_panel' },
  { label: 'Ambient', url: 'jarvis://ambient', kind: 'jarvis-action', icon: '\u25CB', color_hue: 200, behavior: 'side_panel' },
];

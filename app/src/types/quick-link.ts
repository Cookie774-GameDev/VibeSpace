import type {
  ProjectId,
  QuickLinkGroupId,
  QuickLinkId,
  Timestamped,
  WorkspaceId,
} from './common';

/**
 * Quick Launch — saved links that the user can launch by voice, hotkey,
 * or click. Backed by `quick_links` and `quick_link_groups` Dexie tables.
 *
 * `kind` tells the UI how to render the tile and the launcher how to open
 * the URL. `behavior` overrides the default open mode per link (e.g. you
 * can have a YouTube link that opens in an external browser instead of the
 * in-app player).
 */

export type LinkKind =
  | 'web'
  | 'youtube'
  | 'youtube-playlist'
  | 'spotify'
  | 'soundcloud'
  | 'app'
  | 'file'
  | 'jarvis-action';

export type LinkBehavior =
  | 'external_browser'
  | 'in_app_player'
  | 'pip_window'
  | 'side_panel';

export type QuickLink = {
  id: QuickLinkId;
  workspace_id: WorkspaceId;
  project_id?: ProjectId;
  group_id?: QuickLinkGroupId;
  label: string;
  url: string;
  kind: LinkKind;
  /** Lucide icon name or emoji. */
  icon?: string;
  /** HSL hue 0..359 for tile tint. */
  color_hue?: number;
  /** How the link opens. Default depends on `kind`. */
  behavior: LinkBehavior;
  /** Optional global hotkey, e.g. `Mod+Shift+1`. */
  hotkey?: string;
  /** Sort position within the group (or workspace if no group). */
  position: number;
  tags: string[];
  /** Unix ms. */
  last_used_at?: number;
} & Timestamped;

export type QuickLinkGroup = {
  id: QuickLinkGroupId;
  workspace_id: WorkspaceId;
  name: string;
  color_hue?: number;
  position: number;
} & Timestamped;

export type QuickLinkInput = Pick<QuickLink, 'workspace_id' | 'label' | 'url' | 'kind'> &
  Partial<Omit<QuickLink, 'id' | 'created_at' | 'updated_at'>>;

export type QuickLinkGroupInput = Pick<QuickLinkGroup, 'workspace_id' | 'name'> &
  Partial<Omit<QuickLinkGroup, 'id' | 'created_at' | 'updated_at'>>;

/**
 * Command palette - the global Cmd+K menu and bundled global hotkeys.
 *
 * Mount the {@link CommandPalette} component once at the application root
 * (alongside other top-level providers) and call {@link useGlobalHotkeys}
 * once in the same root component.
 *
 * Other features can extend the palette by calling {@link registerAction}
 * (returns a disposer) or by listening for `jarvis:*` custom events that
 * standard actions emit.
 */
export { CommandPalette } from './CommandPalette';
export { useGlobalHotkeys } from './useGlobalHotkeys';
export {
  registerAction,
  unregisterAction,
  performAction,
  emitJarvisEvent,
  type Action,
  type ActionContext,
  type ActionId,
} from './actions';
export {
  usePaletteStore,
  usePaletteDataStore,
  type PageId,
  type RecentChat,
  type TaskListItem,
} from './store';

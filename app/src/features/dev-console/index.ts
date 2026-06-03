/**
 * Dev console feature barrel.
 *
 * Exposes:
 *   - <DevConsolePanel/> — the bottom-attached UI surface.
 *   - <DevConsoleHost/>  — wires patchers + hotkey + boot breadcrumbs.
 *                           Mount once at the App root.
 *   - devConsole         — imperative facade for non-React callers.
 *   - useDevConsoleStore — direct store access for advanced UI.
 */

export { DevConsolePanel } from './DevConsolePanel';
export { DevConsoleHost } from './DevConsoleHost';
export {
  devConsole,
  useDevConsoleStore,
  filterEntries,
  safeStringify,
  type DevLogChannel,
  type DevLogLevel,
  type DevLogEntry,
} from './store';
export { installPatchers } from './patchers';

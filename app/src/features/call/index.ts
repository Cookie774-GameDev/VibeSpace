/**
 * Public surface of the call feature.
 *
 * Import shape:
 *   import {
 *     CallButton,
 *     CallModalLazy,
 *     loadCallService, getCallService,
 *     useCallStore,
 *     fireOutboundCall, startOutboundTrigger,
 *   } from '@/features/call';
 *
 * Bundle policy:
 *   The LiveKit client is the largest single dependency in the app
 *   (~500KB minified). Statically importing `CallService` from any
 *   eagerly-loaded module pulls it into the boot chunk. To keep
 *   first paint fast, only the `config` module + the call store are
 *   re-exported eagerly here. The CallModal is exposed as a lazy
 *   React component, and the LiveKit-touching `CallService` is
 *   reached through the `loadCallService` async accessor.
 */

import * as React from 'react';

export { CallButton } from './CallButton';
export { useCallStore } from './store';
export type { CallStatus, CallTranscriptEntry } from './store';
export {
  fireOutboundCall,
  startOutboundTrigger,
  type OutboundReason,
  type OutboundContext,
} from './outbound';
export { callCloudUrl, isCallConfigured } from './config';

/**
 * Async accessor for the LiveKit-backed `CallService` singleton.
 *
 * The first call dynamically imports the heavy `CallService` module
 * (and transitively `livekit-client`); subsequent calls reuse the
 * already-loaded module. Resolves to the same singleton
 * `getCallService()` would return after the static import had run.
 */
export async function loadCallService(): Promise<
  import('./CallService').CallService
> {
  const mod = await import('./CallService');
  return mod.getCallService();
}

/**
 * Type-only re-export of the `CallService` class. Importing this is
 * free — TS erases it at build time so the LiveKit chunk stays cold.
 */
export type { CallService, CallServiceOptions } from './CallService';

/**
 * Lazy-mounted CallModal. The modal only renders meaningful content
 * once the user actually starts a call, so paying the LiveKit cost
 * to even define it on boot would be wasteful.
 */
export const CallModal = React.lazy(() =>
  import('./CallModal').then((m) => ({ default: m.CallModal })),
);


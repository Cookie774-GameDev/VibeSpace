/**
 * Bridge module — cloud<->desktop tool dispatch over WebSocket.
 *
 * Re-exports BridgeClient + the singleton accessor + the lifecycle hook.
 * Used by:
 * - features/call: mounts the bridge once the user signs into Supabase
 * - features/settings/sections/PhoneVoice: shows bridge connection status
 * - lib/mcp/registry: indirectly, via the BridgeClient's toolCall handler
 */

export {
  BridgeClient,
  getBridgeClient,
  resetBridgeClient,
  type BridgeStatus,
  type BridgeFrame,
  type BridgeClientOptions,
} from './BridgeClient';

export { useBridgeLifecycle } from './useBridgeLifecycle';

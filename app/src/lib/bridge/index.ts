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
  getBrowserChatBridgeClient,
  getBridgeClient,
  getBridgeWorkspaceGrant,
  resetBridgeClient,
  resetBrowserChatBridgeClient,
  setBridgeWorkspaceGrant,
  type BridgeStatus,
  type BridgeFrame,
  type BridgeClientOptions,
  type BridgeWorkspaceGrant,
  type BridgeWorkspaceGrantMetadata,
} from './BridgeClient';

export { useBridgeLifecycle } from './useBridgeLifecycle';
export {
  requestBrowserChatRelayTicket,
  resolveBrowserChatCloudUrl,
  resolveBrowserChatMcpUrl,
  resolveBrowserChatRelayUrl,
  useBrowserChatRelay,
} from './useBrowserChatRelay';

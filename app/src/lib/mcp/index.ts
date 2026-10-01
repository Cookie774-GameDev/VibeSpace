/**
 * @file MCP-lite barrel.
 *
 * Importing from this entry point is the canonical way for the rest of the
 * app to consume the tool registry. The side-effect import of `./builtins`
 * guarantees built-in tools (`fs.read`, `shell.run`, ...) are registered by
 * the time any consumer reads from the registry.
 *
 * Consumers that want a clean registry (e.g. unit tests) should import
 * `./registry` directly instead.
 */

import './builtins';

export type { ToolDef } from './registry';
export { toolRegistry } from './registry';
export {
  createMcpSdkClientAdapter,
  fingerprintMcpSdkCatalog,
  type McpSdkCatalog,
  type McpSdkClientAdapter,
  type McpSdkClientAdapterOptions,
  type McpSdkPromptDescriptor,
  type McpSdkResourceDescriptor,
  type McpSdkToolClassification,
  type McpSdkToolDescriptor,
} from './mcpSdkClientAdapter';
export {
  createVibeSpaceMcpGateway,
  getVibeSpaceMcpGateway,
  vibeSpaceMcpGateway,
  type VibeSpaceGatewayConnection,
  type VibeSpaceMcpGateway,
  type VibeSpaceMcpInvocationClassification,
  type VibeSpaceMcpInvocationReceipt,
  type VibeSpaceMcpInvocationRequest,
  type VibeSpaceMcpInvocationResult,
} from './vibeSpaceGateway';
